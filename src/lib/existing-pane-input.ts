import { MAX_CONCERN_PANE_INPUT_BYTES } from '@shared/concern-os-contract'

const encoder = new TextEncoder()
export const EXISTING_PANE_INPUT_BATCH_MS = 16

export type ExistingPaneInputEligibility = {
  viewState: 'loading' | 'historical' | 'live' | 'ended' | 'error'
  paneFocused: boolean
  browserFocused: boolean
  terminalFocused: boolean
  hidden: boolean
}

export function canSendExistingPaneInput(input: ExistingPaneInputEligibility): boolean {
  return input.viewState === 'live'
    && input.paneFocused
    && input.browserFocused
    && input.terminalFocused
    && !input.hidden
}

/**
 * Split only on Unicode code-point boundaries. Each returned string therefore
 * encodes independently as valid UTF-8 and never exceeds the server limit.
 */
export function splitExistingPaneInput(
  data: string,
  maxBytes = MAX_CONCERN_PANE_INPUT_BYTES,
): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
    throw new Error('Existing-pane input chunks must allow one UTF-8 code point.')
  }
  if (!data) return []

  const chunks: string[] = []
  let chunk = ''
  let chunkBytes = 0

  for (const codePoint of data) {
    const bytes = encoder.encode(codePoint).byteLength
    if (chunk && chunkBytes + bytes > maxBytes) {
      chunks.push(chunk)
      chunk = ''
      chunkBytes = 0
    }
    chunk += codePoint
    chunkBytes += bytes
  }
  if (chunk) chunks.push(chunk)
  return chunks
}

export type ExistingPaneInputBatcher = {
  enqueue: (data: string) => void
  flush: () => Promise<void>
  dispose: () => void
}

/**
 * Coalesce ordinary key events for one animation-frame-sized interval.
 * Control keys flush immediately. At most one request is in flight; bytes
 * arriving behind it are coalesced into bounded UTF-8-safe successor chunks.
 */
export function createExistingPaneInputBatcher(
  send: (data: string) => Promise<void>,
  onError: (error: unknown) => void,
  batchMs = EXISTING_PANE_INPUT_BATCH_MS,
): ExistingPaneInputBatcher {
  type PendingChunk = { data: string; bytes: number }
  let pending: PendingChunk[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  const idleWaiters = new Set<() => void>()
  let disposed = false
  let failed = false

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  const settleIdleWaiters = () => {
    if (inFlight || pending.length > 0 || timer) return
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }

  const fail = (error: unknown) => {
    clearTimer()
    pending = []
    const shouldReport = !failed && !disposed
    failed = true
    if (shouldReport) onError(error)
    settleIdleWaiters()
  }

  const drain = () => {
    clearTimer()
    if (disposed || failed || inFlight) {
      settleIdleWaiters()
      return
    }
    const next = pending.shift()
    if (!next) {
      settleIdleWaiters()
      return
    }

    inFlight = true
    void Promise.resolve()
      .then(() => send(next.data))
      .then(() => {
        inFlight = false
        if (disposed || failed) pending = []
        drain()
      })
      .catch((error) => {
        inFlight = false
        fail(error)
      })
  }

  const append = (codePoint: string) => {
    const bytes = encoder.encode(codePoint).byteLength
    const tail = pending.at(-1)
    if (!tail || tail.bytes + bytes > MAX_CONCERN_PANE_INPUT_BYTES) {
      pending.push({ data: codePoint, bytes })
    } else {
      tail.data += codePoint
      tail.bytes += bytes
    }
  }

  return {
    enqueue(data) {
      if (!data || disposed || failed) return
      let containsControl = false
      for (const codePoint of data) {
        append(codePoint)
        const value = codePoint.codePointAt(0) ?? 0
        containsControl ||= value < 0x20 || value === 0x7f
      }

      // While a request is unresolved, leave newly ordered bytes in bounded
      // successor chunks. The completion path drains them immediately, so
      // network latency creates at most one coalesced backlog rather than one
      // queued request per animation frame.
      if (inFlight) return
      if (
        containsControl
        || pending.length > 1
        || pending[0]?.bytes === MAX_CONCERN_PANE_INPUT_BYTES
      ) {
        drain()
      } else if (!timer) {
        timer = setTimeout(drain, batchMs)
      }
    },
    async flush() {
      drain()
      if (!inFlight && pending.length === 0) return
      await new Promise<void>((resolve) => {
        idleWaiters.add(resolve)
      })
    },
    dispose() {
      disposed = true
      clearTimer()
      pending = []
      settleIdleWaiters()
    },
  }
}

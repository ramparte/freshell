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
 * Control keys flush immediately. Delivery remains a single serial promise
 * chain, so batching reduces HTTP/tmux round trips without reordering bytes.
 */
export function createExistingPaneInputBatcher(
  send: (data: string) => Promise<void>,
  onError: (error: unknown) => void,
  batchMs = EXISTING_PANE_INPUT_BATCH_MS,
): ExistingPaneInputBatcher {
  let pending = ''
  let pendingBytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue = Promise.resolve()
  let disposed = false
  let failed = false

  const submit = (chunk: string) => {
    if (!chunk || disposed || failed) return
    queue = queue.then(() => send(chunk)).catch((error) => {
      if (!failed && !disposed) onError(error)
      failed = true
    })
  }

  const flushPending = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const chunk = pending
    pending = ''
    pendingBytes = 0
    submit(chunk)
  }

  const schedule = (immediate: boolean) => {
    if (immediate) {
      flushPending()
    } else if (!timer) {
      timer = setTimeout(flushPending, batchMs)
    }
  }

  return {
    enqueue(data) {
      if (!data || disposed || failed) return
      let containsControl = false
      for (const codePoint of data) {
        const bytes = encoder.encode(codePoint).byteLength
        if (pending && pendingBytes + bytes > MAX_CONCERN_PANE_INPUT_BYTES) {
          flushPending()
        }
        pending += codePoint
        pendingBytes += bytes
        const value = codePoint.codePointAt(0) ?? 0
        containsControl ||= value < 0x20 || value === 0x7f
      }
      schedule(containsControl || pendingBytes >= MAX_CONCERN_PANE_INPUT_BYTES)
    },
    async flush() {
      flushPending()
      await queue
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      pending = ''
      pendingBytes = 0
    },
  }
}

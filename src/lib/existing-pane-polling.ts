export type AdaptiveExistingPanePoller = {
  start: () => void
  wakeAfterInput: () => void
  refreshActivity: () => void
  stop: () => void
}

export type AdaptiveExistingPanePollerOptions = {
  poll: () => Promise<void>
  isInteractive: () => boolean
  onError: (error: unknown) => void
  focusedPollMs: number
  backgroundPollMs: number
  fastPollMs: number
  fastBurstMs: number
  now?: () => number
}

/**
 * Schedule complete pane snapshots without overlapping requests. Accepted
 * interactive input wakes a sleeping poll immediately and starts a bounded
 * fast-poll window. More input extends that window but never adds another
 * timer or another in-flight request.
 */
export function createAdaptiveExistingPanePoller({
  poll,
  isInteractive,
  onError,
  focusedPollMs,
  backgroundPollMs,
  fastPollMs,
  fastBurstMs,
  now = Date.now,
}: AdaptiveExistingPanePollerOptions): AdaptiveExistingPanePoller {
  let running = false
  let inFlight = false
  let wakeAfterFlight = false
  let fastUntil = 0
  let lastPollStartedAt: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let timerDueAt: number | undefined

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    timerDueAt = undefined
  }

  const nextDelay = () => {
    if (!isInteractive()) return backgroundPollMs
    return now() < fastUntil ? fastPollMs : focusedPollMs
  }

  const schedule = (
    delayMs: number,
    policy: 'if-empty' | 'earlier' | 'replace' = 'if-empty',
  ) => {
    if (!running) return
    const dueAt = now() + delayMs
    if (timer !== undefined) {
      if (policy === 'if-empty') return
      if (policy === 'earlier' && timerDueAt !== undefined && timerDueAt <= dueAt) return
      clearTimer()
    }
    timer = setTimeout(run, delayMs)
    timerDueAt = dueAt
  }

  const fastWakeDelay = () => {
    if (lastPollStartedAt === undefined) return 0
    return Math.max(0, fastPollMs - (now() - lastPollStartedAt))
  }

  const fail = (error: unknown) => {
    running = false
    inFlight = false
    wakeAfterFlight = false
    clearTimer()
    onError(error)
  }

  const run = () => {
    timer = undefined
    timerDueAt = undefined
    if (!running || inFlight) return
    inFlight = true
    lastPollStartedAt = now()

    void Promise.resolve()
      .then(poll)
      .then(() => {
        inFlight = false
        if (!running) return
        if (wakeAfterFlight && isInteractive()) {
          wakeAfterFlight = false
          schedule(fastWakeDelay())
          return
        }
        wakeAfterFlight = false
        schedule(nextDelay())
      })
      .catch((error) => {
        if (running) fail(error)
      })
  }

  return {
    start() {
      if (running) return
      running = true
      schedule(0)
    },
    wakeAfterInput() {
      if (!running || !isInteractive()) return
      fastUntil = Math.max(fastUntil, now() + fastBurstMs)
      if (inFlight) {
        wakeAfterFlight = true
        return
      }
      schedule(fastWakeDelay(), 'earlier')
    },
    refreshActivity() {
      if (!running || inFlight) return
      schedule(nextDelay(), 'replace')
    },
    stop() {
      running = false
      wakeAfterFlight = false
      clearTimer()
    },
  }
}
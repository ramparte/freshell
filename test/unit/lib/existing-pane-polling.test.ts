import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdaptiveExistingPanePoller } from '../../../src/lib/existing-pane-polling'
import { createExistingPaneInputBatcher } from '../../../src/lib/existing-pane-input'

const timing = {
  focusedPollMs: 250,
  backgroundPollMs: 750,
  fastPollMs: 50,
  fastBurstMs: 800,
}

async function settleTimers(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await Promise.resolve()
}

describe('adaptive existing-pane polling', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('wakes an idle focused poll immediately after accepted input', async () => {
    vi.useFakeTimers()
    const poll = vi.fn(async () => undefined)
    const poller = createAdaptiveExistingPanePoller({
      poll,
      isInteractive: () => true,
      onError: vi.fn(),
      ...timing,
    })

    poller.start()
    await settleTimers()
    expect(poll).toHaveBeenCalledTimes(1)

    await settleTimers(100)
    poller.wakeAfterInput()
    await settleTimers()
    expect(poll).toHaveBeenCalledTimes(2)

    await settleTimers(49)
    expect(poll).toHaveBeenCalledTimes(2)
    await settleTimers(1)
    expect(poll).toHaveBeenCalledTimes(3)
    poller.stop()
  })

  it('extends the fast-poll burst from the most recent input without timer backlog', async () => {
    vi.useFakeTimers()
    const poll = vi.fn(async () => undefined)
    const poller = createAdaptiveExistingPanePoller({
      poll,
      isInteractive: () => true,
      onError: vi.fn(),
      ...timing,
    })

    poller.start()
    await settleTimers()
    await settleTimers(100)
    poller.wakeAfterInput()
    await settleTimers()

    await settleTimers(700)
    const callsBeforeExtension = poll.mock.calls.length
    poller.wakeAfterInput()
    poller.wakeAfterInput()
    await settleTimers()
    expect(poll.mock.calls.length).toBeLessThanOrEqual(callsBeforeExtension + 1)

    await settleTimers(750)
    const callsAtExtendedBoundary = poll.mock.calls.length
    await settleTimers(50)
    expect(poll).toHaveBeenCalledTimes(callsAtExtendedBoundary + 1)
    poller.stop()
  })

  it('bounds sustained mocked typing captures to the 50 ms fast cadence', async () => {
    vi.useFakeTimers()
    const poll = vi.fn(async () => undefined)
    const poller = createAdaptiveExistingPanePoller({
      poll,
      isInteractive: () => true,
      onError: vi.fn(),
      ...timing,
    })

    poller.start()
    await settleTimers()
    for (let elapsed = 0; elapsed < 60_000; elapsed += 10) {
      poller.wakeAfterInput()
      await settleTimers(10)
    }

    // One initial capture plus exactly 20 fast captures per second. The mock
    // wakes 100 times/second to prove repeated input cannot increase that rate.
    expect(poll).toHaveBeenCalledTimes(1_201)
    poller.stop()
  })

  it('keeps the mocked 25 keys/second request budget below the dedicated limiter', async () => {
    vi.useFakeTimers()
    const capture = vi.fn(async () => undefined)
    const sendInput = vi.fn(async () => undefined)
    const poller = createAdaptiveExistingPanePoller({
      poll: capture,
      isInteractive: () => true,
      onError: vi.fn(),
      ...timing,
    })
    const batcher = createExistingPaneInputBatcher(sendInput, vi.fn())

    poller.start()
    await settleTimers()
    for (let elapsed = 0; elapsed < 60_000; elapsed += 40) {
      batcher.enqueue('x')
      poller.wakeAfterInput()
      await settleTimers(40)
    }
    await batcher.flush()

    expect(capture).toHaveBeenCalledTimes(1_201)
    expect(sendInput).toHaveBeenCalledTimes(1_500)
    expect(capture.mock.calls.length + sendInput.mock.calls.length).toBe(2_701)
    expect(capture.mock.calls.length + sendInput.mock.calls.length).toBeLessThan(4_800)
    batcher.dispose()
    poller.stop()
  })

  it('never starts a second capture while one is in flight', async () => {
    vi.useFakeTimers()
    let releaseFirst!: () => void
    const firstCapture = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const poll = vi.fn()
      .mockImplementationOnce(async () => firstCapture)
      .mockResolvedValue(undefined)
    const poller = createAdaptiveExistingPanePoller({
      poll,
      isInteractive: () => true,
      onError: vi.fn(),
      ...timing,
    })

    poller.start()
    await settleTimers()
    expect(poll).toHaveBeenCalledTimes(1)

    poller.wakeAfterInput()
    poller.wakeAfterInput()
    await settleTimers(2_000)
    expect(poll).toHaveBeenCalledTimes(1)

    releaseFirst()
    await Promise.resolve()
    await settleTimers()
    expect(poll).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('returns to the ordinary focused cadence after the bounded fast burst', async () => {
    vi.useFakeTimers()
    const poll = vi.fn(async () => undefined)
    const poller = createAdaptiveExistingPanePoller({
      poll,
      isInteractive: () => true,
      onError: vi.fn(),
      ...timing,
    })

    poller.start()
    await settleTimers()
    await settleTimers(100)
    poller.wakeAfterInput()
    await settleTimers()
    await settleTimers(800)
    const callsAtBurstEnd = poll.mock.calls.length

    await settleTimers(249)
    expect(poll).toHaveBeenCalledTimes(callsAtBurstEnd)
    await settleTimers(1)
    expect(poll).toHaveBeenCalledTimes(callsAtBurstEnd + 1)
    poller.stop()
  })

  it('keeps hidden or unfocused panes on the background cadence and ignores input wakes', async () => {
    vi.useFakeTimers()
    const poll = vi.fn(async () => undefined)
    const poller = createAdaptiveExistingPanePoller({
      poll,
      isInteractive: () => false,
      onError: vi.fn(),
      ...timing,
    })

    poller.start()
    await settleTimers()
    expect(poll).toHaveBeenCalledTimes(1)

    poller.wakeAfterInput()
    await settleTimers(749)
    expect(poll).toHaveBeenCalledTimes(1)
    await settleTimers(1)
    expect(poll).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('cancels timers and suppresses post-capture scheduling after cleanup', async () => {
    vi.useFakeTimers()
    let releaseCapture!: () => void
    const capture = new Promise<void>((resolve) => {
      releaseCapture = resolve
    })
    const poll = vi.fn(async () => capture)
    const poller = createAdaptiveExistingPanePoller({
      poll,
      isInteractive: () => true,
      onError: vi.fn(),
      ...timing,
    })

    poller.start()
    await settleTimers()
    expect(poll).toHaveBeenCalledTimes(1)

    poller.wakeAfterInput()
    poller.stop()
    releaseCapture()
    await Promise.resolve()
    await settleTimers(5_000)
    expect(poll).toHaveBeenCalledTimes(1)
  })
})
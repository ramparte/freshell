import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  keyHandler: undefined as ((event: { key: string; domEvent: { isTrusted: boolean } }) => void) | undefined,
  terminalWrite: vi.fn(),
  inputEnqueue: vi.fn(),
  inputDispose: vi.fn(),
  pollerStart: vi.fn(),
  pollerWake: vi.fn(),
  pollerRefresh: vi.fn(),
  pollerStop: vi.fn(),
  poll: undefined as (() => Promise<void>) | undefined,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    onKey: vi.fn((handler) => {
      mocks.keyHandler = handler
      return { dispose: vi.fn() }
    }),
    dispose: vi.fn(),
    reset: vi.fn(),
    write: mocks.terminalWrite,
    options: { disableStdin: true },
  })),
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
  })),
}))

vi.mock('@/lib/concern-os-sessions', () => ({
  fetchConcernSession: vi.fn().mockResolvedValue({}),
  routeAmplifierSession: vi.fn(() => 'live'),
  fetchConcernPaneSnapshot: vi.fn().mockResolvedValue({
    input_enabled: true,
    next_input_sequence: 1,
    input_lease: 'lease',
    pane_id: '%1',
    data: 'server snapshot',
  }),
  sendConcernPaneInput: vi.fn(),
}))

vi.mock('@/lib/existing-pane-input', () => ({
  canSendExistingPaneInput: vi.fn(() => true),
  createExistingPaneInputBatcher: vi.fn(() => ({
    enqueue: mocks.inputEnqueue,
    flush: vi.fn(),
    dispose: mocks.inputDispose,
  })),
}))

vi.mock('@/lib/existing-pane-polling', () => ({
  createAdaptiveExistingPanePoller: vi.fn((options: { poll: () => Promise<void> }) => {
    mocks.poll = options.poll
    return {
      start: mocks.pollerStart.mockImplementation(() => {
        void options.poll()
      }),
      wakeAfterInput: mocks.pollerWake,
      refreshActivity: mocks.pollerRefresh,
      stop: mocks.pollerStop,
    }
  }),
}))

import { ExistingPaneView } from '@/components/ExistingPaneView'

describe('ExistingPaneView adaptive polling integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.keyHandler = undefined
    mocks.poll = undefined
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('wakes capture only for trusted accepted input and never synthesizes local echo', async () => {
    const view = render(
      <ExistingPaneView sessionId="session-1" focused={true} hidden={false} />,
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.pollerStart).toHaveBeenCalledTimes(1)
    expect(mocks.terminalWrite).toHaveBeenCalledWith('server snapshot')
    const writesBeforeInput = mocks.terminalWrite.mock.calls.length

    act(() => {
      mocks.keyHandler?.({ key: 'x', domEvent: { isTrusted: false } })
    })
    expect(mocks.inputEnqueue).not.toHaveBeenCalled()
    expect(mocks.pollerWake).not.toHaveBeenCalled()

    act(() => {
      mocks.keyHandler?.({ key: 'x', domEvent: { isTrusted: true } })
    })
    expect(mocks.inputEnqueue).toHaveBeenCalledWith('x')
    expect(mocks.pollerWake).toHaveBeenCalledTimes(1)
    expect(mocks.terminalWrite).toHaveBeenCalledTimes(writesBeforeInput)

    view.unmount()
    expect(mocks.pollerStop).toHaveBeenCalled()
    expect(mocks.inputDispose).toHaveBeenCalled()
  })
})
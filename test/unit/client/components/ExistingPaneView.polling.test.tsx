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
  controlMode: 'amplifier_bound' as 'amplifier_bound' | 'shell_continuation',
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
    get control_mode() {
      return mocks.controlMode
    },
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

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ExistingPaneView } from '@/components/ExistingPaneView'

describe('ExistingPaneView adaptive polling integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(Terminal).mockImplementation(() => ({
      loadAddon: vi.fn(),
      open: vi.fn(),
      onKey: vi.fn((handler) => {
        mocks.keyHandler = handler
        return { dispose: vi.fn() }
      }),
      attachCustomKeyEventHandler: vi.fn(),
      getSelection: vi.fn(() => ''),
      dispose: vi.fn(),
      reset: vi.fn(),
      write: mocks.terminalWrite,
      options: { disableStdin: true },
    }) as unknown as Terminal)
    vi.mocked(FitAddon).mockImplementation(() => ({
      fit: vi.fn(),
    }) as unknown as FitAddon)
    mocks.keyHandler = undefined
    mocks.poll = undefined
    mocks.controlMode = 'amplifier_bound'
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
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        focused={true}
        hidden={false}
        focusActivation={1}
      />,
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

    mocks.controlMode = 'shell_continuation'
    await act(async () => {
      await mocks.poll?.()
    })
    expect(view.getByText('shell · Amplifier exited')).toBeInTheDocument()
    act(() => {
      mocks.keyHandler?.({ key: 'y', domEvent: { isTrusted: true } })
    })
    expect(mocks.inputEnqueue).toHaveBeenCalledWith('y')

    view.unmount()
    expect(mocks.pollerStop).toHaveBeenCalled()
    expect(mocks.inputDispose).toHaveBeenCalled()
  })
})
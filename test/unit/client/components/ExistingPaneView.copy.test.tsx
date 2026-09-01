import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type KeyHandler = (event: { key: string; domEvent: KeyboardEvent }) => void
type CustomKeyHandler = (event: KeyboardEvent) => boolean
type InputSender = (chunk: string) => Promise<void>

const mocks = vi.hoisted(() => ({
  keyHandler: undefined as KeyHandler | undefined,
  customKeyHandler: undefined as CustomKeyHandler | undefined,
  selection: '',
  clipboardWrite: vi.fn<(text: string) => Promise<void>>(),
  execCommand: vi.fn<(command: string) => boolean>(),
  inputEnqueue: vi.fn<(data: string) => void>(),
  inputSend: undefined as InputSender | undefined,
  pollerStart: vi.fn(),
  pollerWake: vi.fn(),
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    onKey: vi.fn((handler: KeyHandler) => {
      mocks.keyHandler = handler
      return { dispose: vi.fn() }
    }),
    attachCustomKeyEventHandler: vi.fn((handler: CustomKeyHandler) => {
      mocks.customKeyHandler = handler
    }),
    getSelection: vi.fn(() => mocks.selection),
    dispose: vi.fn(),
    reset: vi.fn(),
    write: vi.fn(),
    options: { disableStdin: true },
  })),
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
  })),
}))

const sendConcernPaneInput = vi.hoisted(() => vi.fn(
  async (_sessionId: string, _lease: string, sequence: number) => ({
    sequence,
    control_mode: 'amplifier_bound',
  }),
))

vi.mock('@/lib/concern-os-sessions', () => ({
  fetchConcernSession: vi.fn().mockResolvedValue({}),
  routeAmplifierSession: vi.fn(() => 'live'),
  fetchConcernPaneSnapshot: vi.fn().mockResolvedValue({
    input_enabled: true,
    next_input_sequence: 1,
    input_lease: 'lease',
    pane_id: '%1',
    data: 'server snapshot',
    control_mode: 'amplifier_bound',
  }),
  sendConcernPaneInput,
}))

vi.mock('@/lib/existing-pane-input', () => ({
  canSendExistingPaneInput: vi.fn(() => true),
  createExistingPaneInputBatcher: vi.fn((send: InputSender) => {
    mocks.inputSend = send
    return {
      enqueue: mocks.inputEnqueue.mockImplementation((data: string) => {
        void send(data)
      }),
      flush: vi.fn(),
      dispose: vi.fn(),
    }
  }),
}))

vi.mock('@/lib/existing-pane-polling', () => ({
  createAdaptiveExistingPanePoller: vi.fn((options: { poll: () => Promise<void> }) => ({
    start: mocks.pollerStart.mockImplementation(() => {
      void options.poll()
    }),
    wakeAfterInput: mocks.pollerWake,
    refreshActivity: vi.fn(),
    stop: vi.fn(),
  })),
}))

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ExistingPaneView } from '@/components/ExistingPaneView'

function keyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    isTrusted: true,
    type: 'keydown',
    key: 'c',
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent
}

async function renderLiveView() {
  const view = render(
    <ExistingPaneView
      sessionId="session-1"
      tabId="tab-1"
      focused={true}
      hidden={false}
      focusActivation={0}
    />,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  await waitFor(() => expect(mocks.pollerStart).toHaveBeenCalledTimes(1))
  return view
}

describe('ExistingPaneView selection copy safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(Terminal).mockImplementation(() => ({
      loadAddon: vi.fn(),
      open: vi.fn(),
      onKey: vi.fn((handler) => {
        mocks.keyHandler = handler
        return { dispose: vi.fn() }
      }),
      attachCustomKeyEventHandler: vi.fn((handler) => {
        mocks.customKeyHandler = handler
      }),
      getSelection: vi.fn(() => mocks.selection),
      dispose: vi.fn(),
      reset: vi.fn(),
      write: vi.fn(),
      options: { disableStdin: true },
    }) as unknown as Terminal)
    vi.mocked(FitAddon).mockImplementation(() => ({
      fit: vi.fn(),
    }) as unknown as FitAddon)
    mocks.keyHandler = undefined
    mocks.customKeyHandler = undefined
    mocks.selection = ''
    mocks.inputSend = undefined
    mocks.clipboardWrite.mockResolvedValue(undefined)
    mocks.execCommand.mockReturnValue(false)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.clipboardWrite },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: mocks.execCommand,
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.mocked(document.hasFocus).mockRestore()
  })

  it.each([
    ['Ctrl-C', { ctrlKey: true, metaKey: false, shiftKey: false }],
    ['Ctrl-Shift-C', { ctrlKey: true, metaKey: false, shiftKey: true }],
    ['Command-C', { ctrlKey: false, metaKey: true, shiftKey: false }],
  ])('copies a selected multiline Unicode value for trusted %s', async (_label, modifiers) => {
    await renderLiveView()
    mocks.selection = 'first line\nλ second line\nemoji: 🐚'
    const event = keyEvent(modifiers)

    await act(async () => {
      expect(mocks.customKeyHandler?.(event)).toBe(false)
      await Promise.resolve()
    })

    expect(mocks.clipboardWrite).toHaveBeenCalledWith(mocks.selection)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
    expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1)
    expect(mocks.inputEnqueue).not.toHaveBeenCalled()
    expect(sendConcernPaneInput).not.toHaveBeenCalled()
    expect(mocks.pollerWake).not.toHaveBeenCalled()
  })

  it('uses the safe copy fallback when Clipboard API writing is unavailable', async () => {
    await renderLiveView()
    mocks.selection = 'fallback value'
    mocks.clipboardWrite.mockRejectedValueOnce(new Error('permission denied'))
    mocks.execCommand.mockReturnValueOnce(true)

    await act(async () => {
      expect(mocks.customKeyHandler?.(keyEvent())).toBe(false)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull()
    expect(mocks.inputEnqueue).not.toHaveBeenCalled()
    expect(mocks.pollerWake).not.toHaveBeenCalled()
  })

  it('shows a non-destructive error when all copy paths fail without sending SIGINT', async () => {
    const view = await renderLiveView()
    mocks.selection = 'must not become input'
    mocks.clipboardWrite.mockRejectedValueOnce(new Error('permission denied'))
    mocks.execCommand.mockReturnValueOnce(false)

    await act(async () => {
      expect(mocks.customKeyHandler?.(keyEvent())).toBe(false)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(view.getByRole('alert')).toHaveTextContent(
      'Unable to copy the terminal selection. No input was sent.',
    )
    expect(mocks.inputEnqueue).not.toHaveBeenCalled()
    expect(sendConcernPaneInput).not.toHaveBeenCalled()
    expect(mocks.pollerWake).not.toHaveBeenCalled()
  })

  it('retains normal Ctrl-C SIGINT behavior when there is no selection', async () => {
    await renderLiveView()
    const event = keyEvent()

    await act(async () => {
      expect(mocks.customKeyHandler?.(event)).toBe(true)
      mocks.keyHandler?.({ key: '\x03', domEvent: event })
      await Promise.resolve()
    })

    expect(mocks.clipboardWrite).not.toHaveBeenCalled()
    expect(mocks.inputEnqueue).toHaveBeenCalledWith('\x03')
    expect(sendConcernPaneInput).toHaveBeenCalledWith('session-1', 'lease', 1, '\x03')
    expect(mocks.pollerWake).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('does not copy, consume, enqueue, or wake for an untrusted copy event', async () => {
    await renderLiveView()
    mocks.selection = 'selected'
    const event = keyEvent({ isTrusted: false })

    act(() => {
      expect(mocks.customKeyHandler?.(event)).toBe(true)
      mocks.keyHandler?.({ key: '\x03', domEvent: event })
    })

    expect(mocks.clipboardWrite).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(mocks.inputEnqueue).not.toHaveBeenCalled()
    expect(sendConcernPaneInput).not.toHaveBeenCalled()
    expect(mocks.pollerWake).not.toHaveBeenCalled()
  })

  it('does not advance sequence or polling when copy is consumed', async () => {
    await renderLiveView()
    mocks.selection = 'selected'

    await act(async () => {
      expect(mocks.customKeyHandler?.(keyEvent())).toBe(false)
      await Promise.resolve()
    })
    mocks.selection = ''
    await act(async () => {
      const event = keyEvent({ key: 'x', ctrlKey: false })
      expect(mocks.customKeyHandler?.(event)).toBe(true)
      mocks.keyHandler?.({ key: 'x', domEvent: event })
      await Promise.resolve()
    })

    expect(sendConcernPaneInput).toHaveBeenCalledTimes(1)
    expect(sendConcernPaneInput).toHaveBeenCalledWith('session-1', 'lease', 1, 'x')
    expect(mocks.pollerWake).toHaveBeenCalledTimes(1)
  })
})
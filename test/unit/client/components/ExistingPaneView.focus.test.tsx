import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  route: 'live' as 'live' | 'historical' | 'ambiguous',
  terminalFocus: vi.fn(),
  terminalInput: undefined as HTMLTextAreaElement | undefined,
  pollerStart: vi.fn(),
}))

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }))

vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn() }))

vi.mock('@/lib/concern-os-sessions', () => ({
  fetchConcernSession: vi.fn().mockResolvedValue({}),
  routeAmplifierSession: vi.fn(() => mocks.route),
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
    enqueue: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  })),
}))

vi.mock('@/lib/existing-pane-polling', () => ({
  createAdaptiveExistingPanePoller: vi.fn((options: { poll: () => Promise<void> }) => ({
    start: mocks.pollerStart.mockImplementation(() => {
      void options.poll()
    }),
    wakeAfterInput: vi.fn(),
    refreshActivity: vi.fn(),
    stop: vi.fn(),
  })),
}))

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ExistingPaneView } from '@/components/ExistingPaneView'

async function settleLiveView() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  await waitFor(() => expect(mocks.pollerStart).toHaveBeenCalledTimes(1))
}

describe('ExistingPaneView automatic focus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.route = 'live'
    mocks.terminalInput = undefined
    vi.mocked(Terminal).mockImplementation(() => ({
      loadAddon: vi.fn(),
      open: vi.fn((host: HTMLElement) => {
        mocks.terminalInput = document.createElement('textarea')
        host.append(mocks.terminalInput)
      }),
      onKey: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
      focus: mocks.terminalFocus.mockImplementation(() => mocks.terminalInput?.focus()),
      reset: vi.fn(),
      write: vi.fn(),
      options: { disableStdin: true },
    }) as unknown as Terminal)
    vi.mocked(FitAddon).mockImplementation(() => ({
      fit: vi.fn(),
    }) as unknown as FitAddon)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.mocked(document.hasFocus).mockRestore()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('focuses xterm after a selected live sidebar session finishes rendering', async () => {
    const sidebarSession = document.createElement('button')
    sidebarSession.dataset.sessionId = 'session-1'
    document.body.append(sidebarSession)
    sidebarSession.focus()

    render(<ExistingPaneView sessionId="session-1" focused={true} hidden={false} />)
    await settleLiveView()

    await waitFor(() => expect(mocks.terminalFocus).toHaveBeenCalledTimes(1))
    expect(document.activeElement).toBe(mocks.terminalInput)
  })

  it('focuses xterm when switching back to an already-live existing pane', async () => {
    const view = render(
      <ExistingPaneView sessionId="session-1" focused={false} hidden={false} />,
    )
    await settleLiveView()
    expect(mocks.terminalFocus).not.toHaveBeenCalled()

    const tabButton = document.createElement('button')
    document.body.append(tabButton)
    tabButton.focus()
    view.rerender(
      <ExistingPaneView sessionId="session-1" focused={true} hidden={false} />,
    )

    await waitFor(() => expect(mocks.terminalFocus).toHaveBeenCalledTimes(1))
    expect(document.activeElement).toBe(mocks.terminalInput)
  })

  it.each([
    ['a search field', () => {
      const input = document.createElement('input')
      input.type = 'search'
      return input
    }],
    ['an open dialog', () => {
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      const button = document.createElement('button')
      dialog.append(button)
      document.body.append(dialog)
      return button
    }],
    ['an open menu', () => {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      const button = document.createElement('button')
      menu.append(button)
      document.body.append(menu)
      return button
    }],
  ])('does not steal focus from %s', async (_label, createFocusedElement) => {
    const focusedElement = createFocusedElement()
    if (!focusedElement.isConnected) document.body.append(focusedElement)
    focusedElement.focus()

    render(<ExistingPaneView sessionId="session-1" focused={true} hidden={false} />)
    await settleLiveView()

    expect(mocks.terminalFocus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(focusedElement)
  })

  it.each([
    ['an inactive pane', false, false],
    ['a hidden pane', true, true],
  ])('does not focus %s', async (_label, focused, hidden) => {
    render(
      <ExistingPaneView sessionId="session-1" focused={focused} hidden={hidden} />,
    )
    await settleLiveView()

    expect(mocks.terminalFocus).not.toHaveBeenCalled()
  })

  it('does not focus when the browser document is not focused', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false)

    render(<ExistingPaneView sessionId="session-1" focused={true} hidden={false} />)
    await settleLiveView()

    expect(mocks.terminalFocus).not.toHaveBeenCalled()
  })

  it('does not focus when the browser document is hidden', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })

    render(<ExistingPaneView sessionId="session-1" focused={true} hidden={false} />)
    await settleLiveView()

    expect(mocks.terminalFocus).not.toHaveBeenCalled()
  })

  it('does not make a historical read-only session a keyboard target', async () => {
    mocks.route = 'historical'

    render(<ExistingPaneView sessionId="session-1" focused={true} hidden={false} />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.pollerStart).not.toHaveBeenCalled()
    expect(mocks.terminalFocus).not.toHaveBeenCalled()
  })
})
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  route: 'live' as 'live' | 'historical' | 'ambiguous',
  inputEnabled: true,
  controlMode: 'amplifier_bound' as 'amplifier_bound' | 'shell_continuation',
  terminalFocus: vi.fn(),
  terminalInput: undefined as HTMLTextAreaElement | undefined,
  pollPane: undefined as (() => Promise<void>) | undefined,
  pollerStart: vi.fn(),
}))

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }))

vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn() }))

vi.mock('@/lib/concern-os-sessions', () => ({
  fetchConcernSession: vi.fn().mockResolvedValue({}),
  routeAmplifierSession: vi.fn(() => mocks.route),
  fetchConcernPaneSnapshot: vi.fn().mockResolvedValue({
    get input_enabled() {
      return mocks.inputEnabled
    },
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
    enqueue: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  })),
}))

vi.mock('@/lib/existing-pane-polling', () => ({
  createAdaptiveExistingPanePoller: vi.fn((options: { poll: () => Promise<void> }) => {
    mocks.pollPane = options.poll
    return {
      start: mocks.pollerStart.mockImplementation(() => {
        void options.poll().catch(() => undefined)
      }),
      wakeAfterInput: vi.fn(),
      refreshActivity: vi.fn(),
      stop: vi.fn(),
    }
  }),
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
    mocks.inputEnabled = true
    mocks.controlMode = 'amplifier_bound'
    mocks.terminalInput = undefined
    mocks.pollPane = undefined
    vi.mocked(Terminal).mockImplementation(() => ({
      loadAddon: vi.fn(),
      open: vi.fn((host: HTMLElement) => {
        mocks.terminalInput = document.createElement('textarea')
        host.append(mocks.terminalInput)
      }),
      onKey: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomKeyEventHandler: vi.fn(),
      getSelection: vi.fn(() => ''),
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

    render(
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        focused={true}
        hidden={false}
        focusActivation={1}
      />,
    )
    await settleLiveView()

    await waitFor(() => expect(mocks.terminalFocus).toHaveBeenCalledTimes(1))
    expect(document.activeElement).toBe(mocks.terminalInput)
  })

  it('shows shell continuation after a leased snapshot transition while input stays enabled', async () => {
    const view = render(
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        focused={true}
        hidden={false}
        focusActivation={0}
      />,
    )
    await settleLiveView()

    expect(view.getByText('tmux %1 · input only while focused')).toBeTruthy()
    expect(vi.mocked(Terminal).mock.results[0]?.value.options.disableStdin).toBe(false)

    mocks.controlMode = 'shell_continuation'
    await act(async () => {
      await mocks.pollPane?.()
    })

    expect(view.getByText('shell · Amplifier exited')).toBeTruthy()
    expect(vi.mocked(Terminal).mock.results[0]?.value.options.disableStdin).toBe(false)
  })

  it('focuses xterm when switching back to an already-live existing pane', async () => {
    const view = render(
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        focused={false}
        hidden={false}
        focusActivation={1}
      />,
    )
    await settleLiveView()
    expect(mocks.terminalFocus).not.toHaveBeenCalled()

    const tabButton = document.createElement('button')
    tabButton.dataset.tabId = 'tab-1'
    document.body.append(tabButton)
    tabButton.focus()
    view.rerender(
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        focused={true}
        hidden={false}
        focusActivation={2}
      />,
    )

    await waitFor(() => expect(mocks.terminalFocus).toHaveBeenCalledTimes(1))
    expect(document.activeElement).toBe(mocks.terminalInput)
  })

  it('does not refocus for polling or unrelated rerenders without a new activation', async () => {
    const sidebarSession = document.createElement('button')
    sidebarSession.dataset.sessionId = 'session-1'
    document.body.append(sidebarSession)
    sidebarSession.focus()

    const view = render(
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        title="before"
        focused={true}
        hidden={false}
        focusActivation={1}
      />,
    )
    await settleLiveView()
    await waitFor(() => expect(mocks.terminalFocus).toHaveBeenCalledTimes(1))

    view.rerender(
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        title="after"
        focused={true}
        hidden={false}
        focusActivation={1}
      />,
    )

    expect(mocks.terminalFocus).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a search field', () => {
      const input = document.createElement('input')
      input.type = 'search'
      return input
    }],
    ['a text field', () => document.createElement('textarea')],
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
    ['a toolbar control', () => {
      const toolbar = document.createElement('div')
      toolbar.setAttribute('role', 'toolbar')
      const button = document.createElement('button')
      toolbar.append(button)
      document.body.append(toolbar)
      return button
    }],
  ])('does not steal focus from %s', async (_label, createFocusedElement) => {
    const focusedElement = createFocusedElement()
    if (!focusedElement.isConnected) document.body.append(focusedElement)
    focusedElement.focus()

    render(
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        focused={true}
        hidden={false}
        focusActivation={1}
      />,
    )
    await settleLiveView()

    expect(mocks.terminalFocus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(focusedElement)
  })

  it.each([
    ['an inactive pane', false, false],
    ['a hidden pane', true, true],
  ])('does not focus %s', async (_label, focused, hidden) => {
    render(
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        focused={focused}
        hidden={hidden}
        focusActivation={1}
      />,
    )
    await settleLiveView()

    expect(mocks.terminalFocus).not.toHaveBeenCalled()
  })

  it('does not focus when the browser document is not focused', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false)

    render(
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        focused={true}
        hidden={false}
        focusActivation={1}
      />,
    )
    await settleLiveView()

    expect(mocks.terminalFocus).not.toHaveBeenCalled()
  })

  it('does not focus when the browser document is hidden', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })

    render(
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        focused={true}
        hidden={false}
        focusActivation={1}
      />,
    )
    await settleLiveView()

    expect(mocks.terminalFocus).not.toHaveBeenCalled()
  })

  it('does not make a historical read-only session a keyboard target', async () => {
    mocks.route = 'historical'

    render(
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

    expect(mocks.pollerStart).not.toHaveBeenCalled()
    expect(mocks.terminalFocus).not.toHaveBeenCalled()
  })

  it('consumes a blocked activation instead of focusing on a later rerender', async () => {
    const search = document.createElement('input')
    search.type = 'search'
    document.body.append(search)
    search.focus()

    const view = render(
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        title="before"
        focused={true}
        hidden={false}
        focusActivation={1}
      />,
    )
    await settleLiveView()
    expect(mocks.terminalFocus).not.toHaveBeenCalled()

    search.remove()
    view.rerender(
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        title="after"
        focused={true}
        hidden={false}
        focusActivation={1}
      />,
    )

    expect(mocks.terminalFocus).not.toHaveBeenCalled()
  })

  it('rechecks protected focus ownership in the animation frame', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })

    const sidebarSession = document.createElement('button')
    sidebarSession.dataset.sessionId = 'session-1'
    document.body.append(sidebarSession)
    sidebarSession.focus()

    render(
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        focused={true}
        hidden={false}
        focusActivation={1}
      />,
    )
    await settleLiveView()
    await waitFor(() => expect(frames).toHaveLength(1))

    const toolbar = document.createElement('div')
    toolbar.setAttribute('role', 'toolbar')
    const toolbarButton = document.createElement('button')
    toolbar.append(toolbarButton)
    document.body.append(toolbar)
    toolbarButton.focus()
    frames[0](0)

    expect(mocks.terminalFocus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(toolbarButton)
  })

  it('does not focus when the validated snapshot disables input', async () => {
    mocks.inputEnabled = false

    render(
      <ExistingPaneView
        sessionId="session-1"
        tabId="tab-1"
        focused={true}
        hidden={false}
        focusActivation={1}
      />,
    )
    await settleLiveView()

    expect(mocks.terminalFocus).not.toHaveBeenCalled()
  })
})
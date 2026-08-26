import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { AlertCircle, Eye, Loader2 } from 'lucide-react'
import {
  fetchConcernPaneSnapshot,
  fetchConcernSession,
  routeAmplifierSession,
  sendConcernPaneInput,
} from '@/lib/concern-os-sessions'
import {
  canSendExistingPaneInput,
  createExistingPaneInputBatcher,
  type ExistingPaneInputBatcher,
} from '@/lib/existing-pane-input'

type ViewState =
  | { kind: 'loading'; message: string }
  | { kind: 'historical'; message: string }
  | { kind: 'live'; paneId: string }
  | { kind: 'ended'; message: string }
  | { kind: 'error'; message: string }

export const EXISTING_PANE_FOCUSED_POLL_MS = 250
export const EXISTING_PANE_BACKGROUND_POLL_MS = 750

export function ExistingPaneView({
  sessionId,
  title,
  cwd,
  hidden,
  focused,
}: {
  sessionId: string
  title?: string
  cwd?: string
  hidden?: boolean
  focused: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal>()
  const inputHandlerRef = useRef<(data: string) => void>(() => undefined)
  const inputBatcherRef = useRef<ExistingPaneInputBatcher>()
  const inputLeaseRef = useRef<string>()
  const nextInputSequenceRef = useRef(1)
  const inputFailedRef = useRef(false)
  const activeSessionIdRef = useRef<string>()
  const stateKindRef = useRef<ViewState['kind']>('loading')
  const paneFocusedRef = useRef(focused)
  const hiddenRef = useRef(!!hidden)
  const browserFocusedRef = useRef(false)
  const [state, setState] = useState<ViewState>({
    kind: 'loading',
    message: 'Checking live tmux ownership…',
  })
  const [browserFocused, setBrowserFocused] = useState(() => (
    typeof document !== 'undefined'
      && document.visibilityState === 'visible'
      && document.hasFocus()
  ))

  stateKindRef.current = state.kind
  paneFocusedRef.current = focused
  hiddenRef.current = !!hidden
  browserFocusedRef.current = browserFocused

  inputHandlerRef.current = (data) => {
    const host = hostRef.current
    if (!canSendExistingPaneInput({
      viewState: stateKindRef.current,
      paneFocused: paneFocusedRef.current,
      browserFocused: browserFocusedRef.current,
      terminalFocused: !!host?.contains(document.activeElement),
      hidden: hiddenRef.current,
    })) {
      return
    }

    inputBatcherRef.current?.enqueue(data)
  }

  useEffect(() => {
    const updateBrowserFocus = () => {
      setBrowserFocused(document.visibilityState === 'visible' && document.hasFocus())
    }
    window.addEventListener('focus', updateBrowserFocus)
    window.addEventListener('blur', updateBrowserFocus)
    document.addEventListener('visibilitychange', updateBrowserFocus)
    updateBrowserFocus()
    return () => {
      window.removeEventListener('focus', updateBrowserFocus)
      window.removeEventListener('blur', updateBrowserFocus)
      document.removeEventListener('visibilitychange', updateBrowserFocus)
    }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      cursorBlink: false,
      convertEol: true,
      disableStdin: true,
      scrollback: 5_000,
      theme: {
        background: '#0b0d10',
        foreground: '#e5e7eb',
        cursor: '#e5e7eb',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    terminalRef.current = terminal
    // Deliberately do not subscribe to xterm's onData event. onData also
    // carries terminal-generated replies (focus reports, device-status
    // responses, mouse/wheel translations), which are not explicit user
    // input. onKey is tied to a real keyboard event, while paste is captured
    // directly from the trusted browser event below.
    const keySubscription = terminal.onKey(({ key, domEvent }) => {
      if (domEvent.isTrusted) inputHandlerRef.current(key)
    })
    const handlePaste = (event: ClipboardEvent) => {
      if (!event.isTrusted) return
      event.preventDefault()
      event.stopPropagation()
      const data = event.clipboardData?.getData('text/plain')
      if (data) inputHandlerRef.current(data)
    }
    host.addEventListener('paste', handlePaste, true)

    // Fitting changes only the browser renderer. Stage 1 deliberately never
    // sends terminal.resize or any tmux resize command.
    const fit = () => {
      try {
        fitAddon.fit()
      } catch {
        // The host can be temporarily hidden while tabs switch.
      }
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(host)

    return () => {
      observer.disconnect()
      host.removeEventListener('paste', handlePaste, true)
      keySubscription.dispose()
      terminal.dispose()
      terminalRef.current = undefined
    }
  }, [])

  useEffect(() => {
    if (!terminalRef.current) return
    terminalRef.current.options.disableStdin = !(
      state.kind === 'live'
      && focused
      && browserFocused
      && !hidden
      && !inputFailedRef.current
    )
  }, [browserFocused, focused, hidden, state.kind])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastData: string | undefined
    activeSessionIdRef.current = sessionId
    inputFailedRef.current = false
    inputLeaseRef.current = undefined
    nextInputSequenceRef.current = 1
    inputBatcherRef.current?.dispose()
    inputBatcherRef.current = createExistingPaneInputBatcher(
      async (chunk) => {
        const currentHost = hostRef.current
        if (!canSendExistingPaneInput({
          viewState: stateKindRef.current,
          paneFocused: paneFocusedRef.current,
          browserFocused: browserFocusedRef.current,
          terminalFocused: !!currentHost?.contains(document.activeElement),
          hidden: hiddenRef.current,
        })) {
          return
        }
        const lease = inputLeaseRef.current
        if (!lease || activeSessionIdRef.current !== sessionId) {
          throw new Error('The generation-bound tmux input lease is unavailable.')
        }
        const sequence = nextInputSequenceRef.current
        const response = await sendConcernPaneInput(sessionId, lease, sequence, chunk)
        if (response.sequence !== sequence) {
          throw new Error('Existing-pane input acknowledgement sequence changed.')
        }
        nextInputSequenceRef.current = sequence + 1
      },
      (error) => {
        if (activeSessionIdRef.current !== sessionId || inputFailedRef.current) return
        inputFailedRef.current = true
        if (terminalRef.current) terminalRef.current.options.disableStdin = true
        setState({
          kind: 'ended',
          message: error instanceof Error ? error.message : 'Existing tmux pane input failed.',
        })
      },
    )

    const pollPane = async () => {
      try {
        const snapshot = await fetchConcernPaneSnapshot(sessionId, inputLeaseRef.current)
        if (cancelled || inputFailedRef.current) return
        if (!snapshot.input_enabled) {
          throw new Error('Existing tmux pane input is not available.')
        }
        nextInputSequenceRef.current = Math.max(
          nextInputSequenceRef.current,
          snapshot.next_input_sequence,
        )
        inputLeaseRef.current = snapshot.input_lease
        // capture-pane returns a complete bounded snapshot. Replace the local
        // model only when it changes so polling cannot duplicate scrollback or
        // queue redundant full-screen writes.
        if (snapshot.data !== lastData) {
          lastData = snapshot.data
          terminalRef.current?.reset()
          terminalRef.current?.write(snapshot.data)
        }
        setState({ kind: 'live', paneId: snapshot.pane_id })
        const interactive = paneFocusedRef.current
          && browserFocusedRef.current
          && !hiddenRef.current
        timer = setTimeout(
          pollPane,
          interactive ? EXISTING_PANE_FOCUSED_POLL_MS : EXISTING_PANE_BACKGROUND_POLL_MS,
        )
      } catch (error) {
        if (!cancelled) {
          setState({
            kind: 'ended',
            message: error instanceof Error ? error.message : 'Existing tmux pane ended.',
          })
        }
      }
    }

    void fetchConcernSession(sessionId)
      .then((session) => {
        if (cancelled) return
        const route = routeAmplifierSession(session)
        if (route === 'live') {
          setState({ kind: 'loading', message: 'Opening generation-validated tmux pane…' })
          void pollPane()
        } else if (route === 'historical') {
          setState({
            kind: 'historical',
            message: 'This session is not running. Stage 1 keeps historical sessions read-only.',
          })
        } else {
          setState({
            kind: 'error',
            message: 'This session cannot be attached safely because its live identity is ambiguous.',
          })
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Unable to resolve session ownership.',
          })
        }
      })

    return () => {
      cancelled = true
      if (activeSessionIdRef.current === sessionId) {
        activeSessionIdRef.current = undefined
        inputFailedRef.current = true
      }
      inputLeaseRef.current = undefined
      inputBatcherRef.current?.dispose()
      inputBatcherRef.current = undefined
      if (timer) clearTimeout(timer)
    }
  }, [sessionId])

  const terminalVisible = state.kind === 'live' || state.kind === 'ended'

  return (
    <div
      className="relative h-full min-h-0 w-full overflow-hidden bg-[#0b0d10]"
      style={hidden ? { display: 'none' } : undefined}
      data-testid="existing-pane-view"
      data-session-id={sessionId}
    >
      <div
        ref={hostRef}
        className={terminalVisible ? 'h-full w-full p-2' : 'absolute h-px w-px overflow-hidden'}
        data-testid="existing-pane-terminal"
      />

      {state.kind === 'live' && (
        <div className="pointer-events-none absolute right-3 top-3 rounded bg-black/75 px-2 py-1 text-xs text-slate-300">
          tmux {state.paneId} · input only while focused
        </div>
      )}

      {state.kind !== 'live' && state.kind !== 'ended' && (
        <div className="absolute inset-0 flex items-center justify-center bg-background p-8">
          <div className="max-w-xl rounded-lg border bg-card p-6 text-center shadow-sm">
            {state.kind === 'loading'
              ? <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-muted-foreground" />
              : state.kind === 'historical'
                ? <Eye className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
                : <AlertCircle className="mx-auto mb-3 h-6 w-6 text-amber-500" />}
            <h2 className="font-medium">{title || 'Amplifier session'}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-left text-xs">
              <dt className="text-muted-foreground">Session</dt>
              <dd className="truncate font-mono">{sessionId}</dd>
              <dt className="text-muted-foreground">Working directory</dt>
              <dd className="truncate font-mono">{cwd || 'Unknown'}</dd>
            </dl>
            <p className="mt-4 text-xs text-muted-foreground">
              Freshell will not run amplifier resume or create a replacement terminal.
            </p>
          </div>
        </div>
      )}

      {state.kind === 'ended' && (
        <div
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded border border-amber-500/40 bg-black/90 px-4 py-2 text-sm text-amber-200"
          role="status"
          data-testid="existing-pane-ended"
        >
          {state.message} Reopen from the sidebar after Concern OS discovers its new state.
        </div>
      )}
    </div>
  )
}
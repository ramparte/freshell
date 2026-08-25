// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FRESHELL_TMUX_SOCKET,
  encodeTmuxHexBytes,
  ExistingPaneAdapter,
  ExistingPaneIdentityError,
  ExistingPaneInputError,
  processStartTicks,
  resolveTmuxSocketPath,
} from '../../../server/existing-pane-adapter.js'
import type { ConcernSession } from '../../../shared/concern-os-contract.js'

const TEST_TMUX_SOCKET = '/run/test-tmux/exact.sock'

const identity = {
  tmux_server_pid: 100,
  tmux_server_start_ticks: 10,
  pane_id: '%5' as const,
  pane_pid: 200,
  pane_start_ticks: 20,
  amplifier_pid: 201,
  amplifier_start_ticks: 30,
}

const liveSession: ConcernSession = {
  id: 'amplifier:session-1',
  session_id: 'session-1',
  provider: 'amplifier',
  historical: true,
  live: true,
  status: 'live',
  working_dir: '/work',
  created: '2026-08-24T00:00:00Z',
  last_activity_at: 1,
  attachment: {
    state: 'resolvable',
    pane_id: '%5',
    live_identity: identity,
  },
}

function statWithStartTicks(pid: number, ticks: number): string {
  return `${pid} (process ${pid}) ${['S', ...Array(18).fill('0'), String(ticks)].join(' ')}`
}

function validStarts(pid: number): string {
  const starts = new Map([[100, 10], [200, 20], [201, 30]])
  return statWithStartTicks(pid, starts.get(pid) ?? -1)
}

function defaultExec() {
  return vi.fn(async (_file: string, args: readonly string[]) => {
    if (args[2] === 'display-message') return { stdout: '%5|200|100\n' }
    if (args[2] === 'capture-pane') return { stdout: 'existing pane output\n' }
    return { stdout: '' }
  })
}

function inputTransactions(exec: ReturnType<typeof defaultExec>) {
  return exec.mock.calls.filter((call) => call[1][2] === 'if-shell')
}

function createAdapter(
  exec: ReturnType<typeof defaultExec>,
  readProcessStat: (pid: number) => Promise<string> = async (pid) => validStarts(pid),
) {
  return new ExistingPaneAdapter({
    exec,
    readProcessStat,
    tmuxSocketPath: TEST_TMUX_SOCKET,
  })
}

describe('ExistingPaneAdapter', () => {
  it('captures only the exact generation-validated pane and advertises the next input sequence', async () => {
    const exec = defaultExec()
    const adapter = createAdapter(exec)

    await expect(adapter.capture(liveSession)).resolves.toEqual({
      ok: true,
      pane_id: '%5',
      data: 'existing pane output\n',
      input_enabled: true,
      next_input_sequence: 1,
    })
    expect(exec).toHaveBeenCalledTimes(3)
    expect(exec.mock.calls[1]?.[1]).toEqual([
      '-S',
      TEST_TMUX_SOCKET,
      'capture-pane',
      '-p',
      '-e',
      '-J',
      '-t',
      '%5',
      '-S',
      '-5000',
    ])
    expect(exec.mock.calls.every((call) => (
      call[0] === 'tmux'
      && call[1][0] === '-S'
      && call[1][1] === TEST_TMUX_SOCKET
    ))).toBe(true)
    expect(exec.mock.calls[0]?.[1][6]).toBe('#{pane_id}|#{pane_pid}|#{pid}')
    expect(inputTransactions(exec)).toHaveLength(0)
  })

  it('uses a printable identity delimiter that older tmux clients do not normalize', async () => {
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[2] === 'display-message') {
        const normalizedFormat = (args[6] ?? '').replace(/[\x00-\x20\x7f]/g, '_')
        return {
          stdout: `${normalizedFormat
            .replace('#{pane_id}', '%5')
            .replace('#{pane_pid}', '200')
            .replace('#{pid}', '100')}\n`,
        }
      }
      if (args[2] === 'capture-pane') return { stdout: 'existing pane output\n' }
      return { stdout: '' }
    })
    const adapter = createAdapter(exec)

    await expect(adapter.capture(liveSession)).resolves.toMatchObject({
      ok: true,
      pane_id: '%5',
    })
    expect(exec.mock.calls[0]?.[1][6]).toBe('#{pane_id}|#{pane_pid}|#{pid}')
  })

  it('encodes valid UTF-8 and control input as literal hex byte arguments without a shell', async () => {
    const exec = defaultExec()
    const adapter = createAdapter(exec)

    await expect(adapter.sendInput(
      liveSession,
      { sequence: 1, data: 'é\u0003\r' },
      async () => structuredClone(liveSession),
    )).resolves.toEqual({ ok: true, pane_id: '%5', sequence: 1 })

    expect(encodeTmuxHexBytes('é\u0003\r')).toEqual(['c3', 'a9', '03', '0d'])
    expect(inputTransactions(exec)).toHaveLength(1)
    expect(inputTransactions(exec)[0]?.[0]).toBe('tmux')
    expect(inputTransactions(exec)[0]?.[1]).toEqual([
      '-S',
      TEST_TMUX_SOCKET,
      'if-shell',
      '-F',
      '-t',
      '%5',
      '#{&&:#{==:#{pane_id},%5},#{&&:#{==:#{pane_pid},200},#{==:#{pid},100}}}',
      'send-keys -H -t %5 c3 a9 03 0d',
      'display-message -p -t %5 __FRESHELL_TMUX_IDENTITY_MISMATCH__',
    ])
    expect(exec.mock.calls.every((call) => call[0] === 'tmux')).toBe(true)
    const serializedCalls = JSON.stringify(exec.mock.calls)
    expect(serializedCalls).not.toMatch(
      /resize-pane|respawn-pane|new-session|new-window|split-window|run-shell|kill-pane/,
    )
  })

  it('serializes input FIFO per exact pane', async () => {
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[2] === 'if-shell' && args[7]?.endsWith(' 61')) {
        markFirstStarted()
        await firstBlocked
      }
      return { stdout: '' }
    })
    const adapter = createAdapter(exec)

    const first = adapter.sendInput(liveSession, { sequence: 1, data: 'a' }, async () => liveSession)
    const second = adapter.sendInput(liveSession, { sequence: 2, data: 'b' }, async () => liveSession)

    await firstStarted
    expect(inputTransactions(exec)).toHaveLength(1)
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, pane_id: '%5', sequence: 1 },
      { ok: true, pane_id: '%5', sequence: 2 },
    ])
    expect(inputTransactions(exec).map((call) => call[1][7])).toEqual([
      'send-keys -H -t %5 61',
      'send-keys -H -t %5 62',
    ])
  })

  it('rejects duplicate and out-of-order sequences without poisoning the next expected input', async () => {
    const exec = defaultExec()
    const adapter = createAdapter(exec)
    const resolveCurrent = async () => liveSession

    await adapter.sendInput(liveSession, { sequence: 1, data: 'a' }, resolveCurrent)
    await expect(adapter.sendInput(
      liveSession,
      { sequence: 1, data: 'duplicate' },
      resolveCurrent,
    )).rejects.toBeInstanceOf(ExistingPaneInputError)
    await expect(adapter.sendInput(
      liveSession,
      { sequence: 3, data: 'out-of-order' },
      resolveCurrent,
    )).rejects.toBeInstanceOf(ExistingPaneInputError)
    await expect(adapter.sendInput(
      liveSession,
      { sequence: 2, data: 'b' },
      resolveCurrent,
    )).resolves.toMatchObject({ sequence: 2 })

    expect(inputTransactions(exec).map((call) => call[1][7])).toEqual([
      'send-keys -H -t %5 61',
      'send-keys -H -t %5 62',
    ])
  })

  it('fails closed before input when a recorded process generation is stale', async () => {
    const exec = defaultExec()
    const adapter = createAdapter(
      exec,
      async (pid) => statWithStartTicks(pid, pid === 201 ? 31 : pid / 10),
    )

    await expect(adapter.sendInput(
      liveSession,
      { sequence: 1, data: 'never sent' },
      async () => liveSession,
    )).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    expect(inputTransactions(exec)).toHaveLength(0)
  })

  it('fails closed on a tmux identity race and does not advance the input sequence', async () => {
    let transactionCount = 0
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[2] === 'if-shell') {
        transactionCount += 1
        return {
          stdout: transactionCount === 1
            ? '__FRESHELL_TMUX_IDENTITY_MISMATCH__\n'
            : '',
        }
      }
      return { stdout: '' }
    })
    const adapter = createAdapter(exec)
    const resolveCurrent = async () => liveSession

    await expect(adapter.sendInput(
      liveSession,
      { sequence: 1, data: 'not delivered' },
      resolveCurrent,
    )).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    await expect(adapter.sendInput(
      liveSession,
      { sequence: 1, data: 'retry' },
      resolveCurrent,
    )).resolves.toEqual({ ok: true, pane_id: '%5', sequence: 1 })

    expect(inputTransactions(exec)).toHaveLength(2)
    expect(inputTransactions(exec).every((call) => (
      call[1][0] === '-S'
      && call[1][1] === TEST_TMUX_SOCKET
      && call[1][2] === 'if-shell'
      && call[1][5] === '%5'
      && call[1][6]?.includes('#{==:#{pane_pid},200}')
    ))).toBe(true)
  })

  it('checks all proc generations immediately before the single tmux input transaction', async () => {
    const events: string[] = []
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      events.push(`tmux:${args[2]}`)
      return { stdout: '' }
    })
    const adapter = createAdapter(exec, async (pid) => {
      events.push(`proc:${pid}`)
      return validStarts(pid)
    })

    await adapter.sendInput(
      liveSession,
      { sequence: 1, data: 'x' },
      async () => liveSession,
    )

    expect(events).toEqual([
      'proc:100',
      'proc:200',
      'proc:201',
      'tmux:if-shell',
    ])
    expect(inputTransactions(exec)).toHaveLength(1)
  })

  it('fails closed if Concern OS changes the mapping while input waits', async () => {
    const exec = defaultExec()
    const adapter = createAdapter(exec)
    const changed = structuredClone(liveSession)
    if (changed.attachment?.state === 'resolvable') {
      changed.attachment.live_identity.pane_start_ticks += 1
    }

    await expect(adapter.sendInput(
      liveSession,
      { sequence: 1, data: 'never sent' },
      async () => changed,
    )).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    expect(inputTransactions(exec)).toHaveLength(0)
  })

  it('rejects ended sessions and oversized chunks without input or pane lifecycle commands', async () => {
    const exec = defaultExec()
    const adapter = createAdapter(exec)
    const endedSession: ConcernSession = {
      ...liveSession,
      live: false,
      status: 'ended',
      attachment: undefined,
    }

    await expect(adapter.sendInput(
      endedSession,
      { sequence: 1, data: 'never sent' },
      async () => endedSession,
    )).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    await expect(adapter.sendInput(
      liveSession,
      { sequence: 1, data: 'x'.repeat(513) },
      async () => liveSession,
    )).rejects.toBeInstanceOf(ExistingPaneInputError)

    expect(inputTransactions(exec)).toHaveLength(0)
    expect(exec.mock.calls.flatMap((call) => call[1])).not.toContain('kill-pane')
  })

  it('fails closed before capture when a process generation is stale', async () => {
    const exec = defaultExec()
    const adapter = createAdapter(
      exec,
      async (pid) => statWithStartTicks(pid, pid === 201 ? 31 : pid / 10),
    )

    await expect(adapter.capture(liveSession)).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls.some((call) => call[1][2] === 'capture-pane')).toBe(false)
  })

  it('parses proc start ticks when process names contain spaces and parentheses', () => {
    expect(processStartTicks(statWithStartTicks(7, 1234))).toBe(1234)
  })

  it('uses the configured tmux socket and falls back to the container socket, never bare tmux', async () => {
    expect(resolveTmuxSocketPath('/custom/tmux.sock')).toBe('/custom/tmux.sock')
    expect(resolveTmuxSocketPath('   ')).toBe(DEFAULT_FRESHELL_TMUX_SOCKET)

    const originalSocket = process.env.FRESHELL_TMUX_SOCKET
    process.env.FRESHELL_TMUX_SOCKET = '/env/tmux.sock'
    const exec = defaultExec()
    try {
      const adapter = new ExistingPaneAdapter({
        exec,
        readProcessStat: async (pid) => validStarts(pid),
      })
      await adapter.capture(liveSession)
      expect(exec.mock.calls.every((call) => (
        call[1][0] === '-S' && call[1][1] === '/env/tmux.sock'
      ))).toBe(true)
    } finally {
      if (originalSocket === undefined) delete process.env.FRESHELL_TMUX_SOCKET
      else process.env.FRESHELL_TMUX_SOCKET = originalSocket
    }
  })
})

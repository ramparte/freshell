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

function processReadError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

function defaultExec() {
  return vi.fn(async (_file: string, args: readonly string[]) => {
    if (args[2] === 'display-message') return { stdout: '%5|200|100\n' }
    if (args[2] === 'capture-pane') return { stdout: 'existing pane output\n' }
    return { stdout: '' }
  })
}

type TestExec = ReturnType<typeof defaultExec>

function inputTransactions(exec: TestExec) {
  return exec.mock.calls.filter((call) => call[1][2] === 'if-shell')
}

function createAdapter(
  exec: TestExec,
  readProcessStat: (pid: number) => Promise<string> = async (pid) => validStarts(pid),
  options: { now?: () => number; leaseTtlMs?: number } = {},
) {
  return new ExistingPaneAdapter({
    exec,
    readProcessStat,
    tmuxSocketPath: TEST_TMUX_SOCKET,
    createLeaseToken: () => 'test-lease-token',
    ...options,
  })
}

async function issueLease(adapter: ExistingPaneAdapter): Promise<string> {
  return (await adapter.capture(liveSession)).input_lease
}

describe('ExistingPaneAdapter', () => {
  it('captures only the exact generation-validated pane and issues a bounded input lease', async () => {
    const exec = defaultExec()
    const adapter = createAdapter(exec, undefined, { now: () => 1_000 })

    await expect(adapter.capture(liveSession)).resolves.toEqual({
      ok: true,
      pane_id: '%5',
      data: 'existing pane output\n',
      input_enabled: true,
      next_input_sequence: 1,
      input_lease: 'test-lease-token',
      lease_expires_at: 11_000,
      control_mode: 'amplifier_bound',
    })
    expect(exec).toHaveBeenCalledTimes(3)
    expect(exec.mock.calls[1]?.[1]).toEqual([
      '-S', TEST_TMUX_SOCKET, 'capture-pane', '-p', '-e', '-J', '-t', '%5', '-S', '-200',
    ])
    expect(exec.mock.calls.every((call) => (
      call[0] === 'tmux' && call[1][0] === '-S' && call[1][1] === TEST_TMUX_SOCKET
    ))).toBe(true)
    expect(exec.mock.calls[0]?.[1][6]).toBe('#{pane_id}|#{pane_pid}|#{pid}')
    expect(inputTransactions(exec)).toHaveLength(0)
  })

  it('uses a printable identity delimiter that older tmux clients do not normalize', async () => {
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[2] === 'display-message') {
        const normalized = (args[6] ?? '').replace(/[\x00-\x20\x7f]/g, '_')
        return {
          stdout: `${normalized
            .replace('#{pane_id}', '%5')
            .replace('#{pane_pid}', '200')
            .replace('#{pid}', '100')}\n`,
        }
      }
      if (args[2] === 'capture-pane') return { stdout: 'output\n' }
      return { stdout: '' }
    }) as TestExec
    const adapter = createAdapter(exec)

    await expect(adapter.capture(liveSession)).resolves.toMatchObject({ pane_id: '%5' })
    expect(exec.mock.calls[0]?.[1][6]).toBe('#{pane_id}|#{pane_pid}|#{pid}')
  })

  it('encodes UTF-8 and controls as literal hex arguments without a shell', async () => {
    const exec = defaultExec()
    const adapter = createAdapter(exec)
    const lease = await issueLease(adapter)

    await expect(adapter.sendInput(
      liveSession.id,
      lease,
      { sequence: 1, data: 'é\u0003\r' },
    )).resolves.toEqual({
      ok: true,
      pane_id: '%5',
      sequence: 1,
      control_mode: 'amplifier_bound',
    })

    expect(encodeTmuxHexBytes('é\u0003\r')).toEqual(['c3', 'a9', '03', '0d'])
    expect(inputTransactions(exec)).toHaveLength(1)
    expect(inputTransactions(exec)[0]?.[1]).toEqual([
      '-S', TEST_TMUX_SOCKET, 'if-shell', '-F', '-t', '%5',
      '#{&&:#{==:#{pane_id},%5},#{&&:#{==:#{pane_pid},200},#{==:#{pid},100}}}',
      'send-keys -H -t %5 c3 a9 03 0d',
      'display-message -p -t %5 __FRESHELL_TMUX_IDENTITY_MISMATCH__',
    ])
    expect(JSON.stringify(exec.mock.calls)).not.toMatch(
      /resize-pane|respawn-pane|new-session|new-window|split-window|run-shell|kill-pane/,
    )
  })

  it('revalidates all generations after the atomic tmux input transaction', async () => {
    const events: string[] = []
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[2] === 'display-message') return { stdout: '%5|200|100\n' }
      if (args[2] === 'capture-pane') return { stdout: 'output\n' }
      events.push(`tmux:${args[2]}`)
      return { stdout: '' }
    }) as TestExec
    const adapter = createAdapter(exec, async (pid) => {
      events.push(`proc:${pid}`)
      return validStarts(pid)
    })
    const lease = await issueLease(adapter)
    events.length = 0

    await adapter.sendInput(liveSession.id, lease, { sequence: 1, data: 'batched text' })

    expect(events).toEqual([
      'proc:100', 'proc:200', 'proc:201',
      'tmux:if-shell',
      'proc:100', 'proc:200', 'proc:201',
    ])
    expect(inputTransactions(exec)).toHaveLength(1)
  })

  it('serializes input FIFO per exact pane', async () => {
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[2] === 'display-message') return { stdout: '%5|200|100\n' }
      if (args[2] === 'capture-pane') return { stdout: 'output\n' }
      if (args[2] === 'if-shell' && args[7]?.endsWith(' 61')) {
        markFirstStarted()
        await firstBlocked
      }
      return { stdout: '' }
    }) as TestExec
    const adapter = createAdapter(exec)
    const lease = await issueLease(adapter)

    const first = adapter.sendInput(liveSession.id, lease, { sequence: 1, data: 'a' })
    const second = adapter.sendInput(liveSession.id, lease, { sequence: 2, data: 'b' })

    await firstStarted
    expect(inputTransactions(exec)).toHaveLength(1)
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, pane_id: '%5', sequence: 1, control_mode: 'amplifier_bound' },
      { ok: true, pane_id: '%5', sequence: 2, control_mode: 'amplifier_bound' },
    ])
    expect(inputTransactions(exec).map((call) => call[1][7])).toEqual([
      'send-keys -H -t %5 61',
      'send-keys -H -t %5 62',
    ])
  })

  it('rejects replay and out-of-order sequences without poisoning the expected sequence', async () => {
    const exec = defaultExec()
    const adapter = createAdapter(exec)
    const lease = await issueLease(adapter)

    await adapter.sendInput(liveSession.id, lease, { sequence: 1, data: 'a' })
    await expect(adapter.sendInput(
      liveSession.id, lease, { sequence: 1, data: 'duplicate' },
    )).rejects.toBeInstanceOf(ExistingPaneInputError)
    await expect(adapter.sendInput(
      liveSession.id, lease, { sequence: 3, data: 'out-of-order' },
    )).rejects.toBeInstanceOf(ExistingPaneInputError)
    await expect(adapter.sendInput(
      liveSession.id, lease, { sequence: 2, data: 'b' },
    )).resolves.toMatchObject({ sequence: 2 })

    expect(inputTransactions(exec).map((call) => call[1][7])).toEqual([
      'send-keys -H -t %5 61',
      'send-keys -H -t %5 62',
    ])
  })

  it('fails closed before input when a recorded process generation becomes stale', async () => {
    let stale = false
    const exec = defaultExec()
    const adapter = createAdapter(exec, async (pid) => (
      statWithStartTicks(pid, stale && pid === 201 ? 31 : new Map([[100, 10], [200, 20], [201, 30]]).get(pid) ?? -1)
    ))
    const lease = await issueLease(adapter)
    stale = true

    await expect(adapter.sendInput(
      liveSession.id, lease, { sequence: 1, data: 'never sent' },
    )).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    expect(inputTransactions(exec)).toHaveLength(0)
  })

  it('revokes the lease on an atomic tmux identity race', async () => {
    let transactionCount = 0
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[2] === 'display-message') return { stdout: '%5|200|100\n' }
      if (args[2] === 'capture-pane') return { stdout: 'output\n' }
      if (args[2] === 'if-shell') {
        transactionCount += 1
        return { stdout: transactionCount === 1 ? '__FRESHELL_TMUX_IDENTITY_MISMATCH__\n' : '' }
      }
      return { stdout: '' }
    }) as TestExec
    const adapter = createAdapter(exec)
    const lease = await issueLease(adapter)

    await expect(adapter.sendInput(
      liveSession.id, lease, { sequence: 1, data: 'not delivered' },
    )).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    await expect(adapter.sendInput(
      liveSession.id, lease, { sequence: 1, data: 'retry' },
    )).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    expect(inputTransactions(exec)).toHaveLength(1)
  })

  it('expires disconnected leases and binds them to the canonical session', async () => {
    let now = 1_000
    const exec = defaultExec()
    const adapter = createAdapter(exec, undefined, { now: () => now, leaseTtlMs: 100 })
    const lease = await issueLease(adapter)

    await expect(adapter.sendInput(
      'different-session', lease, { sequence: 1, data: 'x' },
    )).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    now = 1_101
    await expect(adapter.sendInput(
      liveSession.id, lease, { sequence: 1, data: 'x' },
    )).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    expect(inputTransactions(exec)).toHaveLength(0)
  })

  it('renews a lease only after a generation-validated capture heartbeat', async () => {
    let now = 1_000
    const exec = defaultExec()
    const adapter = createAdapter(exec, undefined, { now: () => now, leaseTtlMs: 100 })
    const lease = await issueLease(adapter)
    now = 1_050

    await expect(adapter.captureWithLease(liveSession.id, lease)).resolves.toMatchObject({
      input_lease: lease,
      lease_expires_at: 1_150,
    })
    now = 1_120
    await expect(adapter.sendInput(
      liveSession.id, lease, { sequence: 1, data: 'x' },
    )).resolves.toMatchObject({ sequence: 1 })
  })

  it('rejects oversized chunks and stale capture without lifecycle commands', async () => {
    let stale = false
    const exec = defaultExec()
    const adapter = createAdapter(exec, async (pid) => (
      statWithStartTicks(pid, stale && pid === 201 ? 31 : new Map([[100, 10], [200, 20], [201, 30]]).get(pid) ?? -1)
    ))
    const lease = await issueLease(adapter)

    await expect(adapter.sendInput(
      liveSession.id, lease, { sequence: 1, data: 'x'.repeat(513) },
    )).rejects.toBeInstanceOf(ExistingPaneInputError)
    stale = true
    await expect(adapter.captureWithLease(
      liveSession.id, lease,
    )).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    expect(inputTransactions(exec)).toHaveLength(0)
    expect(exec.mock.calls.flatMap((call) => call[1])).not.toContain('kill-pane')
  })

  it.each(['ENOENT', 'ESRCH'])(
    'rejects initial attachment when Amplifier is definitely gone with %s',
    async (code) => {
      const exec = defaultExec()
      const adapter = createAdapter(exec, async (pid) => {
        if (pid === identity.amplifier_pid) throw processReadError(code)
        return validStarts(pid)
      })

      await expect(adapter.capture(liveSession)).rejects.toThrow(
        'exited before a generation-bound pane lease could be issued',
      )
      expect(exec.mock.calls.map((call) => call[1][2])).toEqual(['display-message'])
      await expect(adapter.captureWithLease(
        liveSession.id,
        'test-lease-token',
      )).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    },
  )

  it('transitions to shell continuation only after capture and post-capture revalidation', async () => {
    let amplifierGone = false
    let captureCount = 0
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[2] === 'display-message') return { stdout: '%5|200|100\n' }
      if (args[2] === 'capture-pane') {
        captureCount += 1
        if (captureCount === 2) amplifierGone = true
        return { stdout: `capture ${captureCount}\n` }
      }
      return { stdout: '' }
    }) as TestExec
    const adapter = createAdapter(exec, async (pid) => {
      if (pid === identity.amplifier_pid && amplifierGone) throw processReadError('ENOENT')
      return validStarts(pid)
    })
    const lease = await issueLease(adapter)

    await expect(adapter.captureWithLease(liveSession.id, lease)).resolves.toMatchObject({
      data: 'capture 2\n',
      input_lease: lease,
      control_mode: 'shell_continuation',
      input_enabled: true,
    })
    await expect(adapter.captureWithLease(liveSession.id, lease)).resolves.toMatchObject({
      data: 'capture 3\n',
      input_lease: lease,
      control_mode: 'shell_continuation',
      input_enabled: true,
    })
  })

  it('transitions to shell continuation only after input and post-input revalidation', async () => {
    let amplifierGone = false
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[2] === 'display-message') return { stdout: '%5|200|100\n' }
      if (args[2] === 'capture-pane') return { stdout: 'output\n' }
      if (args[2] === 'if-shell') {
        amplifierGone = true
        return { stdout: '' }
      }
      return { stdout: '' }
    }) as TestExec
    const adapter = createAdapter(exec, async (pid) => {
      if (pid === identity.amplifier_pid && amplifierGone) throw processReadError('ENOENT')
      return validStarts(pid)
    })
    const lease = await issueLease(adapter)

    await expect(adapter.sendInput(
      liveSession.id,
      lease,
      { sequence: 1, data: 'x' },
    )).resolves.toEqual({
      ok: true,
      pane_id: '%5',
      sequence: 1,
      control_mode: 'shell_continuation',
    })
    expect(inputTransactions(exec)).toHaveLength(1)
  })

  it('does not transition when the exact-pane operation fails after Amplifier exits', async () => {
    let amplifierGone = false
    let rejectCapture = false
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[2] === 'display-message') return { stdout: '%5|200|100\n' }
      if (args[2] === 'capture-pane') {
        if (rejectCapture) throw new Error('capture failed')
        return { stdout: 'output\n' }
      }
      return { stdout: '' }
    }) as TestExec
    const adapter = createAdapter(exec, async (pid) => {
      if (pid === identity.amplifier_pid && amplifierGone) throw processReadError('ENOENT')
      return validStarts(pid)
    })
    const lease = await issueLease(adapter)
    amplifierGone = true
    rejectCapture = true

    await expect(adapter.captureWithLease(
      liveSession.id,
      lease,
    )).rejects.toThrow('could not be captured safely')
    rejectCapture = false
    await expect(adapter.captureWithLease(
      liveSession.id,
      lease,
    )).rejects.toThrow('lease expired or does not match')
  })

  it('keeps input FIFO and replay sequence state across the shell transition', async () => {
    let amplifierGone = false
    const exec = defaultExec()
    const adapter = createAdapter(exec, async (pid) => {
      if (pid === identity.amplifier_pid && amplifierGone) throw processReadError('ESRCH')
      return validStarts(pid)
    })
    const lease = await issueLease(adapter)

    await expect(adapter.sendInput(
      liveSession.id, lease, { sequence: 1, data: 'a' },
    )).resolves.toMatchObject({
      sequence: 1,
      control_mode: 'amplifier_bound',
    })
    amplifierGone = true
    await expect(adapter.sendInput(
      liveSession.id, lease, { sequence: 2, data: 'b' },
    )).resolves.toMatchObject({
      sequence: 2,
      control_mode: 'shell_continuation',
    })
    await expect(adapter.sendInput(
      liveSession.id, lease, { sequence: 2, data: 'replay' },
    )).rejects.toBeInstanceOf(ExistingPaneInputError)
    await expect(adapter.sendInput(
      liveSession.id, lease, { sequence: 3, data: 'c' },
    )).resolves.toMatchObject({
      sequence: 3,
      control_mode: 'shell_continuation',
    })

    expect(inputTransactions(exec).map((call) => call[1][7])).toEqual([
      'send-keys -H -t %5 61',
      'send-keys -H -t %5 62',
      'send-keys -H -t %5 63',
    ])
  })

  it.each([
    ['PID reuse', async () => statWithStartTicks(identity.amplifier_pid, 31)],
    ['malformed proc stat', async () => 'malformed'],
    ['EACCES', async () => { throw processReadError('EACCES') }],
    ['other I/O failure', async () => { throw processReadError('EIO') }],
  ])('fails closed and revokes on uncertain Amplifier state: %s', async (_label, failedRead) => {
    let fail = false
    const exec = defaultExec()
    const adapter = createAdapter(exec, async (pid) => {
      if (pid === identity.amplifier_pid && fail) return failedRead()
      return validStarts(pid)
    })
    const lease = await issueLease(adapter)
    fail = true

    await expect(adapter.captureWithLease(
      liveSession.id,
      lease,
    )).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    fail = false
    await expect(adapter.captureWithLease(
      liveSession.id,
      lease,
    )).rejects.toThrow('lease expired or does not match')
  })

  it.each([
    ['tmux server', identity.tmux_server_pid, 11],
    ['pane process', identity.pane_pid, 21],
  ])('revokes continuation when the %s generation changes', async (_label, stalePid, ticks) => {
    let amplifierGone = false
    let generationChanged = false
    const exec = defaultExec()
    const adapter = createAdapter(exec, async (pid) => {
      if (pid === identity.amplifier_pid && amplifierGone) throw processReadError('ENOENT')
      if (pid === stalePid && generationChanged) return statWithStartTicks(pid, ticks)
      return validStarts(pid)
    })
    const lease = await issueLease(adapter)
    amplifierGone = true
    await adapter.captureWithLease(liveSession.id, lease)
    generationChanged = true

    await expect(adapter.captureWithLease(
      liveSession.id,
      lease,
    )).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    generationChanged = false
    await expect(adapter.captureWithLease(
      liveSession.id,
      lease,
    )).rejects.toThrow('lease expired or does not match')
  })

  it.each([
    ['pane ID', '%6|200|100\n'],
    ['pane PID', '%5|201|100\n'],
    ['tmux server PID', '%5|200|101\n'],
  ])('revokes continuation when the displayed %s changes', async (_label, changedIdentity) => {
    let amplifierGone = false
    let paneIdentity = '%5|200|100\n'
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[2] === 'display-message') return { stdout: paneIdentity }
      if (args[2] === 'capture-pane') return { stdout: 'output\n' }
      return { stdout: '' }
    }) as TestExec
    const adapter = createAdapter(exec, async (pid) => {
      if (pid === identity.amplifier_pid && amplifierGone) throw processReadError('ENOENT')
      return validStarts(pid)
    })
    const lease = await issueLease(adapter)
    amplifierGone = true
    await adapter.captureWithLease(liveSession.id, lease)
    paneIdentity = changedIdentity

    await expect(adapter.captureWithLease(
      liveSession.id,
      lease,
    )).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    paneIdentity = '%5|200|100\n'
    await expect(adapter.captureWithLease(
      liveSession.id,
      lease,
    )).rejects.toThrow('lease expired or does not match')
  })

  it('revokes continuation if the exited Amplifier PID reappears or is reused', async () => {
    let amplifierState: 'same' | 'gone' | 'reused' = 'same'
    const exec = defaultExec()
    const adapter = createAdapter(exec, async (pid) => {
      if (pid !== identity.amplifier_pid) return validStarts(pid)
      if (amplifierState === 'gone') throw processReadError('ENOENT')
      if (amplifierState === 'reused') return statWithStartTicks(pid, 31)
      return validStarts(pid)
    })
    const lease = await issueLease(adapter)
    amplifierState = 'gone'
    await adapter.captureWithLease(liveSession.id, lease)
    amplifierState = 'reused'

    await expect(adapter.captureWithLease(
      liveSession.id,
      lease,
    )).rejects.toThrow('Amplifier process generation changed')
  })

  it('does not reacquire an expired continuation lease after Amplifier exits', async () => {
    let now = 1_000
    let amplifierGone = false
    const exec = defaultExec()
    const adapter = createAdapter(exec, async (pid) => {
      if (pid === identity.amplifier_pid && amplifierGone) throw processReadError('ENOENT')
      return validStarts(pid)
    }, { now: () => now, leaseTtlMs: 100 })
    const lease = await issueLease(adapter)
    amplifierGone = true
    await adapter.captureWithLease(liveSession.id, lease)
    now = 1_201

    await expect(adapter.captureWithLease(
      liveSession.id,
      lease,
    )).rejects.toThrow('lease expired or does not match')
    await expect(adapter.capture(liveSession)).rejects.toThrow(
      'exited before a generation-bound pane lease could be issued',
    )
  })

  it('does not reacquire shell continuation after an adapter restart', async () => {
    let amplifierGone = false
    const exec = defaultExec()
    const readProcessStat = async (pid: number) => {
      if (pid === identity.amplifier_pid && amplifierGone) throw processReadError('ENOENT')
      return validStarts(pid)
    }
    const originalAdapter = createAdapter(exec, readProcessStat)
    const lease = await issueLease(originalAdapter)
    amplifierGone = true
    await originalAdapter.captureWithLease(liveSession.id, lease)

    const restartedAdapter = createAdapter(exec, readProcessStat)
    await expect(restartedAdapter.captureWithLease(
      liveSession.id,
      lease,
    )).rejects.toThrow('lease expired or does not match')
    await expect(restartedAdapter.capture(liveSession)).rejects.toThrow(
      'exited before a generation-bound pane lease could be issued',
    )
  })

  it('uses only exact-pane inspection, capture, and input commands during continuation', async () => {
    let amplifierGone = false
    const exec = defaultExec()
    const adapter = createAdapter(exec, async (pid) => {
      if (pid === identity.amplifier_pid && amplifierGone) throw processReadError('ENOENT')
      return validStarts(pid)
    })
    const lease = await issueLease(adapter)
    amplifierGone = true
    await adapter.captureWithLease(liveSession.id, lease)
    await adapter.sendInput(liveSession.id, lease, { sequence: 1, data: 'x' })

    const calls = JSON.stringify(exec.mock.calls)
    expect(calls).not.toMatch(
      /new-session|new-window|split-window|respawn-pane|kill-pane|kill-session|resize-pane|run-shell|attach-session|switch-client|amplifier|resume/,
    )
    expect(new Set(exec.mock.calls.map((call) => call[1][2]))).toEqual(
      new Set(['display-message', 'capture-pane', 'if-shell']),
    )
    expect(exec.mock.calls.every((call) => (
      call[1][0] === '-S' && call[1][1] === TEST_TMUX_SOCKET
    ))).toBe(true)
  })

  it('rejects historical sessions before capture', async () => {
    const exec = defaultExec()
    const adapter = createAdapter(exec)
    const endedSession: ConcernSession = {
      ...liveSession,
      live: false,
      status: 'ended',
      attachment: undefined,
    }

    await expect(adapter.capture(endedSession)).rejects.toBeInstanceOf(ExistingPaneIdentityError)
    expect(exec).not.toHaveBeenCalled()
  })

  it('parses proc start ticks when process names contain spaces and parentheses', () => {
    expect(processStartTicks(statWithStartTicks(7, 1234))).toBe(1234)
  })

  it('uses the configured tmux socket and falls back to the mounted host socket', async () => {
    expect(resolveTmuxSocketPath('/custom/tmux.sock')).toBe('/custom/tmux.sock')
    expect(resolveTmuxSocketPath('   ')).toBe(DEFAULT_FRESHELL_TMUX_SOCKET)

    const originalSocket = process.env.FRESHELL_TMUX_SOCKET
    process.env.FRESHELL_TMUX_SOCKET = '/env/tmux.sock'
    const exec = defaultExec()
    try {
      const adapter = new ExistingPaneAdapter({
        exec,
        readProcessStat: async (pid) => validStarts(pid),
        createLeaseToken: () => 'lease',
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

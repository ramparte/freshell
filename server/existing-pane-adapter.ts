import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type {
  ConcernLiveIdentity,
  ConcernPaneInputRequest,
  ConcernPaneInputResponse,
  ConcernPaneSnapshot,
  ConcernSession,
} from '../shared/concern-os-contract.js'
import { MAX_CONCERN_PANE_INPUT_BYTES } from '../shared/concern-os-contract.js'

const execFile = promisify(execFileCallback)
// Use a printable delimiter: older tmux clients normalize control characters
// in command arguments before forwarding them to a newer host tmux server.
const TMUX_IDENTITY_FORMAT = '#{pane_id}|#{pane_pid}|#{pid}'
const TMUX_IDENTITY_MISMATCH_MARKER = '__FRESHELL_TMUX_IDENTITY_MISMATCH__'
const MAX_CAPTURE_BYTES = 512 * 1024
export const DEFAULT_FRESHELL_TMUX_SOCKET = '/run/host-tmux/default'

type ExecFile = (
  file: string,
  args: readonly string[],
  options: { encoding: 'utf8'; maxBuffer: number },
) => Promise<{ stdout: string; stderr?: string }>

export type ExistingPaneAdapterOptions = {
  exec?: ExecFile
  readProcessStat?: (pid: number) => Promise<string>
  tmuxSocketPath?: string
}

export class ExistingPaneIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExistingPaneIdentityError'
  }
}

export class ExistingPaneInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExistingPaneInputError'
  }
}

export function encodeTmuxHexBytes(data: string): string[] {
  return [...Buffer.from(data, 'utf8')].map((byte) => byte.toString(16).padStart(2, '0'))
}

export function resolveTmuxSocketPath(
  configured: string | undefined = process.env.FRESHELL_TMUX_SOCKET,
): string {
  const trimmed = configured?.trim()
  return trimmed || DEFAULT_FRESHELL_TMUX_SOCKET
}

export function processStartTicks(stat: string): number | undefined {
  const commandEnd = stat.lastIndexOf(')')
  if (commandEnd < 0) return undefined
  // Fields after the command start at proc(5) field 3; starttime is field 22.
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/)
  const value = Number(fields[19])
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export class ExistingPaneAdapter {
  private readonly run: ExecFile
  private readonly readStat: (pid: number) => Promise<string>
  private readonly tmuxSocketPath: string
  private readonly paneQueues = new Map<string, Promise<void>>()
  private readonly lastSequences = new Map<string, number>()

  constructor(options: ExistingPaneAdapterOptions = {}) {
    this.run = options.exec ?? (async (file, args, commandOptions) => {
      const result = await execFile(file, [...args], commandOptions)
      return { stdout: result.stdout, stderr: result.stderr }
    })
    this.readStat = options.readProcessStat
      ?? ((pid) => readFile(`/proc/${pid}/stat`, 'utf8'))
    this.tmuxSocketPath = resolveTmuxSocketPath(options.tmuxSocketPath)
  }

  async capture(session: ConcernSession): Promise<ConcernPaneSnapshot> {
    const identity = this.requireIdentity(session)

    await this.validate(identity)
    const { stdout } = await this.run('tmux', this.tmuxArgs([
      'capture-pane',
      '-p',
      '-e',
      '-J',
      '-t',
      identity.pane_id,
      '-S',
      '-5000',
    ]), { encoding: 'utf8', maxBuffer: MAX_CAPTURE_BYTES })
    // Validate again so output cannot be returned across a pane/PID generation race.
    await this.validate(identity)

    return {
      ok: true,
      pane_id: identity.pane_id,
      data: stdout,
      input_enabled: true,
      next_input_sequence: this.nextSequence(identity),
    }
  }

  async sendInput(
    initialSession: ConcernSession,
    input: ConcernPaneInputRequest,
    resolveCurrentSession: () => Promise<ConcernSession>,
  ): Promise<ConcernPaneInputResponse> {
    const initialIdentity = this.requireIdentity(initialSession)
    const queueKey = this.queueKey(initialIdentity)

    return this.enqueue(queueKey, async () => {
      const currentSession = await resolveCurrentSession()
      const currentIdentity = this.requireIdentity(currentSession)
      this.assertSameMapping(initialSession, initialIdentity, currentSession, currentIdentity)

      const bytes = encodeTmuxHexBytes(input.data)
      if (bytes.length === 0 || bytes.length > MAX_CONCERN_PANE_INPUT_BYTES) {
        throw new ExistingPaneInputError(
          `Input must contain between 1 and ${MAX_CONCERN_PANE_INPUT_BYTES} UTF-8 bytes.`,
        )
      }

      const sequenceKey = this.sequenceKey(currentIdentity)
      const expectedSequence = (this.lastSequences.get(sequenceKey) ?? 0) + 1
      if (input.sequence !== expectedSequence) {
        throw new ExistingPaneInputError(
          `Input sequence ${input.sequence} rejected; expected ${expectedSequence}.`,
        )
      }

      // These /proc checks happen after this request reaches the FIFO head and
      // immediately before the one tmux transaction below. The tmux server
      // then checks its own server/pane identity and sends the bytes as one
      // command-queue operation, so another tmux client cannot replace the
      // target between a display-message check and send-keys.
      await this.validateProcessGenerations(currentIdentity)
      await this.sendAtomicallyIfIdentityMatches(currentIdentity, bytes)
      this.lastSequences.set(sequenceKey, input.sequence)

      return {
        ok: true,
        pane_id: currentIdentity.pane_id,
        sequence: input.sequence,
      }
    })
  }

  private requireIdentity(session: ConcernSession): ConcernLiveIdentity {
    if (!session.live || session.attachment?.state !== 'resolvable') {
      throw new ExistingPaneIdentityError('Session is not uniquely attached to a live tmux pane.')
    }
    const identity = session.attachment.live_identity
    if (
      identity.pane_id !== session.attachment.pane_id
      || !/^%\d+$/.test(identity.pane_id)
      || ![
        identity.tmux_server_pid,
        identity.tmux_server_start_ticks,
        identity.pane_pid,
        identity.pane_start_ticks,
        identity.amplifier_pid,
        identity.amplifier_start_ticks,
      ].every(Number.isSafeInteger)
      || identity.tmux_server_pid <= 0
      || identity.pane_pid <= 0
      || identity.amplifier_pid <= 0
      || identity.tmux_server_start_ticks < 0
      || identity.pane_start_ticks < 0
      || identity.amplifier_start_ticks < 0
    ) {
      throw new ExistingPaneIdentityError('Concern OS returned inconsistent pane identity.')
    }
    return identity
  }

  private assertSameMapping(
    initialSession: ConcernSession,
    initialIdentity: ConcernLiveIdentity,
    currentSession: ConcernSession,
    currentIdentity: ConcernLiveIdentity,
  ): void {
    if (
      currentSession.id !== initialSession.id
      || currentSession.session_id !== initialSession.session_id
      || JSON.stringify(currentIdentity) !== JSON.stringify(initialIdentity)
    ) {
      throw new ExistingPaneIdentityError('Concern OS pane mapping changed before input.')
    }
  }

  private queueKey(identity: ConcernLiveIdentity): string {
    return `${identity.tmux_server_pid}:${identity.tmux_server_start_ticks}:${identity.pane_id}`
  }

  private sequenceKey(identity: ConcernLiveIdentity): string {
    return [
      this.queueKey(identity),
      identity.pane_pid,
      identity.pane_start_ticks,
      identity.amplifier_pid,
      identity.amplifier_start_ticks,
    ].join(':')
  }

  private nextSequence(identity: ConcernLiveIdentity): number {
    return (this.lastSequences.get(this.sequenceKey(identity)) ?? 0) + 1
  }

  private async enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.paneQueues.get(key) ?? Promise.resolve()
    const result = prior.then(operation, operation)
    const settled = result.then(() => undefined, () => undefined)
    this.paneQueues.set(key, settled)
    try {
      return await result
    } finally {
      if (this.paneQueues.get(key) === settled) this.paneQueues.delete(key)
    }
  }

  private async validate(identity: ConcernLiveIdentity): Promise<void> {
    const { stdout } = await this.run('tmux', this.tmuxArgs([
      'display-message',
      '-p',
      '-t',
      identity.pane_id,
      TMUX_IDENTITY_FORMAT,
    ]), { encoding: 'utf8', maxBuffer: 16 * 1024 })
    const identityFields = stdout.trim().split('|')
    const [paneId, panePidRaw, serverPidRaw] = identityFields
    if (
      identityFields.length !== 3
      || paneId !== identity.pane_id
      || Number(panePidRaw) !== identity.pane_pid
      || Number(serverPidRaw) !== identity.tmux_server_pid
    ) {
      throw new ExistingPaneIdentityError('The tmux pane no longer matches its catalog identity.')
    }

    await this.validateProcessGenerations(identity)
  }

  private async validateProcessGenerations(identity: ConcernLiveIdentity): Promise<void> {
    await Promise.all([
      this.assertGeneration(
        identity.tmux_server_pid,
        identity.tmux_server_start_ticks,
        'tmux server',
      ),
      this.assertGeneration(identity.pane_pid, identity.pane_start_ticks, 'pane process'),
      this.assertGeneration(
        identity.amplifier_pid,
        identity.amplifier_start_ticks,
        'Amplifier process',
      ),
    ])
  }

  private async sendAtomicallyIfIdentityMatches(
    identity: ConcernLiveIdentity,
    bytes: readonly string[],
  ): Promise<void> {
    const predicate = [
      '#{&&:',
      `#{==:#{pane_id},${identity.pane_id}},`,
      '#{&&:',
      `#{==:#{pane_pid},${identity.pane_pid}},`,
      `#{==:#{pid},${identity.tmux_server_pid}}`,
      '}}',
    ].join('')
    const sendCommand = [
      'send-keys',
      '-H',
      '-t',
      identity.pane_id,
      ...bytes,
    ].join(' ')
    const rejectCommand = [
      'display-message',
      '-p',
      '-t',
      identity.pane_id,
      TMUX_IDENTITY_MISMATCH_MARKER,
    ].join(' ')
    const { stdout, stderr } = await this.run('tmux', this.tmuxArgs([
      'if-shell',
      '-F',
      '-t',
      identity.pane_id,
      predicate,
      sendCommand,
      rejectCommand,
    ]), { encoding: 'utf8', maxBuffer: 16 * 1024 })

    // send-keys has no output. The false branch emits the marker, and any
    // other output is also rejected rather than treating an ambiguous tmux
    // response as a successful input.
    if (stdout.trim() !== '' || stderr?.trim()) {
      throw new ExistingPaneIdentityError(
        'The tmux pane changed before input could be delivered.',
      )
    }
  }

  private tmuxArgs(args: readonly string[]): string[] {
    return ['-S', this.tmuxSocketPath, ...args]
  }

  private async assertGeneration(pid: number, expectedTicks: number, label: string): Promise<void> {
    let actualTicks: number | undefined
    try {
      actualTicks = processStartTicks(await this.readStat(pid))
    } catch {
      throw new ExistingPaneIdentityError(`The ${label} is no longer running.`)
    }
    if (actualTicks !== expectedTicks) {
      throw new ExistingPaneIdentityError(`The ${label} generation changed.`)
    }
  }
}
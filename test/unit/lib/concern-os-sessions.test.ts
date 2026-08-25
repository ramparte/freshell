import { describe, expect, it } from 'vitest'
import {
  mergeConcernSessionItems,
  routeAmplifierSession,
  sortByConcernAttention,
} from '@/lib/concern-os-sessions'
import type { ConcernSession } from '@shared/concern-os-contract'

function session(
  sessionId: string,
  options: {
    attention?: ConcernSession['attention']
    attachment?: ConcernSession['attachment']
    live?: boolean
  } = {},
): ConcernSession {
  return {
    id: `amplifier:${sessionId}`,
    session_id: sessionId,
    provider: 'amplifier',
    historical: true,
    live: options.live ?? false,
    status: options.live ? 'live' : 'historical',
    working_dir: '/work',
    created: '2026-08-24T00:00:00Z',
    last_activity_at: 1,
    attachment: options.attachment,
    attention: options.attention,
  }
}

describe('Concern OS session routing', () => {
  it('routes only uniquely resolvable live records to the existing-pane display', () => {
    const live = session('live', {
      live: true,
      attachment: {
        state: 'resolvable',
        pane_id: '%5',
        live_identity: {
          tmux_server_pid: 100,
          tmux_server_start_ticks: 10,
          pane_id: '%5',
          pane_pid: 200,
          pane_start_ticks: 20,
          amplifier_pid: 201,
          amplifier_start_ticks: 30,
        },
      },
    })
    const ambiguous = session('ambiguous', {
      live: true,
      attachment: { state: 'blocked', reason: 'multiple panes' },
    })

    expect(routeAmplifierSession(live)).toBe('live')
    expect(routeAmplifierSession(ambiguous)).toBe('blocked')
    expect(routeAmplifierSession(session('historical'))).toBe('historical')
  })

  it('sorts needs-you and ready records ahead while preserving ordinary order', () => {
    const items = [
      { provider: 'amplifier', sessionId: 'idle' },
      { provider: 'claude', sessionId: 'unmanaged' },
      { provider: 'amplifier', sessionId: 'ready' },
      { provider: 'amplifier', sessionId: 'needs' },
    ]
    const sessions = new Map([
      ['idle', session('idle', {
        attention: { pane_id: '%1', state: 'idle', severity: 0, why: 'quiet' },
      })],
      ['ready', session('ready', {
        attention: { pane_id: '%2', state: 'ready', severity: 2, why: 'done' },
      })],
      ['needs', session('needs', {
        attention: { pane_id: '%3', state: 'needs', severity: 3, why: 'approval' },
      })],
    ])

    expect(sortByConcernAttention(items, sessions).map((item) => item.sessionId)).toEqual([
      'needs',
      'ready',
      'idle',
      'unmanaged',
    ])
  })

  it('adds catalog-only live sessions and converts catalog seconds to milliseconds', () => {
    const live = session('catalog-only-session', { live: true })
    live.last_activity_at = 1_700_000_000
    live.working_dir = '/work/catalog-project'
    const merged = mergeConcernSessionItems([], new Map([[live.session_id, live]]))

    expect(merged).toEqual([
      expect.objectContaining({
        sessionId: 'catalog-only-session',
        provider: 'amplifier',
        cwd: '/work/catalog-project',
        subtitle: 'catalog-project',
        timestamp: 1_700_000_000_000,
        isRunning: true,
      }),
    ])
  })

  it('does not duplicate Freshell records already represented by Concern OS', () => {
    const existing = {
      id: 'session-amplifier-same',
      sessionId: 'same',
      provider: 'amplifier' as const,
      sessionType: 'amplifier',
      title: 'Existing title',
      timestamp: 10,
      hasTab: false,
      isRunning: false,
      hasTitle: true,
    }
    expect(mergeConcernSessionItems(
      [existing],
      new Map([['same', session('same', { live: true })]]),
    )).toEqual([existing])
  })
})
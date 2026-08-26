// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  createConcernOsRouter,
  createExistingPaneIoRateLimitMiddleware,
  createGlobalApiRateLimitMiddleware,
} from '../../../server/concern-os-router.js'
import { httpAuthMiddleware } from '../../../server/auth.js'
import {
  ExistingPaneIdentityError,
  ExistingPaneInputError,
  type ExistingPaneAdapter,
} from '../../../server/existing-pane-adapter.js'
import type { ConcernOsClient } from '../../../server/concern-os-client.js'
import type { ConcernSession } from '../../../shared/concern-os-contract.js'

const session: ConcernSession = {
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
}

type AdapterMethods = Pick<ExistingPaneAdapter, 'capture' | 'captureWithLease' | 'sendInput'>

function appWith(overrides: Partial<AdapterMethods> = {}) {
  const client = {
    getSession: vi.fn(async () => structuredClone(session)),
    listSessions: vi.fn(),
  } as unknown as ConcernOsClient
  const adapter = {
    capture: vi.fn(async () => ({
      ok: true as const,
      pane_id: '%5' as const,
      data: 'pane output',
      input_enabled: true,
      next_input_sequence: 1,
      input_lease: 'lease-1',
      lease_expires_at: 1_000,
      control_mode: 'amplifier_bound' as const,
    })),
    captureWithLease: vi.fn(async () => ({
      ok: true as const,
      pane_id: '%5' as const,
      data: 'pane output',
      input_enabled: true,
      next_input_sequence: 1,
      input_lease: 'lease-1',
      lease_expires_at: 1_000,
      control_mode: 'shell_continuation' as const,
    })),
    sendInput: vi.fn(async () => ({
      ok: true as const,
      pane_id: '%5' as const,
      sequence: 1,
      control_mode: 'shell_continuation' as const,
    })),
    ...overrides,
  } as unknown as ExistingPaneAdapter
  const app = express()
  app.use(express.json())
  app.use('/api', createConcernOsRouter(client, adapter))
  return { app, client, adapter }
}

function limitedAppWith(globalMax: number, existingPaneMax: number) {
  const { client, adapter } = appWith()
  const app = express()
  app.use(express.json())
  app.use('/api', createGlobalApiRateLimitMiddleware(globalMax))
  app.use('/api', httpAuthMiddleware)
  app.use('/api', createExistingPaneIoRateLimitMiddleware(existingPaneMax))
  app.use('/api', createConcernOsRouter(client, adapter))
  app.get('/api/other', (_req, res) => res.json({ ok: true }))
  return { app, client, adapter }
}

describe('Concern OS pane routes', () => {
  const authToken = 'test-token-with-at-least-16-characters'
  let previousAuthToken: string | undefined

  beforeEach(() => {
    previousAuthToken = process.env.AUTH_TOKEN
    process.env.AUTH_TOKEN = authToken
  })

  afterEach(() => {
    if (previousAuthToken === undefined) delete process.env.AUTH_TOKEN
    else process.env.AUTH_TOKEN = previousAuthToken
  })

  it('returns only the adapter generation-validated snapshot and next input sequence', async () => {
    const { app, client, adapter } = appWith()

    const response = await request(app).get('/api/concern-os/sessions/session-1/pane')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      pane_id: '%5',
      data: 'pane output',
      input_enabled: true,
      next_input_sequence: 1,
      input_lease: 'lease-1',
      lease_expires_at: 1_000,
      control_mode: 'amplifier_bound',
    })
    expect(client.getSession).toHaveBeenCalledWith('session-1')
    expect(adapter.capture).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'session-1' }))
  })

  it('uses a generation-bound lease for poll captures without re-querying the catalog', async () => {
    const { app, client, adapter } = appWith()

    const response = await request(app)
      .get('/api/concern-os/sessions/session-1/pane')
      .set('x-concern-pane-lease', 'lease-1')

    expect(response.status).toBe(200)
    expect(client.getSession).not.toHaveBeenCalled()
    expect(adapter.capture).not.toHaveBeenCalled()
    expect(adapter.captureWithLease).toHaveBeenCalledWith('session-1', 'lease-1')
    expect(response.body.control_mode).toBe('shell_continuation')
  })

  it('rejects capture when the upstream canonical key does not match the requested session', async () => {
    const { app, client, adapter } = appWith()
    vi.mocked(client.getSession).mockResolvedValue({
      ...structuredClone(session),
      id: 'amplifier:different-session',
    })

    const response = await request(app).get('/api/concern-os/sessions/session-1/pane')

    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      ok: false,
      error: 'Concern OS returned a different session mapping.',
    })
    expect(adapter.capture).not.toHaveBeenCalled()
  })

  it('rejects detail when the upstream raw session ID does not match the requested key', async () => {
    const { app, client } = appWith()
    vi.mocked(client.getSession).mockResolvedValue({
      ...structuredClone(session),
      session_id: 'different-session',
    })

    const response = await request(app)
      .get(`/api/concern-os/sessions/${encodeURIComponent('amplifier:session-1')}`)

    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      ok: false,
      error: 'Concern OS returned a different session mapping.',
    })
    expect(response.body).not.toHaveProperty('item')
  })

  it('requires a generation-bound lease before input', async () => {
    const { app, client, adapter } = appWith()
    const response = await request(app)
      .post('/api/concern-os/sessions/session-1/pane/input')
      .send({ sequence: 1, data: 'never sent' })

    expect(response.status).toBe(409)
    expect(client.getSession).not.toHaveBeenCalled()
    expect(adapter.sendInput).not.toHaveBeenCalled()
  })

  it('uses the lease fast path without a per-input catalog query', async () => {
    const sendInput = vi.fn(async (
      _sessionId: string,
      _lease: string,
      input: { sequence: number; data: string },
    ) => ({
      ok: true as const,
      pane_id: '%5' as const,
      sequence: input.sequence,
      control_mode: 'shell_continuation' as const,
    }))
    const { app, client } = appWith({ sendInput })

    const response = await request(app)
      .post('/api/concern-os/sessions/session-1/pane/input')
      .set('x-concern-pane-lease', 'lease-1')
      .send({ sequence: 1, data: 'hello' })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      pane_id: '%5',
      sequence: 1,
      control_mode: 'shell_continuation',
    })
    expect(client.getSession).not.toHaveBeenCalled()
    expect(sendInput).toHaveBeenCalledWith(
      'session-1',
      'lease-1',
      { sequence: 1, data: 'hello' },
    )
  })

  it('rejects malformed and oversized input before querying Concern OS', async () => {
    const { app, client } = appWith()

    const malformed = await request(app)
      .post('/api/concern-os/sessions/session-1/pane/input')
      .send({ sequence: 0, data: '' })
    const oversized = await request(app)
      .post('/api/concern-os/sessions/session-1/pane/input')
      .send({ sequence: 1, data: 'é'.repeat(257) })

    expect(malformed.status).toBe(400)
    expect(oversized.status).toBe(413)
    expect(client.getSession).not.toHaveBeenCalled()
  })

  it('returns conflict for stale identity and monotonic sequence failures', async () => {
    const identityFailure = appWith({
      sendInput: vi.fn(async () => {
        throw new ExistingPaneIdentityError('pane generation changed')
      }),
    })
    const sequenceFailure = appWith({
      sendInput: vi.fn(async () => {
        throw new ExistingPaneInputError('expected sequence 2')
      }),
    })

    const staleResponse = await request(identityFailure.app)
      .post('/api/concern-os/sessions/session-1/pane/input')
      .set('x-concern-pane-lease', 'lease-1')
      .send({ sequence: 1, data: 'x' })
    const sequenceResponse = await request(sequenceFailure.app)
      .post('/api/concern-os/sessions/session-1/pane/input')
      .set('x-concern-pane-lease', 'lease-1')
      .send({ sequence: 1, data: 'x' })

    expect(staleResponse.status).toBe(409)
    expect(staleResponse.body).toEqual({ ok: false, error: 'pane generation changed' })
    expect(sequenceResponse.status).toBe(409)
    expect(sequenceResponse.body).toEqual({ ok: false, error: 'expected sequence 2' })
  })

  it('fails closed with conflict when exact pane identity no longer validates on capture', async () => {
    const { app } = appWith({
      capture: vi.fn(async () => {
        throw new ExistingPaneIdentityError('pane generation changed')
      }),
    })

    const response = await request(app).get('/api/concern-os/sessions/session-1/pane')

    expect(response.status).toBe(409)
    expect(response.body).toEqual({ ok: false, error: 'pane generation changed' })
  })

  it('never falls back to catalog reacquisition when a continuation lease fails', async () => {
    const captureWithLease = vi.fn(async () => {
      throw new ExistingPaneIdentityError('continuation lease expired')
    })
    const { app, client, adapter } = appWith({ captureWithLease })

    const response = await request(app)
      .get('/api/concern-os/sessions/session-1/pane')
      .set('x-concern-pane-lease', 'expired-continuation-lease')

    expect(response.status).toBe(409)
    expect(response.body).toEqual({ ok: false, error: 'continuation lease expired' })
    expect(client.getSession).not.toHaveBeenCalled()
    expect(adapter.capture).not.toHaveBeenCalled()
    expect(captureWithLease).toHaveBeenCalledOnce()
  })

  it('authenticates pane I/O before consuming its dedicated rate limit', async () => {
    const { app } = limitedAppWith(1, 2)
    const path = '/api/concern-os/sessions/session-1/pane'

    const unauthorized = await request(app).get(path)
    const first = await request(app).get(path).set('x-auth-token', authToken)
    const second = await request(app).get(path).set('x-auth-token', authToken)
    const limited = await request(app).get(path).set('x-auth-token', authToken)

    expect(unauthorized.status).toBe(401)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(limited.status).toBe(429)
  })

  it('keeps exact pane I/O out of the global budget while limiting other API traffic', async () => {
    const { app } = limitedAppWith(1, 4)
    const token = { 'x-auth-token': authToken }

    const capture = await request(app)
      .get('/api/concern-os/sessions/session-1/pane')
      .set(token)
    const input = await request(app)
      .post('/api/concern-os/sessions/session-1/pane/input')
      .set(token)
      .set('x-concern-pane-lease', 'lease-1')
      .send({ sequence: 1, data: 'x' })
    const firstOther = await request(app).get('/api/other').set(token)
    const limitedOther = await request(app).get('/api/other').set(token)

    expect(capture.status).toBe(200)
    expect(input.status).toBe(200)
    expect(firstOther.status).toBe(200)
    expect(limitedOther.status).toBe(429)
  })
})

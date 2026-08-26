import { Router, type Request, type RequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import type { ConcernOsClient } from './concern-os-client.js'
import {
  ExistingPaneAdapter,
  ExistingPaneIdentityError,
  ExistingPaneInputError,
} from './existing-pane-adapter.js'
import {
  ConcernPaneInputRequestSchema,
  MAX_CONCERN_PANE_INPUT_BYTES,
  type ConcernSession,
} from '../shared/concern-os-contract.js'

export const GLOBAL_API_RATE_LIMIT_MAX = 300
export const EXISTING_PANE_IO_RATE_LIMIT_MAX = 4_800
export const API_RATE_LIMIT_WINDOW_MS = 60_000

const EXISTING_PANE_CAPTURE_PATH = /^\/concern-os\/sessions\/[^/]+\/pane$/
const EXISTING_PANE_INPUT_PATH = /^\/concern-os\/sessions\/[^/]+\/pane\/input$/

export function isExistingPaneIoRequest(
  req: Pick<Request, 'method' | 'path'>,
): boolean {
  const path = req.path.startsWith('/api/')
    ? req.path.slice('/api'.length)
    : req.path
  return (
    (req.method === 'GET' && EXISTING_PANE_CAPTURE_PATH.test(path))
    || (req.method === 'POST' && EXISTING_PANE_INPUT_PATH.test(path))
  )
}

export function createGlobalApiRateLimitMiddleware(
  max = GLOBAL_API_RATE_LIMIT_MAX,
  windowMs = API_RATE_LIMIT_WINDOW_MS,
): RequestHandler {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isExistingPaneIoRequest,
  })
}

export function createExistingPaneIoRateLimitMiddleware(
  max = EXISTING_PANE_IO_RATE_LIMIT_MAX,
  windowMs = API_RATE_LIMIT_WINDOW_MS,
): RequestHandler {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => !isExistingPaneIoRequest(req),
  })
}

function assertRequestedSession(
  requestedSession: string,
  session: ConcernSession,
): ConcernSession {
  const providerPrefix = 'amplifier:'
  const expectedSessionId = requestedSession.startsWith(providerPrefix)
    ? requestedSession.slice(providerPrefix.length)
    : requestedSession
  const expectedKey = `${providerPrefix}${expectedSessionId}`

  if (
    expectedSessionId.length === 0
    || session.provider !== 'amplifier'
    || session.session_id !== expectedSessionId
    || session.id !== expectedKey
  ) {
    throw new ExistingPaneIdentityError('Concern OS returned a different session mapping.')
  }
  return session
}

async function getRequestedSession(
  client: ConcernOsClient,
  requestedSession: string,
): Promise<ConcernSession> {
  return assertRequestedSession(
    requestedSession,
    await client.getSession(requestedSession),
  )
}

export function createConcernOsRouter(
  client: ConcernOsClient,
  paneAdapter: ExistingPaneAdapter = new ExistingPaneAdapter(),
): Router {
  const router = Router()

  router.get('/concern-os/sessions', async (_req, res) => {
    try {
      res.json(await client.listSessions())
    } catch (error) {
      res.status(502).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Concern OS session catalog unavailable',
      })
    }
  })

  router.get('/concern-os/sessions/:sessionId/pane', async (req, res) => {
    try {
      const lease = req.headers['x-concern-pane-lease']
      if (typeof lease === 'string' && lease.length > 0) {
        res.json(await paneAdapter.captureWithLease(req.params.sessionId, lease))
      } else {
        const session = await getRequestedSession(client, req.params.sessionId)
        res.json(await paneAdapter.capture(session))
      }
    } catch (error) {
      const identityFailure = error instanceof ExistingPaneIdentityError
      res.status(identityFailure ? 409 : 502).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Existing tmux pane unavailable',
      })
    }
  })

  router.post('/concern-os/sessions/:sessionId/pane/input', async (req, res) => {
    const parsed = ConcernPaneInputRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid existing-pane input request.' })
      return
    }
    if (Buffer.byteLength(parsed.data.data, 'utf8') > MAX_CONCERN_PANE_INPUT_BYTES) {
      res.status(413).json({
        ok: false,
        error: `Existing-pane input exceeds ${MAX_CONCERN_PANE_INPUT_BYTES} UTF-8 bytes.`,
      })
      return
    }

    try {
      const lease = req.headers['x-concern-pane-lease']
      if (typeof lease !== 'string' || lease.length === 0) {
        res.status(409).json({ ok: false, error: 'A generation-bound tmux input lease is required.' })
        return
      }
      res.json(await paneAdapter.sendInput(req.params.sessionId, lease, parsed.data))
    } catch (error) {
      const conflict = error instanceof ExistingPaneIdentityError
        || error instanceof ExistingPaneInputError
      res.status(conflict ? 409 : 502).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Existing tmux pane input failed',
      })
    }
  })

  router.get('/concern-os/sessions/:sessionId', async (req, res) => {
    try {
      res.json({
        ok: true,
        item: await getRequestedSession(client, req.params.sessionId),
      })
    } catch (error) {
      const identityFailure = error instanceof ExistingPaneIdentityError
      res.status(identityFailure ? 409 : 502).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Concern OS session unavailable',
      })
    }
  })

  return router
}
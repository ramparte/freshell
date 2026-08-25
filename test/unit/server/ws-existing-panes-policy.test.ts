// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import WebSocket from 'ws'

vi.mock('../../../server/config-store.js', () => ({
  configStore: {
    snapshot: vi.fn().mockResolvedValue({ settings: {} }),
    pushRecentDirectory: vi.fn().mockResolvedValue([]),
  },
}))

import { WsHandler } from '../../../server/ws-handler.js'
import { TerminalRegistry } from '../../../server/terminal-registry.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'
import { EXISTING_PANES_ONLY_MESSAGE } from '../../../server/existing-panes-policy.js'

const AUTH_TOKEN = 'existing-panes-policy-token'

type JsonMessage = Record<string, unknown> & { type: string }

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port')
  return address.port
}

async function connectAndAuthenticate(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for ready')), 5_000)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        token: AUTH_TOKEN,
        protocolVersion: WS_PROTOCOL_VERSION,
      }))
    })
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as JsonMessage
      if (message.type === 'ready') {
        clearTimeout(timeout)
        resolve()
      }
    })
    ws.on('error', reject)
  })
  return ws
}

function sendAndWaitForRequest(ws: WebSocket, payload: JsonMessage): Promise<JsonMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${String(payload.requestId)}`)), 5_000)
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as JsonMessage
      if (message.requestId !== payload.requestId) return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify(payload))
  })
}

describe('FRESHELL_EXISTING_PANES_ONLY WebSocket admission', () => {
  const originalAuthToken = process.env.AUTH_TOKEN
  const originalExistingPanesOnly = process.env.FRESHELL_EXISTING_PANES_ONLY

  beforeEach(() => {
    process.env.AUTH_TOKEN = AUTH_TOKEN
    process.env.FRESHELL_EXISTING_PANES_ONLY = '1'
  })

  afterEach(() => {
    if (originalAuthToken === undefined) delete process.env.AUTH_TOKEN
    else process.env.AUTH_TOKEN = originalAuthToken
    if (originalExistingPanesOnly === undefined) delete process.env.FRESHELL_EXISTING_PANES_ONLY
    else process.env.FRESHELL_EXISTING_PANES_ONLY = originalExistingPanesOnly
  })

  it('rejects terminal.create and codingcli.create resume paths before either manager is called', async () => {
    const server = http.createServer()
    const registry = new TerminalRegistry()
    const terminalCreate = vi.spyOn(registry, 'create')
    const amplifierManager = {
      hasProvider: vi.fn(() => true),
      create: vi.fn(() => {
        throw new Error('Amplifier manager must not be called')
      }),
    }
    const handler = new WsHandler(server, registry, {
      codingCliManager: amplifierManager as never,
    })
    const port = await listen(server)
    const ws = await connectAndAuthenticate(port)

    try {
      const terminalResponse = await sendAndWaitForRequest(ws, {
        type: 'terminal.create',
        requestId: 'terminal-resume-blocked',
        mode: 'amplifier',
        resumeSessionId: 'existing-amplifier-session',
      })
      const codingCliResponse = await sendAndWaitForRequest(ws, {
        type: 'codingcli.create',
        requestId: 'codingcli-resume-blocked',
        provider: 'amplifier',
        prompt: 'continue',
        resumeSessionId: 'existing-amplifier-session',
      })

      expect(terminalResponse).toMatchObject({
        type: 'error',
        code: 'INVALID_CREATE_REQUEST',
        message: EXISTING_PANES_ONLY_MESSAGE,
      })
      expect(codingCliResponse).toMatchObject({
        type: 'error',
        code: 'INVALID_CREATE_REQUEST',
        message: EXISTING_PANES_ONLY_MESSAGE,
      })
      expect(terminalCreate).not.toHaveBeenCalled()
      expect(amplifierManager.hasProvider).not.toHaveBeenCalled()
      expect(amplifierManager.create).not.toHaveBeenCalled()
    } finally {
      ws.close()
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

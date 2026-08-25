import http from 'node:http'
import {
  ConcernSessionCatalogSchema,
  ConcernSessionRecordSchema,
  type ConcernSessionCatalog,
  type ConcernSession,
} from '../shared/concern-os-contract.js'

export type ConcernOsClientOptions = {
  baseUrl?: string
  socketPath?: string
  timeoutMs?: number
}

export class ConcernOsClient {
  private readonly baseUrl: string
  private readonly socketPath?: string
  private readonly timeoutMs: number

  constructor(options: ConcernOsClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.FRESHELL_CONCERN_OS_URL ?? 'http://127.0.0.1:8483'
    this.socketPath = options.socketPath ?? process.env.FRESHELL_CONCERN_OS_SOCKET
    this.timeoutMs = options.timeoutMs ?? 3_000
  }

  async listSessions(): Promise<ConcernSessionCatalog> {
    return ConcernSessionCatalogSchema.parse(await this.getJson('/api/v1/sessions'))
  }

  async getSession(id: string): Promise<ConcernSession> {
    const canonicalId = id.includes(':') ? id : `amplifier:${id}`
    const record = ConcernSessionRecordSchema.parse(
      await this.getJson(`/api/v1/sessions/${encodeURIComponent(canonicalId)}`),
    )
    return record.item
  }

  private async getJson(pathname: string): Promise<unknown> {
    if (this.socketPath) return this.getJsonOverSocket(pathname)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(new URL(pathname, this.baseUrl), {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Concern OS returned HTTP ${response.status}`)
      return await response.json()
    } finally {
      clearTimeout(timeout)
    }
  }

  private getJsonOverSocket(pathname: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath,
        path: pathname,
        method: 'GET',
        headers: { accept: 'application/json' },
        timeout: this.timeoutMs,
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`Concern OS returned HTTP ${response.statusCode}`))
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            reject(error)
          }
        })
      })
      request.on('timeout', () => request.destroy(new Error('Concern OS request timed out')))
      request.on('error', reject)
      request.end()
    })
  }
}
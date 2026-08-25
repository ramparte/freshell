import {
  ConcernPaneSnapshotSchema,
  ConcernPaneInputResponseSchema,
  ConcernSessionCatalogSchema,
  ConcernSessionRecordSchema,
  type ConcernResolvableAttachment,
  type ConcernPaneSnapshot,
  type ConcernPaneInputResponse,
  type ConcernSession,
  type ConcernSessionCatalog,
} from '@shared/concern-os-contract'
import type { SidebarSessionItem } from '@/store/selectors/sidebarSelectors'

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`Concern OS session service returned HTTP ${response.status}`)
  }
  return response.json()
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String(payload.error)
      : `Concern OS session service returned HTTP ${response.status}`
    throw new Error(message)
  }
  return payload
}

export async function fetchConcernSessionCatalog(): Promise<ConcernSessionCatalog> {
  return ConcernSessionCatalogSchema.parse(await getJson('/api/concern-os/sessions'))
}

export async function fetchConcernSession(id: string): Promise<ConcernSession> {
  const record = ConcernSessionRecordSchema.parse(
    await getJson(`/api/concern-os/sessions/${encodeURIComponent(id)}`),
  )
  return record.item
}

export async function fetchConcernPaneSnapshot(id: string): Promise<ConcernPaneSnapshot> {
  return ConcernPaneSnapshotSchema.parse(
    await getJson(`/api/concern-os/sessions/${encodeURIComponent(id)}/pane`),
  )
}

export async function sendConcernPaneInput(
  id: string,
  sequence: number,
  data: string,
): Promise<ConcernPaneInputResponse> {
  return ConcernPaneInputResponseSchema.parse(await postJson(
    `/api/concern-os/sessions/${encodeURIComponent(id)}/pane/input`,
    { sequence, data },
  ))
}

export function getAttachableConcernPane(
  session: ConcernSession | undefined,
): ConcernResolvableAttachment | undefined {
  if (!session?.live || session.attachment?.state !== 'resolvable') return undefined
  return session.attachment
}

export type ExistingPaneRoute = 'live' | 'historical' | 'blocked'

export function routeAmplifierSession(session: ConcernSession): ExistingPaneRoute {
  if (session.live && session.attachment?.state === 'blocked') return 'blocked'
  return session.live && session.attachment?.state === 'resolvable' ? 'live' : 'historical'
}

function sidebarTimestamp(secondsOrMilliseconds: number): number {
  return secondsOrMilliseconds > 0 && secondsOrMilliseconds < 1_000_000_000_000
    ? Math.round(secondsOrMilliseconds * 1_000)
    : Math.round(secondsOrMilliseconds)
}

function pathLeaf(path: string): string | undefined {
  return path.split(/[\\/]/).filter(Boolean).at(-1)
}

/**
 * Adds Concern OS-only live records without replacing Freshell's richer
 * historical metadata. This is what makes the external catalog authoritative
 * for discoverability while preserving the existing session list.
 */
export function mergeConcernSessionItems(
  items: readonly SidebarSessionItem[],
  sessions: ReadonlyMap<string, ConcernSession>,
  query = '',
): SidebarSessionItem[] {
  const merged = [...items]
  const known = new Set(
    items
      .filter((item) => item.provider === 'amplifier')
      .map((item) => item.sessionId),
  )
  const normalizedQuery = query.trim().toLowerCase()

  for (const session of sessions.values()) {
    if (known.has(session.session_id)) continue
    const projectName = pathLeaf(session.working_dir)
    const title = session.session_id.slice(0, 8)
    if (
      normalizedQuery
      && !`${session.session_id} ${session.working_dir} ${projectName ?? ''}`
        .toLowerCase()
        .includes(normalizedQuery)
    ) {
      continue
    }
    merged.push({
      id: `session-amplifier-${session.session_id}`,
      sessionId: session.session_id,
      provider: 'amplifier',
      sessionType: 'amplifier',
      title,
      subtitle: projectName,
      projectPath: session.working_dir || undefined,
      timestamp: sidebarTimestamp(session.last_activity_at),
      cwd: session.working_dir || undefined,
      hasTab: false,
      isRunning: session.live,
      hasTitle: false,
      liveTerminalOnly: !session.historical,
      isRestorable: false,
    })
  }
  return merged
}

const ATTENTION_RANK: Record<NonNullable<ConcernSession['attention']>['state'], number> = {
  needs: 4,
  ready: 3,
  working: 2,
  idle: 1,
}

export function sortByConcernAttention<T extends { provider?: string; sessionId: string }>(
  items: readonly T[],
  sessions: ReadonlyMap<string, ConcernSession>,
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aAttention = a.item.provider === 'amplifier'
        ? sessions.get(a.item.sessionId)?.attention
        : undefined
      const bAttention = b.item.provider === 'amplifier'
        ? sessions.get(b.item.sessionId)?.attention
        : undefined
      const rankDelta = (bAttention ? ATTENTION_RANK[bAttention.state] : 0)
        - (aAttention ? ATTENTION_RANK[aAttention.state] : 0)
      if (rankDelta !== 0) return rankDelta
      const severityDelta = (bAttention?.severity ?? 0) - (aAttention?.severity ?? 0)
      return severityDelta !== 0 ? severityDelta : a.index - b.index
    })
    .map(({ item }) => item)
}
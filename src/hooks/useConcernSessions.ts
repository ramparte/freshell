import { useEffect, useMemo, useState } from 'react'
import { fetchConcernSessionCatalog } from '@/lib/concern-os-sessions'
import type { ConcernSession } from '@shared/concern-os-contract'

const POLL_MS = 2_000

export function useConcernSessions(): {
  bySessionId: ReadonlyMap<string, ConcernSession>
  error?: string
} {
  const [items, setItems] = useState<ConcernSession[]>([])
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    let hasLoaded = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      try {
        const catalog = await fetchConcernSessionCatalog()
        if (!cancelled) {
          hasLoaded = true
          setItems(catalog.items)
          setError(undefined)
        }
      } catch (nextError) {
        // The Concern OS catalog is optional. Keep the normal Freshell sidebar
        // unchanged when it is unavailable during initial startup, and only
        // surface an outage after a catalog has previously loaded.
        if (!cancelled && hasLoaded) {
          setError(nextError instanceof Error ? nextError.message : 'Concern OS session service unavailable')
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS)
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const bySessionId = useMemo(
    () => new Map(items.map((item) => [item.session_id, item])),
    [items],
  )
  return { bySessionId, error }
}
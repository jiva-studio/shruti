import { ref, type Ref } from 'vue'
import { useWebAuth } from './useWebAuth'
import type { RemoteChat, RemoteChatMessage, RemoteMerge } from './useChatHistory'

// ---------------------------------------------------------------------------
// Wire contract (snake_case, exactly as the `profile` service emits it).
// Mirrors docs/repos/shruti/architecture/profile-sync.md → "Wire contract".
// The web app doesn't share the mobile `servers.ts` / `libs/contracts/sync`, so
// these read-only types live here. `data` is an opaque JSON blob to transport;
// we narrow it per collection below.
// ---------------------------------------------------------------------------

interface Change {
  server_seq?: number
  collection: string
  doc_id: string
  op: 'upsert' | 'delete'
  data?: unknown
  hlc: string
}

interface PullResponse {
  changes: Change[]
  cursor: number
  has_more: boolean
}

/** `chat_sessions` row shipped back untouched (the client-native user.db row). */
interface ChatSessionData {
  title?: string | null
  track_id?: string | null
  created_at?: string | number | null
  updated_at?: string | number | null
}

/** `chat_messages` row. `meta` is the versioned `{_v, data}` envelope — ignored
 *  by this read-only v1, which only surfaces role + content as plain text. */
interface ChatMessageData {
  session_id?: string
  role?: string
  content?: string
  meta?: { _v?: number; data?: unknown } | null
  created_at?: string | number | null
}

const CHAT_SESSIONS = 'chat_sessions'
const CHAT_MESSAGES = 'chat_messages'
const PULL_LIMIT = 200
const MAX_PAGES = 50 // hard stop against a runaway has_more loop

interface StoredCursor {
  userId: string
  cursor: number
}

/** ISO-8601 string or epoch → ms. Numbers under ~1e12 are treated as seconds. */
function toMs(v: string | number | null | undefined): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const n = Date.parse(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

export interface UseProfileSyncOptions {
  profileBaseUrl: string
  /** Namespaces the local pull cursor; pass the chat-history storage key so a
   *  ru/en surface each track their own progress. */
  storageKey: string
  /** Injected from useChatHistory — the read-only merge target. */
  merge: (remote: RemoteMerge) => void
}

export interface UseProfileSync {
  syncing: Ref<boolean>
  /** Pull the signed-in user's chat sessions from `profile` and merge them into
   *  the local chat history. No-ops for anonymous/signed-out users. Read-only:
   *  never pushes and never acks a server cursor. */
  pullChatSessions: () => Promise<void>
}

export function useProfileSync(opts: UseProfileSyncOptions): UseProfileSync {
  const auth = useWebAuth()
  const syncing = ref(false)
  const cursorKey = `${opts.storageKey}.profileCursor`

  function readCursor(userId: string): number {
    try {
      const raw = localStorage.getItem(cursorKey)
      if (!raw) return 0
      const parsed = JSON.parse(raw) as StoredCursor
      // A different account on this browser must re-sync from scratch.
      return parsed.userId === userId ? parsed.cursor || 0 : 0
    } catch {
      return 0
    }
  }

  function writeCursor(userId: string, cursor: number): void {
    try {
      localStorage.setItem(cursorKey, JSON.stringify({ userId, cursor } satisfies StoredCursor))
    } catch {
      /* private mode / quota — incremental resume just falls back to a full pull */
    }
  }

  async function pullChatSessions(): Promise<void> {
    if (syncing.value) return
    // Only signed-in (non-anonymous) accounts sync. hydrate() reads the
    // persisted session without a network call so a page load that already
    // holds a real token is recognised immediately.
    auth.hydrate()
    if (!auth.signedIn.value) return
    const userId = auth.session.value?.userId
    if (!userId) return

    syncing.value = true
    try {
      const base = opts.profileBaseUrl.replace(/\/$/, '')
      if (!base) return
      const token = await auth.ensureToken()

      let cursor = readCursor(userId)
      const changes: Change[] = []
      for (let page = 0; page < MAX_PAGES; page++) {
        let res: Response
        try {
          res = await fetch(`${base}/profile/sync/pull`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ cursor, limit: PULL_LIMIT }),
          })
        } catch {
          return // network/service down — leave local cache untouched
        }
        if (!res.ok) return // 403 anon / 5xx / not-yet-deployed — silent no-op
        let body: PullResponse
        try {
          body = (await res.json()) as PullResponse
        } catch {
          return
        }
        for (const c of body.changes ?? []) changes.push(c)
        cursor = body.cursor ?? cursor
        if (!body.has_more) break
      }

      if (changes.length) applyChanges(changes)
      // Persist the advanced cursor for an incremental next pull.
      writeCursor(userId, cursor)
    } finally {
      syncing.value = false
    }
  }

  function applyChanges(changes: Change[]): void {
    // Changes arrive ordered by server_seq, so a session precedes its messages
    // (parent-before-child) — reduce them into the final per-session state.
    const sessions = new Map<string, { title: string | null; updatedAt: number; trackId: string | null }>()
    const deletes = new Set<string>()
    const msgs = new Map<string, Map<string, RemoteChatMessage>>()

    for (const c of changes) {
      if (c.collection === CHAT_SESSIONS) {
        if (c.op === 'delete') {
          sessions.delete(c.doc_id)
          msgs.delete(c.doc_id)
          deletes.add(c.doc_id)
        } else {
          const d = (c.data ?? {}) as ChatSessionData
          sessions.set(c.doc_id, {
            title: typeof d.title === 'string' && d.title.trim() ? d.title : null,
            updatedAt: toMs(d.updated_at) || toMs(d.created_at),
            trackId: d.track_id ?? null,
          })
          deletes.delete(c.doc_id)
        }
      } else if (c.collection === CHAT_MESSAGES) {
        const d = (c.data ?? {}) as ChatMessageData
        const sid = d.session_id
        if (!sid) continue
        // Orphan-drop: never resurrect a message onto a tombstoned session.
        if (deletes.has(sid)) continue
        if (c.op === 'delete') {
          msgs.get(sid)?.delete(c.doc_id)
          continue
        }
        if (d.role !== 'user' && d.role !== 'assistant') continue
        let bucket = msgs.get(sid)
        if (!bucket) {
          bucket = new Map()
          msgs.set(sid, bucket)
        }
        bucket.set(c.doc_id, {
          id: c.doc_id,
          role: d.role,
          text: typeof d.content === 'string' ? d.content : '',
          createdAt: toMs(d.created_at),
        })
      }
      // All other collections (playlist_items, listening_sessions, notes) are
      // out of scope for the web client — ignored.
    }

    const ids = new Set<string>([...sessions.keys(), ...msgs.keys()])
    const upserts: RemoteChat[] = []
    for (const id of ids) {
      if (deletes.has(id)) continue
      const s = sessions.get(id)
      const bucket = msgs.get(id)
      const messages = bucket
        ? [...bucket.values()].sort((a, b) => a.createdAt - b.createdAt)
        : []
      upserts.push({
        id,
        hasSession: !!s,
        title: s?.title ?? null,
        updatedAt: s?.updatedAt || (messages.length ? messages[messages.length - 1].createdAt : 0),
        trackId: s?.trackId ?? null,
        messages,
      })
    }

    opts.merge({ upserts, deletes: [...deletes] })
  }

  return { syncing, pullChatSessions }
}

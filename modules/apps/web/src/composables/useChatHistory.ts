import { onMounted, ref, watch, type Ref } from 'vue'
import type { Msg } from './useChatStream'
import type { SnapshotChat } from './sync/profileSyncCore'

/** Lightweight index entry shown in the sidebar list. */
export interface ChatMeta {
  id: string
  title: string
  updatedAt: number
}

interface StoredChat extends ChatMeta {
  /** Session creation time (unix ms) — the sync `created_at`. */
  createdAt?: number
  messages: SerializedMsg[]
}

export interface SerializedMsg {
  role: 'user' | 'assistant'
  text: string
  /** Stable message id (sync doc_id). Assigned at first persist; always
   *  present for stored messages, optional only on a freshly-built value. */
  id?: string
  /** Message creation time (unix ms) — the sync `created_at`. */
  createdAt?: number
  statusKey?: string
  aliases?: Record<string, unknown>
  researchQuestions?: string[]
  // Serialized Map fields live here as [key, value] entry arrays.
  [field: string]: unknown
}

/** A single chat message pulled from the `profile` service. Carries a stable
 *  server `id` and `createdAt` so mergeRemote can dedupe/order across
 *  incremental pulls (both are persisted but ignored by deserializeMsg, so they
 *  never leak into the live Msg). */
export interface RemoteChatMessage extends SerializedMsg {
  id: string
  createdAt: number
}

/** One server chat session to merge into the local store. `hasSession` is false
 *  when this pull carried only *messages* for the session (an incremental
 *  append) and no `chat_sessions` change — mergeRemote then keeps the existing
 *  session's fields and drops it entirely if the session is unknown locally
 *  (orphan-drop). */
export interface RemoteChat {
  id: string
  hasSession: boolean
  title: string | null
  updatedAt: number
  createdAt?: number
  trackId?: string | null
  messages: RemoteChatMessage[]
}

export interface RemoteMerge {
  upserts: RemoteChat[]
  deletes: string[]
}

// Rich payloads on a Msg are Vue-reactive Maps, which JSON.stringify flattens to
// `{}`. Round-trip them through entry arrays so cards/verses survive a reload.
const MAP_FIELDS = [
  'researchSources', 'verses', 'chapters', 'cites', 'cards',
  'commentaries', 'media', 'outlines', 'pdfActions',
] as const

function serializeMsg(m: Msg): SerializedMsg {
  const o: SerializedMsg = { role: m.role, text: m.text }
  if (m.id) o.id = m.id
  if (typeof m.createdAt === 'number') o.createdAt = m.createdAt
  if (m.statusKey) o.statusKey = m.statusKey
  if (m.traceId) o.traceId = m.traceId
  if (m.aliases) o.aliases = m.aliases
  if (m.researchQuestions?.length) o.researchQuestions = m.researchQuestions
  const src = m as unknown as Record<string, Map<string, unknown> | undefined>
  for (const f of MAP_FIELDS) {
    const map = src[f]
    if (map && map.size) o[f] = [...map.entries()]
  }
  return o
}

function deserializeMsg(o: SerializedMsg): Msg {
  const m: Record<string, unknown> = { role: o.role, text: o.text, streaming: false }
  if (o.id) m.id = o.id
  if (typeof o.createdAt === 'number') m.createdAt = o.createdAt
  if (o.statusKey) m.statusKey = o.statusKey
  if (o.traceId) m.traceId = o.traceId
  if (o.aliases) m.aliases = o.aliases
  m.researchQuestions = o.researchQuestions ?? []
  for (const f of MAP_FIELDS) {
    m[f] = new Map((o[f] as [string, unknown][] | undefined) ?? [])
  }
  return m as unknown as Msg
}

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `c_${Date.now().toString(36)}_${Math.round(Math.random() * 1e9).toString(36)}`
  }
}

export interface UseChatHistory {
  chats: Ref<ChatMeta[]>
  currentId: Ref<string>
  newChat: () => void
  openChat: (id: string) => void
  deleteChat: (id: string) => void
  /** Union server-sourced chat sessions/messages into the local store without
   *  clobbering local-only sessions. Server is authoritative on the fields it
   *  provides (title, updatedAt, its messages); the current localStorage
   *  history stays the local cache. Applied for BOTH the initial pull and the
   *  master-wins side of a push conflict — never re-emits as a local change. */
  mergeRemote: (remote: RemoteMerge) => void
  /** Full current history as sync snapshot units, for the sync engine's
   *  outbox diff. */
  snapshot: () => SnapshotChat[]
}

/**
 * Client-side persistence for the /ai chat: keeps a list of past conversations
 * (with their full messages) in localStorage, and drives the sidebar list.
 * Owns the `messages` ref borrowed from useChatStream — it swaps its contents to
 * switch/clear conversations; send() keeps appending to the same ref.
 */
export function useChatHistory(
  messages: Ref<Msg[]>,
  opts: { storageKey: string; busy?: Ref<boolean>; onLocalChange?: () => void },
): UseChatHistory {
  const chats = ref<ChatMeta[]>([])
  const currentId = ref('')
  const store = new Map<string, StoredChat>()
  const MAX_CHATS = 40
  /** localStorage envelope version. v2 adds per-message `id`/`createdAt` and a
   *  session `createdAt` so the history is syncable; v1 rows are migrated on
   *  load. */
  const STORE_V = 2

  const canPersist = () => typeof window !== 'undefined' && !!window.localStorage

  function refreshIndex() {
    chats.value = [...store.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CHATS)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
  }

  /** Assign a stable id + strictly-increasing createdAt to any message that
   *  lacks one, in place, preserving array order. Mutates the live objects so
   *  the ids persist and stay stable across reloads. */
  function stampMessageIds(msgs: Array<{ id?: string; createdAt?: number }>, floor = 0) {
    let last = floor
    for (const m of msgs) {
      if (!m.id) m.id = newId()
      let c = typeof m.createdAt === 'number' ? m.createdAt : Date.now()
      if (c <= last) c = last + 1
      m.createdAt = c
      last = c
    }
  }

  /** Bring a stored chat up to the v2 shape: session createdAt + per-message
   *  id/createdAt. Idempotent (already-stamped rows are untouched). */
  function migrateChat(c: StoredChat) {
    if (typeof c.createdAt !== 'number') c.createdAt = c.updatedAt ?? Date.now()
    stampMessageIds(c.messages, c.createdAt - 1)
  }

  function load() {
    if (!canPersist()) return
    try {
      const raw = localStorage.getItem(opts.storageKey)
      if (!raw) return
      const parsed = JSON.parse(raw) as { v: number; chats: StoredChat[] }
      store.clear()
      for (const c of parsed?.chats ?? []) {
        migrateChat(c)
        store.set(c.id, c)
      }
      refreshIndex()
      // Persist the migration so the freshly-minted ids are stable next load.
      if ((parsed?.v ?? 1) < STORE_V) flush()
    } catch {
      /* corrupt storage — start clean rather than crash the island */
    }
  }

  function flush() {
    if (!canPersist()) return
    const all = [...store.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHATS)
    try {
      localStorage.setItem(opts.storageKey, JSON.stringify({ v: STORE_V, chats: all }))
    } catch {
      /* quota exceeded — best effort */
    }
  }

  function titleFrom(msgs: Msg[]): string {
    const first = msgs.find((m) => m.role === 'user' && m.text)
    const t = (first?.text ?? '').trim().replace(/\s+/g, ' ')
    return t.length > 48 ? `${t.slice(0, 48)}…` : t || '…'
  }

  /** Content fingerprint of a conversation — message ids, roles and text
   *  lengths. Stable across a re-open (chat is append-only), so it distinguishes
   *  a real edit (new/grown message) from merely navigating to a chat. */
  function contentSig(msgs: ReadonlyArray<{ id?: string; role: string; text: string }>): string {
    return msgs.map((m) => `${m.id ?? ''}:${m.role}:${(m.text ?? '').length}`).join('|')
  }

  function persistNow() {
    // Drop the empty streaming placeholder so an interrupted turn isn't stored.
    const keep = messages.value.filter((m) => m.role === 'user' || m.text)
    if (!keep.length) return
    if (!currentId.value) currentId.value = newId()
    const prev = store.get(currentId.value)
    // Stamp stable ids + createdAt onto the LIVE messages so they persist and
    // sync consistently. Floor at the session start so ids order after it.
    const sessionCreatedAt = prev?.createdAt ?? Date.now()
    stampMessageIds(keep, sessionCreatedAt - 1)
    // Opening / switching chats re-runs persist with identical content. Only a
    // real content change bumps `updatedAt` and triggers a sync — otherwise just
    // selecting a chat would re-push it and reorder it on other devices.
    if (prev && contentSig(prev.messages) === contentSig(keep)) return
    store.set(currentId.value, {
      id: currentId.value,
      title: titleFrom(keep),
      createdAt: sessionCreatedAt,
      updatedAt: Date.now(),
      messages: keep.map(serializeMsg),
    })
    refreshIndex()
    flush()
    opts.onLocalChange?.()
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  function persistSoon() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(persistNow, 250)
  }

  function loadInto(id: string) {
    const c = store.get(id)
    if (!c) return
    currentId.value = id
    messages.value = c.messages.map(deserializeMsg)
  }

  function newChat() {
    persistNow() // save whatever's open before clearing
    currentId.value = ''
    messages.value = []
  }

  function openChat(id: string) {
    if (id === currentId.value) return
    persistNow()
    loadInto(id)
  }

  function deleteChat(id: string) {
    store.delete(id)
    if (currentId.value === id) {
      currentId.value = ''
      messages.value = []
    }
    refreshIndex()
    flush()
    opts.onLocalChange?.()
  }

  function titleFromSerialized(msgs: SerializedMsg[]): string {
    const first = msgs.find((m) => m.role === 'user' && m.text)
    const t = (first?.text ?? '').trim().replace(/\s+/g, ' ')
    return t.length > 48 ? `${t.slice(0, 48)}…` : t || '…'
  }

  function mergeRemote(remote: RemoteMerge) {
    let changed = false

    // Tombstones first: a deleted session drops it (and, via this same store,
    // its messages — no per-message tombstones on the wire).
    for (const id of remote.deletes) {
      if (store.delete(id)) {
        changed = true
        if (currentId.value === id) {
          currentId.value = ''
          messages.value = []
        }
      }
    }

    for (const rc of remote.upserts) {
      const prev = store.get(rc.id)
      // Orphan-drop: messages arrived for a session we've never seen and this
      // pull carried no session row for it → nothing to attach them to.
      if (!rc.hasSession && !prev) continue

      // Preserve previously-synced server messages (they carry a stable id) and
      // union in this pull's messages, deduped by id, ordered by createdAt. A
      // purely local session shares no ids with the server, so its content is
      // untouched unless the same id is authoritative on the server too.
      const byId = new Map<string, RemoteChatMessage>()
      if (prev) {
        for (const m of prev.messages) {
          const mid = (m as Partial<RemoteChatMessage>).id
          if (typeof mid === 'string') byId.set(mid, m as RemoteChatMessage)
        }
      }
      for (const m of rc.messages) byId.set(m.id, m)
      const merged = [...byId.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))

      const title =
        (rc.hasSession ? rc.title : null) ??
        prev?.title ??
        titleFromSerialized(merged)
      store.set(rc.id, {
        id: rc.id,
        title,
        createdAt:
          prev?.createdAt ?? rc.createdAt ?? merged[0]?.createdAt ?? Date.now(),
        updatedAt: Math.max(rc.updatedAt || 0, prev?.updatedAt || 0) || Date.now(),
        messages: merged,
      })
      changed = true
    }

    if (changed) {
      refreshIndex()
      flush()
    }
  }

  function snapshot(): SnapshotChat[] {
    return [...store.values()].map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      createdAt: c.createdAt,
      messages: c.messages,
    }))
  }

  onMounted(() => {
    // Populate the sidebar list, but LAND ON THE WELCOME SCREEN — do not
    // auto-reopen the last conversation. Opening /ai should invite a fresh
    // question; past chats stay one click away in the sidebar.
    load()
  })

  // Persist on transcript growth and at each turn boundary (busy → idle).
  watch(() => messages.value.length, persistSoon)
  if (opts.busy) watch(opts.busy, (b) => { if (!b) persistSoon() })

  return { chats, currentId, newChat, openChat, deleteChat, mergeRemote, snapshot }
}

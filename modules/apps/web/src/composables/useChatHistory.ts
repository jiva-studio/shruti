import { onMounted, ref, watch, type Ref } from 'vue'
import type { Msg } from './useChatStream'

/** Lightweight index entry shown in the sidebar list. */
export interface ChatMeta {
  id: string
  title: string
  updatedAt: number
}

interface StoredChat extends ChatMeta {
  messages: SerializedMsg[]
}

export interface SerializedMsg {
  role: 'user' | 'assistant'
  text: string
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
   *  history stays the local cache. Read-only sync — never pushes. */
  mergeRemote: (remote: RemoteMerge) => void
}

/**
 * Client-side persistence for the /ai chat: keeps a list of past conversations
 * (with their full messages) in localStorage, and drives the sidebar list.
 * Owns the `messages` ref borrowed from useChatStream — it swaps its contents to
 * switch/clear conversations; send() keeps appending to the same ref.
 */
export function useChatHistory(
  messages: Ref<Msg[]>,
  opts: { storageKey: string; busy?: Ref<boolean> },
): UseChatHistory {
  const chats = ref<ChatMeta[]>([])
  const currentId = ref('')
  const store = new Map<string, StoredChat>()
  const MAX_CHATS = 40

  const canPersist = () => typeof window !== 'undefined' && !!window.localStorage

  function refreshIndex() {
    chats.value = [...store.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CHATS)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
  }

  function load() {
    if (!canPersist()) return
    try {
      const raw = localStorage.getItem(opts.storageKey)
      if (!raw) return
      const parsed = JSON.parse(raw) as { v: number; chats: StoredChat[] }
      store.clear()
      for (const c of parsed?.chats ?? []) store.set(c.id, c)
      refreshIndex()
    } catch {
      /* corrupt storage — start clean rather than crash the island */
    }
  }

  function flush() {
    if (!canPersist()) return
    const all = [...store.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHATS)
    try {
      localStorage.setItem(opts.storageKey, JSON.stringify({ v: 1, chats: all }))
    } catch {
      /* quota exceeded — best effort */
    }
  }

  function titleFrom(msgs: Msg[]): string {
    const first = msgs.find((m) => m.role === 'user' && m.text)
    const t = (first?.text ?? '').trim().replace(/\s+/g, ' ')
    return t.length > 48 ? `${t.slice(0, 48)}…` : t || '…'
  }

  function persistNow() {
    // Drop the empty streaming placeholder so an interrupted turn isn't stored.
    const keep = messages.value.filter((m) => m.role === 'user' || m.text)
    if (!keep.length) return
    if (!currentId.value) currentId.value = newId()
    store.set(currentId.value, {
      id: currentId.value,
      title: titleFrom(keep),
      updatedAt: Date.now(),
      messages: keep.map(serializeMsg),
    })
    refreshIndex()
    flush()
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

  onMounted(() => {
    load()
    // Reopen the most recent conversation so a refresh doesn't lose context.
    const latest = chats.value[0]
    if (latest) loadInto(latest.id)
  })

  // Persist on transcript growth and at each turn boundary (busy → idle).
  watch(() => messages.value.length, persistSoon)
  if (opts.busy) watch(opts.busy, (b) => { if (!b) persistSoon() })

  return { chats, currentId, newChat, openChat, deleteChat, mergeRemote }
}

import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { useWebAuth } from './useWebAuth'
import type { RemoteChat, RemoteChatMessage, RemoteMerge } from './useChatHistory'
import { createWebSyncClient } from './sync/webSyncClient'
import {
  adoptBaseline,
  applyPushResponse,
  buildPushItems,
  diffOutbox,
  newState,
  outboxEmpty,
  reducePull,
  type MergePlan,
  type SnapshotChat,
  type SyncState,
} from './sync/profileSyncCore'

// ---------------------------------------------------------------------------
// Two-way chat sync against the `profile` service. This composable is the IO
// shell around the pure engine (`sync/profileSyncCore`): it persists the sync
// state in localStorage, drives the HTTP client, and applies the engine's
// merge plan to the local chat history via `merge` (useChatHistory.mergeRemote).
//
// A cycle: pull every page (advancing the cursor) → ack → diff the local
// history into the outbox → push → resolve conflicts (LWW). Runs on mount, on
// sign-in, on a light interval, and — debounced — after any local mutation.
// No-ops while signed-out / anonymous or without a configured base URL.
// ---------------------------------------------------------------------------

const PULL_LIMIT = 200
const MAX_PAGES = 50 // hard stop against a runaway has_more loop
const MAX_PUSH_ROUNDS = 3 // re-push rounds for local-wins conflicts
const DEBOUNCE_MS = 1500
const INTERVAL_MS = 60 * 1000

export interface UseProfileSyncOptions {
  /** `profile` service base; empty ⇒ the whole engine no-ops. */
  profileBaseUrl: string
  /** Namespaces the persisted sync state per chat-history surface (ru/en). */
  storageKey: string
  /** Snapshot of the local chat history for the outbox diff. */
  snapshot: () => SnapshotChat[]
  /** Apply the engine's merge plan (remote + master-wins) to the history. */
  merge: (remote: RemoteMerge) => void
}

export interface UseProfileSync {
  syncing: Ref<boolean>
  /** Run a full pull+push cycle now. No-ops for anonymous/signed-out. */
  sync: () => Promise<void>
  /** Coalesced trigger for a cycle after a local mutation. */
  requestSync: () => void
}

interface PersistedSync {
  userId: string
  state: SyncState
}

/** The signed-in account changed while a cycle was running. */
class OwnerChangedError extends Error {
  constructor() {
    super("profile-sync: account changed mid-cycle")
    this.name = "OwnerChangedError"
  }
}

function makeDeviceId(): string {
  try {
    return `web-${crypto.randomUUID()}`
  } catch {
    return `web-${Date.now().toString(36)}-${Math.round(Math.random() * 1e9).toString(36)}`
  }
}

export function useProfileSync(opts: UseProfileSyncOptions): UseProfileSync {
  const auth = useWebAuth()
  const syncing = ref(false)
  const base = opts.profileBaseUrl.replace(/\/$/, '')
  const SYNC_KEY = `${opts.storageKey}.sync`
  const DEVICE_KEY = `${opts.storageKey}.deviceId`

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let interval: ReturnType<typeof setInterval> | null = null
  /** A trigger arrived mid-cycle; one more cycle runs when it ends. */
  let rerunRequested = false
  let disposed = false

  function canPersist(): boolean {
    return typeof window !== 'undefined' && !!window.localStorage
  }

  function loadDeviceId(): string {
    if (!canPersist()) return makeDeviceId()
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) {
      id = makeDeviceId()
      try {
        localStorage.setItem(DEVICE_KEY, id)
      } catch {
        /* private mode — a per-session id is still fine */
      }
    }
    return id
  }

  /**
   * Load the persisted sync state for this account. A fresh state (first run
   * OR a different account signing in on this browser) starts at cursor 0 with
   * an empty outbox/signature map — so the next diff re-pulls the account's
   * history AND backfills the existing local chats under it, mirroring the
   * mobile "the local rows belong to whoever signs in on this device" rule.
   */
  function loadStateFor(userId: string): SyncState {
    if (canPersist()) {
      try {
        const raw = localStorage.getItem(SYNC_KEY)
        if (raw) {
          const parsed = JSON.parse(raw) as PersistedSync | null
          if (parsed?.userId === userId && parsed.state) {
            return reviveState(parsed.state)
          }
        }
      } catch {
        /* corrupt — fall through to a fresh state */
      }
    }
    return newState(loadDeviceId())
  }

  function reviveState(s: Partial<SyncState>): SyncState {
    const fresh = newState(s.deviceId || loadDeviceId())
    return {
      deviceId: fresh.deviceId,
      lastHlc: typeof s.lastHlc === 'string' ? s.lastHlc : null,
      cursor: typeof s.cursor === 'number' ? s.cursor : 0,
      docHlc: s.docHlc && typeof s.docHlc === 'object' ? s.docHlc : {},
      sessionSig: s.sessionSig && typeof s.sessionSig === 'object' ? s.sessionSig : {},
      outbox: Array.isArray(s.outbox) ? s.outbox : [],
    }
  }

  function saveState(userId: string, state: SyncState): void {
    if (!canPersist()) return
    try {
      localStorage.setItem(SYNC_KEY, JSON.stringify({ userId, state } satisfies PersistedSync))
    } catch {
      /* quota / private mode — the cycle still works in-memory this session */
    }
  }

  function enabled(): boolean {
    if (!base) return false
    auth.hydrate()
    return auth.signedIn.value && !!auth.session.value?.userId
  }

  /** Translate the engine's merge plan into a `RemoteMerge` for the history. */
  function applyPlan(plan: MergePlan): void {
    if (
      plan.sessionUpserts.length === 0 &&
      plan.messageUpserts.length === 0 &&
      plan.sessionDeletes.length === 0
    ) {
      return
    }
    const bySession = new Map<string, RemoteChat>()
    for (const s of plan.sessionUpserts) {
      bySession.set(s.id, {
        id: s.id,
        hasSession: true,
        title: s.title,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
        trackId: s.trackId,
        messages: [],
      })
    }
    for (const mu of plan.messageUpserts) {
      let rc = bySession.get(mu.sessionId)
      if (!rc) {
        rc = { id: mu.sessionId, hasSession: false, title: null, updatedAt: 0, messages: [] }
        bySession.set(mu.sessionId, rc)
      }
      rc.messages.push(mu.msg as RemoteChatMessage)
    }
    opts.merge({ upserts: [...bySession.values()], deletes: plan.sessionDeletes })
  }

  async function sync(): Promise<void> {
    if (disposed) return
    if (syncing.value) {
      rerunRequested = true
      return
    }
    if (!enabled()) return
    const userId = auth.session.value?.userId
    if (!userId) return

    // Every step after an await re-checks the account: a cycle outlives the
    // identity it started under, and the transport sends whatever token is
    // current. A token minted for another account is refused before it leaves.
    const assertOwner = (): void => {
      if (auth.session.value?.userId !== userId) throw new OwnerChangedError()
    }
    const client = createWebSyncClient({
      baseUrl: base,
      getToken: async () => {
        const token = await auth.ensureToken()
        assertOwner()
        return token
      },
    })

    syncing.value = true
    try {
      const state = loadStateFor(userId)

      // 1. Diff the local history into the outbox FIRST, so a local delete is
      //    recorded before the pull — otherwise the server's echo of the
      //    session's own create would resurrect it.
      diffOutbox(state, opts.snapshot(), Date.now())

      // 2. Pull every page since the cursor, merging as we go. `reducePull`
      //    guards against echoes superseding pending local writes.
      for (let page = 0; page < MAX_PAGES; page++) {
        const resp = await client.pull({ cursor: state.cursor, limit: PULL_LIMIT })
        assertOwner()
        applyPlan(reducePull(state, resp))
        state.cursor = typeof resp.cursor === 'number' ? resp.cursor : state.cursor
        if (!resp.has_more) break
      }
      // Seed baselines for just-merged sessions so a later local edit enqueues.
      adoptBaseline(state, opts.snapshot())
      // Acknowledge the applied cursor (drives server-side log compaction).
      try {
        await client.ackCursor({ device_id: state.deviceId, acked_seq: state.cursor })
      } catch (err) {
        if (err instanceof OwnerChangedError) throw err
        /* non-fatal */
      }
      assertOwner()
      saveState(userId, state)

      // 3. Push, re-pushing local-wins conflicts with the fresh base HLC.
      for (let round = 0; round < MAX_PUSH_ROUNDS && !outboxEmpty(state); round++) {
        const items = buildPushItems(state)
        if (items.length === 0) break
        const resp = await client.push({ device_id: state.deviceId, changes: items })
        assertOwner()
        applyPlan(applyPushResponse(state, resp))
        saveState(userId, state)
        // No conflicts to re-merge → the outbox is either drained or waiting
        // on nothing this engine can resolve; stop.
        if (!resp.conflicts || resp.conflicts.length === 0) break
      }
    } catch (err) {
      // The next cycle runs under the account that is signed in now.
      if (err instanceof OwnerChangedError) {
        rerunRequested = true
        return
      }
      // Network / service down / not-yet-deployed — leave the local cache and
      // any persisted progress as-is; the next trigger retries idempotently.
      console.warn('[profile-sync] cycle failed', err)
    } finally {
      syncing.value = false
      if (rerunRequested) {
        rerunRequested = false
        void sync()
      }
    }
  }

  function requestSync(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => void sync(), DEBOUNCE_MS)
  }

  onMounted(() => {
    interval = setInterval(() => void sync(), INTERVAL_MS)
  })
  onBeforeUnmount(() => {
    disposed = true
    rerunRequested = false
    if (debounceTimer) clearTimeout(debounceTimer)
    if (interval) clearInterval(interval)
    debounceTimer = null
    interval = null
  })

  return { syncing, sync, requestSync }
}

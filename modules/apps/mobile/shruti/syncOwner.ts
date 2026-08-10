/**
 * Resolves the account an outbox row should be attributed to (#1497).
 *
 * The obvious reading — "whoever the auth port says is signed in" — has a
 * hole. Both `signOut()` and `deleteAccount()` do `applySession(null)` and
 * then `await restore()`, and `restore()` is a network round-trip to
 * `/auth/anonymous`. For that whole window there is no session, while writes
 * keep being journaled: the listening tracker alone finishes a session every
 * 15 s during playback. Stamping those rows `null` would leave them
 * unattributed, and the next identity change retires unattributed rows
 * wholesale — the same silent loss the owner stamp exists to prevent.
 *
 * So the provider is sticky: while the session is absent it keeps returning
 * the last identity it saw. A write in that window belongs to the account on
 * its way OUT (the playback it finishes was that account's), never to the one
 * arriving — which is also the safe direction, since misattributing to the
 * outgoing account retires the row, while misattributing to the incoming one
 * would upload it under a stranger.
 *
 * Returns `null` only before any identity has ever been observed — a first
 * cold boot, where the rows genuinely have no owner yet.
 */
export function createOwnerIdProvider(getUserId: () => string | null): () => string | null {
  let lastSeen: string | null = null
  return () => {
    const current = getUserId()
    if (current !== null) lastSeen = current
    return current ?? lastSeen
  }
}

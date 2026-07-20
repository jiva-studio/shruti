# Personal library — compliance & takedown runbook

Letting users add internet lectures makes the app a **user-generated-content (UGC)** app, so the **public-promotion** phase (an admin pushing a user-added track into the shared corpus) must satisfy App Store guideline 1.2 and Google Play's UGC policy, plus copyright law. The **private** phase (a lecture visible only to the user who added it) is low store-policy risk but still carries a copyright question about hosting third-party audio. This runbook is the checklist that gates enabling each phase, and the one technical piece engineering owns — the **takedown/depublish** path. See the architecture in [Personal library](../architecture/personal-library.md).

> **Status: gate, not yet cleared.** Nothing here is a substitute for legal counsel. Treat each unchecked box as a blocker for the phase it belongs to.

## Phase 1 — private library (gate before enabling ingest)

- [ ] **Copyright — private hosting.** We store copies of third-party lecture audio at an unlisted-but-**public** CDN path (content-hash id, no signing). This is a weaker "personal use" posture than truly-private storage. **Legal go/no-go required.** If declined, fall back to a private S3 prefix + signed URLs (the architecture carries this fallback).
- [ ] **PRO-gating confirmed.** Ingest is PRO-only; anonymous/free cannot reach it (closes the abuse/cost vector). Verified in both `chat` (affordance) and `orchestrator` (JWT re-verify).
- [ ] **Privacy policy** mentions the processing chain (audio sent to Deepgram for transcription; stored on our CDN).

## Phase 2 — public promotion (gate before enabling the admin promote path)

- [ ] **DMCA / takedown path exists and is tested** (the technical piece — see below).
- [ ] **EULA / Terms** updated: the user is responsible for content they add; on promotion they grant us a license to redistribute; the takedown process is described; repeat-infringer policy stated.
- [ ] **Rights basis per promoted lecture.** Admin judgment is **not** a rights basis on its own. Each promoted talk needs one of: speaker/organization permission, a compatible licence (e.g. CC), or public domain. Record the basis with the promotion.
- [ ] **Moderation mechanism documented** — promotion is admin-gated; the human review IS the App Store 1.2 / Play UGC "filter objectionable content + act on reports" mechanism. Curated publishing is safer than open user-to-user sharing; state this in the App Store review notes.
- [ ] **Reporting channel** — a published contact/way for rights holders and users to report content.
- [ ] **Legal sign-off** on the above before the promote tools are enabled in production.

## Takedown / depublish (engineering-owned)

Promotion (`library.approve`) is the forward path: it commits the track into the corpus catalog and publishes it. Takedown is its **inverse** and must be equally cheap:

1. **Remove from the catalog** — a `library.depublish <track_id>` admin op that deletes the track's rows from the corpus DB (the inverse of `track.commit`) and re-runs `catalog.publish`, so the next `lectorium.{version}.db` no longer contains it. Clients drop it on their next content-DB refresh.
2. **Remove from the shared RAG index** — delete the track's chunks from the `chunks` table (they were grafted in on promotion), so chat stops retrieving it.
3. **Blob** — because storage is content-addressed and possibly shared (dedup), do **not** eager-delete the blob on takedown; a public-corpus takedown removes *listing + retrievability*, and blob GC is refcounted separately. For a legal deletion demand, delete the object explicitly and record it.
4. **Audit** — record who requested the takedown, the basis, and when.

Devices that already downloaded the track keep their local copy until it ages out; the catalog-version bump prevents any *new* distribution, which is what the policy requires.

## Notes

- The private→public transition keeps a stable content-hash `track_id`, so takedown after promotion still targets one id everywhere (catalog, RAG, blob).
- Keep infrastructure specifics (proxy, hostnames) out of committed docs per project convention.

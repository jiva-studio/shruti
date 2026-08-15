# E2E test plan & backlog

Living checklist of app journeys to cover. Status legend:

- ✅ **done** — spec exists and is green
- 🔜 **queued (offline)** — reliable, tap-based, no backend; next batches
- ✋ **fragile** — needs a touch/gesture harness (long-press text selection,
  player swipe carousel) or timing-sensitive state; do with care
- 🌐 **live** — needs the local stack (`@live`): real chat answers,
  notifications, citation translation, smart library. **Exactly one live spec
  exists** — see "The live tier" below.

> Tags: `@offline` (default, `npm test`) · `@live` (`npm run test:live`).

**Rows carry a Qase case id, not a spec filename.** Specs get renamed, split and
merged; the case id does not, so a row can always be traced to what actually
runs (`qase/cases.json`, and `grep -rn "qase(<id>" tests/`). The plan lists
journeys, not every case: `qase/cases.json` is the full inventory.

## The live tier

One spec: `tests/chat/chat-send.live.spec.ts` — a question typed into the
composer, answered by the real chat service (the live half of case 82). Until
#1674 there were none at all, and `npm run test:live` booted the stack to run
nothing.

Every other 🌐 row is a *wish*, not coverage. Where a journey has an offline
counterpart against a mocked SSE stream, the row says so — that is what is
actually verified. A live run costs minutes and real LLM tokens per test, so the
tier stays small on purpose: put a journey here only when a mock would make the
assertion meaningless.

## Home
- ✅ launch to a populated Home — (145)
- ✅ Up Next renders the seeded queue — (145)
- ✅ activity tracker badges: completed count · time listened — (12)
- ✅ Up Next shows a count badge and shrinks when a row is deleted — (17); the
  queue's total-duration badge is still uncovered
- ✅ draining the queue shows the empty state, and a starter pack re-adds
  tracks — (13)
- ✅ a non-empty playlist surfaces the reminders nag — (14)
- ✋ activity tracker updates after listen → pause (streak / count / time)
- ✋ download indicator shown while a lecture loads
- ✅ at the storage limit the queue refuses silently, the row says it is not
  kept offline, and a deliberate tap is answered with "Download anyway" — (184)
- ✅ a cancelled download releases the track, so re-adding really re-transfers —
  (185); that it then *finishes* is #1680
- ✅ a failed download says so, and a deliberate retry is always answered — (186)
- ✅ a silent CDN does not hold the walk: the live region is asked, and not
  before the hedge interval — (187); completion is #1682
- ✅ tap a queued track → floating player — (16)
- ✅ tap the floating player → transcript — (60)
- ✅ floating player: swipe changes the carousel page — (146) (CDP)
- ✅ player: skip ±15s — (55) · speed presets — (56) · mix slider — (70, 72)

## Library & discovery
- ✅ search filters the catalog list — (22); the list also pages in on scroll — (20)
- ✅ open a track's detail card, add from it, and re-adding is refused — (29)
- ✅ track card content: topic chips + lecture outline — (62); tapping a similar
  lecture swaps the card in place — (139)
- 🔜 track card content: description · timestamps · back
- ✅ delete a track from the playlist — (18)
- ✅ open a topic → see its lectures, and add one from there — (43)
- ✅ add a track from a collection — (38); add the whole collection — (40)
- ✅ library filters: source re-query, active badge, sort and reset — (26); a
  pristine locale seed is not an active filter — (28)
- 🔜 after a filter is applied, adding a track still works
- ✅ library content language seeds + filters the catalog per locale — (35)
- ✅ a topic lists only lectures in the library language — (45)
- ✅ a collection lists only lectures in the library language — (41)
- ✅ a collection that fails to load, or that this content language does not
  hold, says so instead of reading as empty — (334); an empty track list draws
  nothing rather than a blank row — (335). Both are component tests
  (`npm test` in `modules/apps/mobile`), not Playwright: every collection in the
  offline fixture exists in both languages, so the null path is unreachable here
- ✅ a track row is three lines; the reference sits in the metadata line, not on
  the title line — (182)
- ✅ the track sheet names the collection a lecture is part of and leads back to
  it — (179)
- ✋ the row-level collection ordinal: the chip is rendered but no producer ever
  feeds it, so it cannot appear — #1678
- ✅ Smart Library off: the archive schedule offers "Never" and shows what is
  stored — (183)

### The internet lane
- ✅ the shelf, its chevron and the Pro gate on the plus — (167)
- ✅ a hit with no title of its own reads as its reference span, never a URL — (174)
- ✅ what the service said about the request renders as a note — (175)
- ✅ an unreachable service leaves the library lane standing — (176)
- ✅ an empty answer reads differently from a failure — (177)
- ✅ typing searches the words as written, not via the model-read path — (178)
- ✅ a submit the ingest service rejects is reported, and the tile stays an
  offer — (301)
- ✅ a failed add says which failure it was — a broken service and a dead
  connection are two sentences — (361)
- 🔜 the ingest stages on a tile's corner (needs an orchestrator stub — #1673)

## Account & auth
- ✅ a near-expiry token is refreshed before use — (114)
- ✅ a rejected request refreshes once and is replayed — (188)
- ✅ a refresh that hangs instead of failing does not wedge the session — (381)
- ✋ a stalled stream: the socket harness exists (`support/sse-server.ts`), but
  what the UI should do after a stall with partial content is undecided — #1677

## Chat

Offline, against the mocked SSE stream and the seeded fixture sessions:

- ✅ chat composer + suggestions render — (84)
- ✅ send a question → the user bubble echoes and the answer streams in —
  (82, offline half)
- ✅ a failed answer offers a Retry that re-sends — (83)
- ✅ a half-open stream (a real socket that goes quiet, not a route mock):
  the resume poll replays the buffered answer (270) · a turn the server cannot
  account for ends in the same Retry instead of endless dots (271)
- ✅ a re-ask while a stalled turn is still being recovered does not cost the
  buffered answer, which lands above the newer question — (354)
- ✅ a service-down send keeps the question and shows a notice — (88)
- ✅ Retry is disabled, not merely inert, while the daily limit is armed —
  tapping it destroys nothing (353)
- ✅ chat history: open, resume, start a new session, delete one — (93)
- ✅ a reply that lands while you are away lights the Sadhu tab dot, and
  deleting that conversation unopened puts it out — (319)
- ✅ question types render their card: show-verse (85) · make-PDF (86) ·
  locate-story (87) · media clip (198) · translated chapter (199)
- ✅ markers render as cards: verse (89) · citation (90)
- 🔜 history: delete all / clear history

Against a real backend (see "The live tier"):

- ✅🌐 type a question → the local stack streams an answer back — (82, live half).
  It asserts the answer's *shape* (substantial prose arrives), not its words;
  that it is genuinely grounded in the corpus is still unasserted.
- 🌐 the router picks the intent from a free-typed question (`show_verse`,
  `find_track`, `create_action`, `research`, `locate`) rather than from a
  hand-written fixture. The LLM routing was already noted as flaky against exact
  markers — expect to tune queries, not just assert.
- 🌐 a suggestion chip starts a real turn (the chips are shuffled — wait for the
  row to settle before tapping)
- 🌐 send → navigate away → "message ready" local notification → tap → opens the
  right session; the unread dot; scrolling to an unread reply
- 🌐 "ask in chat" from a transcript selection carried through to an answer (the
  hand-off itself is covered offline — 157)

## Transcript & notes
- ✅ starting a track reveals its transcript — (60)
- ✅ Notes tab lists the saved bookmarks — (3)
- ✅ create a note from a transcript selection — (2) (CDP drag-select:
  long-press → touchMove → release; the touchMove is what opens the popover)
- ✅ from a selection: copy — (61) · ask in chat — (157); delete a note from the
  list — (5) or from its transcript underline — (6)
- ✅ Notes page: search with highlight — (4) · the empty state — (9) · sharing a
  note as video is Pro-gated — (11)
- 🔜 Notes page: open/read a note · listen to its audio (each note has an inline
  player)
- ✋ Notes page: share a note as text — (7) · as an audio excerpt — (8) (native
  sheet)

## Settings
- ✅ a setting changes app behaviour (open-transcript-automatically) — (117)
- ✅ switching the app language updates the UI — (115); two quick switches settle
  on the one picked last — (169); a language whose chunk fails leaves the setting
  where it was — (170)
- ✅ library-language picker lists content languages + re-filters discovery —
  (116), and stays independent of the UI language — (36)
- ✅ a toggle persists across a reload — (152); the activity-tracker toggle shows
  and hides the Home card — (153)
- 🔜 player-progress toggle shows/hides the ring on the player
- 🔜 player-on-notes · highlight-sentence toggles
- ✅ the track-list layout is a subscriber's to change — (201) — and a free
  user's paywall — (202)
- ✅ auto-play next is Pro-gated for free users — (59)
- ✋ automatic-scroll (Pro-gated; needs a non-dev build to see the paywall)
- ✅ the translate-quotes chat toggle persists across a restart — (119)
- 🌐 chat answer language · translated citations · smart library actually taking
  effect on a real answer
- ✅ Clear cache keeps the content database — no re-download, app still searches
  offline — (171)
- ✅ Clear cache removes the downloaded audio it is meant to remove — (172)
- ✅ Delete account offers wipe-or-keep local data — (110)
- ✋ Delete account drops the content database (`resetContentDatabase` is a
  no-op on the web build the suite runs — #1663)
- ✅ the download limit is shown, changed and remembered — (180)
- ✅ the Logs dialog's Clear takes the tap and empties the list — (181)

## Share / export
- ✅ track share menu offers a PDF export (entry point) — (65)
- 🌐 actually generate a PDF (share-transcript service)

---

Update this file as specs land. The fragile (✋) items share one blocker — a
faithful touch/long-press harness (CDP `Input.dispatchTouchEvent` on a
`hasTouch` context) — worth solving once to unlock several at once.

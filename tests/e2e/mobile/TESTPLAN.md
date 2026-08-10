# E2E test plan & backlog

Living checklist of app journeys to cover. Status legend:

- ✅ **done** — spec exists and is green
- 🔜 **queued (offline)** — reliable, tap-based, no backend; next batches
- ✋ **fragile** — needs a touch/gesture harness (long-press text selection,
  player swipe carousel) or timing-sensitive state; do with care
- 🌐 **live** — needs the local stack (`@live`): real chat answers, notifications,
  citation translation, smart library

> Tags: `@offline` (default, `npm test`) · `@live` (`npm run test:live`).

## Home
- ✅ launch to a populated Home — `launch`
- ✅ Up Next renders the seeded queue — `launch`
- ✅ activity tracker badges: streak · completed · time listened — `activity-badges`
- 🔜 Up Next badges: lecture count + total duration
- 🔜 starter-pack chips add tracks (empty-playlist state)
- ✅ a non-empty playlist surfaces the reminders nag — `reminders-banner`
- ✋ activity tracker updates after listen → pause (streak / count / time)
- ✋ download indicator shown while a lecture loads
- ✅ at the storage limit the queue refuses silently, the row says it is not
  kept offline, and a deliberate tap is answered with "Download anyway" —
  `storage-limit` (184)
- ✅ a cancelled download releases the track, so re-adding really re-transfers —
  `cancel-then-readd` (185); that it then *finishes* is #1680
- ✅ a failed download says so, and a deliberate retry is always answered —
  `download-failure-notice` (186)
- ✅ a silent CDN does not hold the walk: the live region is asked, and not
  before the hedge interval — `cdn-hedge` (187); completion is #1682
- ✅ tap a queued track → floating player — `play`
- ✅ tap the floating player → transcript — `transcript`
- ✅ floating player: swipe changes the carousel page — `player-swipe` (CDP)
- 🔜 player: skip ±15s · mix slider · speed presets (on the speed/mix pages)

## Library & discovery
- ✅ search filters the catalog list — `search`
- ✅ open a track's detail card — `track-card`
- 🔜 track card content: description · timestamps · similar lectures · back
- ✅ add a track to the playlist (closes the dialog) — `add-track`
- ✅ delete a track from the playlist — `delete-track`
- ✅ open a topic → see its lectures — `topic`
- 🔜 add a track from recommendations / a topic
- ✅ library filters sheet opens — `filters`
- 🔜 apply a filter → list narrows → add still works
- ✅ library content language seeds + filters the catalog per locale — `library-language`
- ✅ a topic lists only lectures in the library language — `topic-language`
- ✅ a collection lists only lectures in the library language — `collection-language`
- ✅ a track row is three lines; the reference sits in the metadata line, not on
  the title line — `track-row-shape` (182)
- ✅ the track sheet names the collection a lecture is part of and leads back to
  it — `collection-part-of` (179)
- ✋ the row-level collection ordinal: the chip is rendered but no producer ever
  feeds it, so it cannot appear — #1678
- ✅ Smart Library off: the archive schedule offers "Never" and shows what is
  stored — `smart-library-off` (183)

### The internet lane
- ✅ the shelf, its chevron and the Pro gate on the plus — `web-lane` (167)
- ✅ a hit with no title of its own reads as its reference span, never a URL —
  `web-lane-states` (174)
- ✅ what the service said about the request renders as a note — (175)
- ✅ an unreachable service leaves the library lane standing — (176)
- ✅ an empty answer reads differently from a failure — (177)
- ✅ typing searches the words as written, not via the model-read path — (178)
- 🔜 the ingest stages on a tile's corner (needs an orchestrator stub — #1673)

## Account & auth
- ✅ a near-expiry token is refreshed before use — `auth-refresh` (114)
- ✅ a rejected request refreshes once and is replayed — `auth-401-retry` (188)
- ✋ a stalled stream: the socket harness exists (`support/sse-server.ts`), but
  what the UI should do after a stall with partial content is undecided — #1677

## Chat
- ✅ chat composer + suggestions render — `chat-render`
- ✅ open chat history → past sessions listed — `chat-history`
- ✅ delete a conversation from history — `chat-history-delete`
- 🔜 history: delete all / clear history
- ✅🌐 type in the composer → receive a streamed grounded answer — `chat-send.live`
  (runs against the local stack with the prod corpus copy)
- 🔜 chips → start a dialog → receive an answer (live)

**Chat request types** (routing.py intents → `chat-types.live`):
- ✅🌐 `show_verse` — "BG 2.13" → scripture card (`.verse-card-addr`/`.scripture-chip`)
- ✅🌐 `find_track` — "lectures about karma" → track list (`.lecture-card`)
- ✅🌐 normal Q&A — "What is bhakti?" → grounded prose (`chat-send.live`)
- ✅🌐 `create_action` reminder — "remind me…" → time-picker card (`.time-input`)
- ✅🌐 suggestion chip starts a turn — `chat-chip.live` (wait for the shuffled
  suggestions row to settle before tapping, then assert user bubble + session URL)
- ✋🌐 `research` → citation · `locate` → chapter card (fixme: LLM-routing into
  the exact intent + marker is flaky; tune queries vs the router prompt)
- 🔜 `create_action` pdf — finicky intent + needs the share-transcript service

**Chat resilient streaming / notifications** (advanced; web-notification limits):
- 🌐 send → navigate away → "message ready" local notification → tap → opens the
  right session
- 🌐 after that, the chat tab / history shows an unread dot
- 🌐 opening a session with an unread reply scrolls to it
- 🌐 navigate away from chat → "message ready" notification
- ✋🌐 "ask in chat" from a transcript selection → a scoped dialog with the
  lecture title as header

## Transcript & notes
- ✅ starting a track reveals its transcript — `transcript`
- ✅ Notes tab lists the saved bookmarks — `notes`
- ✅ create a note from a transcript selection — `create-note` (CDP drag-select:
  long-press → touchMove → release; the touchMove is what opens the popover)
- 🔜 from a selection: copy · share · ask-in-chat · delete an existing note
  (all reuse the `create-note` CDP selection harness — now unblocked)
- 🔜 Notes page: open/read a note · listen to its audio (each note has an inline
  player) — no swipe-delete on the list (deletion is from the open note)
- ✋ Notes page: copy text · share (native sheet)

## Settings
- ✅ a setting changes app behaviour (open-transcript-automatically) — `settings`
- 🔧 switching the app language updates the UI — `settings-language` (in progress)
- ✅ library-language picker lists content languages + re-filters discovery — `settings-library-language`
- 🔜 player-progress toggle shows/hides the ring on the player
- 🔜 player-on-notes · highlight-sentence · track-info toggles
- ✋ autoplay · automatic-scroll (Pro-gated; need a non-dev build to see paywall)
- 🌐 chat answer language · translate citations · smart library
- ✅ Clear cache keeps the content database — no re-download, app still searches
  offline — `clear-cache`
- ✅ Clear cache removes the downloaded audio it is meant to remove — `clear-cache`
- ✋ Delete account drops the content database (`resetContentDatabase` is a
  no-op on the web build the suite runs — #1663)
- ✅ the download limit is shown, changed and remembered — `settings-download-limit` (180)
- ✅ the Logs dialog's Clear takes the tap and empties the list — `logs-clear` (181)

## Share / export
- ✅ track share menu offers a PDF export (entry point) — `share-menu`
- 🌐 actually generate a PDF (share-transcript service)

---

Update this file as specs land. The fragile (✋) items share one blocker — a
faithful touch/long-press harness (CDP `Input.dispatchTouchEvent` on a
`hasTouch` context) — worth solving once to unlock several at once.

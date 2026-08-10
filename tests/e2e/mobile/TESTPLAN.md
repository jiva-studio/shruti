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

## Share / export
- ✅ track share menu offers a PDF export (entry point) — `share-menu`
- 🌐 actually generate a PDF (share-transcript service)

---

Update this file as specs land. The fragile (✋) items share one blocker — a
faithful touch/long-press harness (CDP `Input.dispatchTouchEvent` on a
`hasTouch` context) — worth solving once to unlock several at once.

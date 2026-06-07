# Plan — Continuous Background Playback (Pro)

> Status: **proposed** · Branch: `feat/background-playlist` · Author: research + design pass

## 1. What we're building

When the user has a playlist of lectures, the player should **automatically advance to the
next lecture when the current one finishes** — and keep doing so **while the app is in the
background or the screen is locked**, with no help from the app's JavaScript.

Two user-facing pieces:

1. A **Pro feature** advertised on the Subscription screen (one slide — see §6).
2. A **settings toggle** — *"Play next track automatically"* — Pro-gated, off by default.

### Why this is non-trivial

| App state | Who can drive auto-advance | Works today? |
|-----------|---------------------------|--------------|
| Foreground / active | JS (`onProgress` → completion → `openTrack(next)`) | trivial, not yet wired |
| Backgrounded / screen locked | **only native code** — the WebView JS is suspended by the OS | needs native queue |

On Android the foreground service keeps `ExoPlayer` alive, but the WebView's JS is frozen
(`Activity.onPause`). On iOS the `.playback` audio session keeps `AVPlayer` running, but
`WKWebView` JS is suspended. **In both cases the plugin's *native* code keeps executing — only
the JS layer sleeps.** Therefore the auto-advance loop, and the "what got played" bookkeeping,
must live in native code, with JS reconciling on resume.

> This is not speculative — it's the documented WebView behaviour: *"JavaScript is paused by iOS
> (and some Android versions too)… totally stopped after the app is backgrounded"*, and on Android
> *"the OS forces the app to sleep even if audio is playing in the WebView"*. Hence Capacitor apps
> that need real background audio drop to a native foreground service / media session — exactly what
> this plugin already does for the single-track case. See §10 references.

This drives the whole design: **the native player owns an ordered queue and advances through it
itself; JS hands it the queue up front and drains a played-items log when it wakes up.**

---

## 2. How playback works today (as-is)

Researched end-to-end; key reference points:

### JS / app layer
- **`usePlayerStore`** (`modules/apps/mobile/shruti/stores/usePlayerStore.ts`) — singleton player
  state. `openTrack(args)` is the single entry point: resolves a play plan, resumes position,
  ensures the file is downloaded (`useDownloadStore.ensureDownloaded`), calls
  `app.audioPlayer.open({itemId, url, title, author})`, then re-applies **mix** and **speed**
  (`applyMix` / `applyPlaybackSpeed`) because a fresh native item loses both bindings.
- **`onProgress`** listener in the store (`subscribeOnce`, line ~96) receives `{itemId, position,
  duration, playing}` every ~500 ms and feeds `usePlayerSession.applyStatus`.
- **`usePlayerSession`** (`stores/player/usePlayerSession.ts`) journals listening into
  `listening_sessions` and patches the playlist. **Completion** is detected here via
  `isCompleted(position, duration)` (`@lib/domain/listeningSession.ts`,
  `COMPLETION_THRESHOLD_MS = 2000`). **This is the natural foreground auto-advance hook.**
- **`usePlaylistStore`** (`stores/usePlaylistStore.ts`) — the playlist *is* the queue. `entries`
  (ordered, paged), `progressMap`, `completedAtMap`, `patchProgress(itemId, ms, durationMs)`.
- **`usePlaylistPrefetch`** already prefetches **audio for every entry** into the offline cache
  (`prefetchAll`). So in practice the upcoming tracks are usually already local on disk — which is
  exactly what a native queue needs.
- **`useCapacitorAudioPlayer`** (`infra/audio/capacitor/`) — bridges seconds↔milliseconds and
  multiplexes listeners. The app port `IAudioPlayer` (`ports/app/audioPlayer.ts`) speaks ms.

### Native layer (plugin `modules/plugins/audio-player/`)
- **Definitions:** `src/definitions.ts` — `AudioPlayerPlugin` = `open / play / togglePause / seek /
  seekBy / stop / setMix / setPlaybackRate / onProgressChanged`. Single track only.
- **Android:** `AudioPlayerService.java` wraps **`ExoPlayer`** with a single
  `MediaItem.fromUri(url)` (local `file://` or HTTP). Foreground service + `MediaSessionCompat`
  (lock-screen controls: play/pause, ±15 s). Completion = `Player.STATE_ENDED` in
  `MediaStateNotificationService`. `StereoMixAudioProcessor` sits in the audio chain; speed via
  `PlaybackParameters`.
- **iOS:** `AudioPlayerPlugin.swift` wraps **`AVPlayer`** with one `AVPlayerItem`. `.playback`
  audio session + `MPRemoteCommandCenter` + `MPNowPlayingInfoCenter`. Completion =
  `AVPlayerItemDidPlayToEndTime`. `StereoMixTap` (`MTAudioProcessingTap`) is attached **per
  `AVPlayerItem`** via `audioMix`; rate re-applied on play.
- **Web:** `src/web.ts` — one `HTMLAudioElement` + Web Audio graph for mix.

### Subscription / settings layer
- **Feature slides:** `ui/features/subscription/featureKeys.ts` — `FEATURE_SLIDES` array of
  `{key, i18nKey, icon: "/subscription/X.png", soon}`. Rendered by `SubscriptionView.vue` carousel.
- **Pro gating:** `usePurchasesStore.isSubscribed` / `useAuthStore.isPro` (`tier === "pro"`).
  Paywall via `usePaywallStore.requestOpen(featureKey)`.
- **Settings toggle pattern:** Pro-gated example `AutomaticScrollSettingsItem.vue`
  (`effectiveChecked = value && isSubscribed`, emits `request-paywall`); persisted via
  `useConfig<boolean>("settings.…", default)` in `SettingsView.controller.ts`; i18n in
  `i18n/locales/{en,ru}/settings.ts` under `subscription.benefits.*` and `settings.*`.

---

## 3. Target architecture

**Principle: native always speaks "queue".** A single track is just a queue of length 1. This
unifies the native code on one model (ExoPlayer playlist / AVQueuePlayer) and removes the
"foreground vs background" branch from the advance logic — native advances the same way regardless
of who's looking.

```
JS (usePlayerStore)
  │  builds ordered queue of LOCAL items  (current → tail of playlist)
  ▼
audioPlayer.setQueue({ items[], startIndex, startPositionMs })
  ▼
Native player owns the queue:
  • plays item, auto-advances on STATE_ENDED / DidPlayToEndTime  ← runs in background
  • re-applies mix + speed on every item transition (native)
  • updates MediaSession / NowPlaying per item
  • buffers a transition log: [{finishedItemId, finishedAtMs, durationMs, startedItemId}, …]
  • emits onItemTransition (best-effort push, foreground only)
  ▲
JS, on resume / visibility:
  audioPlayer.getQueueState() → { currentItemId, positionMs, durationMs, playing, events[] }
  • replay events → mark each finished item completed in listening_sessions + patchProgress
  • sync usePlayerStore refs (trackId/itemId/title/position) to currentItemId → FloatingPlayer correct
  • re-arm onProgress guard for the new itemId
```

### 3.1 Plugin API additions (`src/definitions.ts`)

```ts
interface QueueItem {
  itemId: string        // PlaylistItemId — the bookkeeping key
  url: string           // local file:// preferred; HTTP fallback when online
  title: string
  author: string
  durationMs?: number   // so native can report completion duration without probing
}

interface QueueTransition {
  finishedItemId: string
  fromPositionMs: number   // where listening on this item began (resume pt / 0)
  finishedAtMs: number     // ~= durationMs on a natural end; < duration on a skip
  durationMs: number
  startedItemId: string | null   // null when the queue ran dry
  reason: "auto" | "skip-next" | "skip-prev" | "error"   // ONLY "auto" marks completed
  at: number               // native wall-clock (ms) — completion may be hours old
  seq: number              // monotonic — drives idempotent ack-based clear
}

interface QueueState {
  currentItemId: string | null
  positionMs: number
  durationMs: number
  playing: boolean
  events: QueueTransition[]   // NOT auto-cleared — see ackEvents()
}

ackEvents(opts: { upToSeq: number }): Promise<void>   // clear only what JS persisted
```

> `events` are read durably (see §3.4): the native side persists every transition to disk the
> instant it happens, so a drain works on the next app **start**, not just on resume. JS reads,
> writes them to `listening_sessions`, then `ackEvents(upToSeq)` to clear — never lose, never
> double-count across kill cycles.

```ts

// new methods
setQueue(opts: { items: QueueItem[]; startIndex: number; startPositionMs: number }): Promise<void>
appendToQueue(opts: { items: QueueItem[] }): Promise<void>   // re-fill on resume
getQueueState(): Promise<QueueState>                          // pull-based drain
skipToNext(): Promise<void>                                   // lock-screen / in-app next
skipToPrevious(): Promise<void>
onItemTransition(cb: (t: QueueTransition) => void): Promise<CallbackID>  // foreground push
```

`open()` is kept on the **app port** (`IAudioPlayer`) as a thin wrapper that calls `setQueue` with
a single item — so callers (`openTrack`, `playTrack`) don't all change at once. Internally the
native `open` is re-implemented in terms of the queue (length-1), so there's **one** native play
path, not two. (Consistent with [[feedback_no_compat_shims]] — we don't keep a parallel
single-item native engine alongside the queue engine.)

**Why pull-based drain, not push events:** Capacitor listener callbacks fire into suspended JS
unreliably and queued events can be dropped across a long background stint. The native side
**buffers** transitions and JS **pulls** them on wake. `onItemTransition` push is a
nice-to-have for the foreground (instant UI), never the source of truth.

### 3.2 Queue construction (JS)

- Queue = the **tapped entry + every following entry in playlist order**. No reordering, no
  skipping: tracks *above* the tapped one (even unplayed ones) are simply not in the queue, and
  already-listened tracks *below* it still play. Predictable "play from here down".
- Take the run that is **already downloaded locally** (`useDownloadStore`). The native queue stops
  where the local run stops; on resume JS extends it via `appendToQueue` (and can kick downloads).
  Given `prefetchAll` already pulls the whole playlist's audio, this is normally the full tail.
- HTTP fallback for not-yet-downloaded items only when online — but background + offline +
  not-downloaded ⇒ queue ends there. Acceptable.
- **Resume position:** only the initially-tapped item honours its saved position
  (`usePlayerResumePosition`). Every auto-advanced item starts at **0** — jumping a freshly-started
  lecture to a mid-point would be jarring. (Decided, not an open question.)

### 3.3 Mix & speed across transitions (native — important)

Today JS re-applies mix + speed after each `open()`. With native auto-advance JS isn't around, so
**native must re-apply on every item transition**:
- **Android:** `StereoMixAudioProcessor` and `PlaybackParameters` are set on the *player*, not the
  item, so they persist across queue items for free. Verify on `onMediaItemTransition`.
- **iOS:** `audioMix` (the `StereoMixTap`) and rate are **per `AVPlayerItem`** → must re-install the
  tap and re-apply `rate` on each advance. This is the main iOS work item. (If using
  `AVQueuePlayer`, attach `audioMix` to each item as it's enqueued.)

### 3.4 Durable journaling + reconciliation (JS) — the hard part

The drain must **not** depend on the WebView ever resuming. Consider the worst case:

> **App backgrounded → whole queue plays out → process killed by the OS → user never reopens it
> mid-session.** JS gets no `resume`. If the played-items log lives only in native memory, it dies
> with the process and A/B/C are never journaled.

So **native persists durably as it plays**, and JS drains on the **next app start**:

**Native side (Android service / iOS plugin):**
1. On **every** item transition (auto end *and* skip), synchronously append a `QueueTransition` to
   an on-disk journal (Android: file in app storage / `SharedPreferences`; iOS: file in app support
   / `UserDefaults`) **before** doing anything else. This write must complete even if the service
   is about to stop.
2. Persist `{currentItemId, positionMs}` on key events (pause, seek, transition) **plus** a coarse
   safety interval while playing. The interval cadence is non-critical — ~30 s is fine; even a
   minute only risks losing <60 s of resume accuracy on a hard kill, which is acceptable (confirmed
   acceptable by product). Cheap, infrequent disk writes. (Bonus: this also fixes the *existing*
   single-track case where 30 min of background listening is lost on a kill, because today only the
   JS tracker writes position and it's frozen in the background.)
3. When the queue runs dry, persist the final journal entry **before** stopping the foreground
   service / removing the notification — never the reverse.

**JS side — drain runs on `app init` AND on `resume`/`visibilitychange→visible`:**
1. `const s = await audioPlayer.getQueueState()` (reads the durable journal).
2. For each `s.events` in `seq` order, write a `listening_sessions` row:
   - `reason: "auto"` → completed: session `fromPositionMs → durationMs`, `patchProgress` marks it
     done. (`isCompleted(duration, duration)` holds.)
   - `reason: "skip-*"` → **partial**: session `fromPositionMs → finishedAtMs`, **not** completed.
   - Stamp `ended_at` from the event's `at` (completion may be hours old), not `Date.now()`.
   - **Idempotent:** skip any `seq` already ingested; after writing, `ackEvents({upToSeq})` so native
     clears only what we persisted. Survives multiple background→kill cycles without double-counting
     or loss.
3. Resync the now-playing item: if `s.currentItemId` differs from `usePlayerStore.itemId`, refresh
   `trackId / itemId / title / authorName / language / positionMs / durationMs` from the matching
   `entries` row → FloatingPlayer shows the right lecture; re-arm the `onProgress` guard. If
   `currentItemId` is `null` (queue done, nothing playing), render the last item as
   completed/stopped — never a stale "playing".
4. If `s.currentItemId` was **archived** while backgrounded, the completion bookkeeping is still
   valid (archive doesn't touch `listening_sessions`); just don't try to re-home the FloatingPlayer
   on a row that's gone — fall back to stopped.
5. If the native queue ran dry but more local entries now exist (a download finished while
   backgrounded), `appendToQueue`.

**Drain must run early in the composition root** — after repos are ready but before
`usePlaylistStore` computes the completed-badge sets — so background-played completions show on the
first paint, not a beat later.

**Drain concurrency:** init-drain and a near-simultaneous resume-drain can race (cold start that
immediately foregrounds). Guard the drain with a single-flight lock. Belt-and-suspenders for a
crash *between* writing sessions and `ackEvents`: JS also persists `lastDrainedSeq` locally and
ignores any event with `seq <= lastDrainedSeq`, so a re-read of un-acked events can't double-write.

### 3.5 Platform specifics surfaced by the standards review

**Android — error policy (real gap).** ExoPlayer does **not** auto-skip a failed queue item; the
default on `onPlayerError` is to stop and transition to `STATE_IDLE`. So a single corrupt/unreadable
download would silently end the whole background session. Policy: in the `Player.Listener`, on
error **`seekToNextMediaItem()` + `prepare()`** to continue, and journal the failed item with
`reason: "error"` (partial session, **not** completed). Bound retries so a run of bad items can't
loop.

**Android — keep the service alive.** Battery optimization can force-close even a foreground media
service. Set **`ExoPlayer.setWakeMode(C.WAKE_MODE_LOCAL)`** (or `WAKE_MODE_NETWORK` for HTTP
fallback items) and review audio-offload settings, or long background queues get cut off mid-play.

**Android — session/notification architecture.** The plugin today uses a raw foreground `Service`
+ legacy `MediaSessionCompat` + a hand-built notification refreshed on a 500 ms loop. The 2025
best practice is **`androidx.media3.session.MediaSessionService` + `MediaSession`**, which
auto-builds and **auto-updates the per-item notification** from each `MediaItem`'s `MediaMetadata`
and handles next/prev. **Decision (settled):** migrate to `MediaSessionService` **in this PR as a
dedicated, isolated commit** — not deferred to a later follow-up. Sequence it so it lands as its own
reviewable step (do it first, before / at the start of the Android native-queue work, so the queue
+ per-item notification are built on the modern session from the outset rather than retrofitted).

Hard constraint on that commit: **the custom `StereoMixAudioProcessor` renderer must survive the
migration** — `MediaSessionService` wraps the same `ExoPlayer`, so build the player with the
existing custom `RenderersFactory` and hand it to the session. The migration commit should be
behaviour-preserving for the *single-track* case (verify mix + speed + ±15 s + lock-screen still
work) before the queue commit builds on top.

**iOS.** `AVQueuePlayer` auto-advances in the background under the `.playback` session, and
`AVPlayerItemDidPlayToEndTime` fires natively while backgrounded. The per-item `audioMix`
(`StereoMixTap`) and `rate` must be (re)applied as each `AVPlayerItem` becomes current — attach
`audioMix` when enqueuing each item and re-apply `rate` on the `currentItem` change observer.
`MPNowPlayingInfoCenter` is refreshed on that same observer; wire `MPRemoteCommandCenter`
`nextTrackCommand` / `previousTrackCommand`.

---

## 4. Settings toggle

- Config key: `settings.playback.autoPlayNext` (boolean, default `false`) via `useConfig` in
  `SettingsView.controller.ts`.
- New `AutoPlayNextSettingsItem.vue` modelled on `AutomaticScrollSettingsItem.vue`: `ProBadge`,
  `effectiveChecked = value && isSubscribed`, emits `request-paywall`. Place in the player/playback
  settings group; thread `isSubscribed` + `@request-paywall` like `autoScroll`.
- Behaviour: `openTrack` reads the toggle. **ON + Pro** → build the playlist-tail queue.
  **OFF or not Pro** → queue of 1 (current behaviour).
- The toggle is the single source of truth; nothing auto-advances when it's off.

---

## 5. Web behaviour

No background concern on web (tab-bound). `src/web.ts` keeps a **JS-side** queue and advances on
the `HTMLAudioElement` `ended` event, exposing the same `setQueue / getQueueState` surface. Mix is
already a persistent Web Audio graph, so it survives transitions.

---

## 6. Subscription presentation

**One slide.** "Continuous playback in the background" is a single feature from the user's point of
view — the queue/lock-screen/background framing is internal plumbing, not a separate selling point.

Add to `FEATURE_SLIDES` (`featureKeys.ts`) + i18n in `en` and `ru` `settings.ts`
([[feedback_i18n_pair_changes]]) + a PNG in `public/subscription/`
(generate via the badge pipeline — [[reference_openrouter_key_and_badge_gen]], `gen.sh` + STYLE):

- **Continuous Playback** (`key: "continuousPlayback"`) — *"Lectures play one after another — when
  one ends the next begins automatically, even with the screen locked."*

Russian copy must be native, no calques ([[feedback_no_english_calques_in_russian]]).

**Don't advertise the slide / enable the toggle on a platform until native background advance is
actually shipped there** — gate slide visibility / toggle availability by platform capability so we
never sell a Pro promise that silently no-ops in the background.

---

## 7. Phasing

| Phase | Scope | Outcome |
|-------|-------|---------|
| **1 — JS foreground** | Toggle + Pro gate + subscription slides; auto-advance in `usePlayerSession.applyStatus` completion branch → `openTrack(nextEntry)`; web `ended` advance. | Continuous play works while app is **active**. Not yet a background promise. |
| **2 — Android native** | **(2a, own commit)** migrate session/notification to Media3 `MediaSessionService`, mix renderer preserved, single-track behaviour-preserving. **(2b)** `setQueue/getQueueState/appendToQueue/ackEvents` + ExoPlayer playlist + **durable on-disk journal** (transitions + periodic position) + drain-on-start/resume reconciliation + lock-screen next/prev. | True **background** continuous play on Android, **state survives a background kill** (§3.4). Enable slide/toggle on Android. |
| **3 — iOS native** | Same surface on `AVQueuePlayer`/native end-observer; durable journal; **per-item tap + rate re-apply**; `MPRemoteCommandCenter` next/prev. | Background on iOS, survives kill. Enable slide/toggle on iOS. |
| **4 — Polish** | Queue-end download top-up; analytics; "skip already-listened" only if product wants it. | Polish. |

> Durable journaling is **core (Phase 2/3)**, not hardening — without it the "played in background,
> app killed, never reopened" path loses progress (the gap this review caught).

Ship the subscription slide + toggle **with the first native platform**, not with Phase 1 alone.

---

## 8. Risks / open questions

- **WebView suspension timing** differs across OEMs (Android) — confirm the durable journal write
  lands even under aggressive doze; the on-disk-as-it-plays design (§3.4) is what covers this.
- **iOS per-item tap re-install** is the fiddliest part; budget for it. Validate mix + speed
  actually carry across an AVQueuePlayer advance in the background.
- **ExoPlayer stops on a failed item** — without the explicit `seekToNextMediaItem` error policy
  (§3.5) one corrupt download silently kills the whole background session. Must-have, not polish.
- **Android battery optimization** can force-close the media service mid-queue without
  `setWakeMode` / offload config (§3.5).
- **Drain race / partial ack** — init+resume drains must single-flight, and `lastDrainedSeq` must
  guard against a crash between session-write and `ackEvents` (§3.4).
- **Media3 migration** — settled (§3.5): done in this PR as its own commit (phase 2a), ahead of the
  queue work, with the custom mix renderer preserved and single-track behaviour verified first.
- **`listening_sessions` synthetic rows** must not double-count if a foreground `onItemTransition`
  push *and* the drain both fire — the durable drain is authoritative; replay is idempotent per
  `seq` with `ackEvents` (§3.4). The `onItemTransition` push is foreground-only UI sugar.
- **Background kill before journal flush** — the on-disk append must be synchronous and ordered
  *before* service teardown (§3.4 native step 3); audit OEM doze behaviour to confirm the write
  lands. This is the path the plan review surfaced.
- **`skip-next` ≠ completion** — only `reason: "auto"` marks an item completed; a lock-screen skip
  writes a partial session at `finishedAtMs`. Getting this wrong would falsely badge half-listened
  lectures as done.
- **Playlist edited while backgrounded** (archive / add / reorder) — native queue is a stale
  snapshot. Completion bookkeeping by `itemId` stays correct; only the FloatingPlayer re-home needs
  the archived-current-item guard (§3.4 step 4).
- **Audio-focus loss** (call, other app) — must **pause**, never count as an end / advance.
  Headphone-unplug is already handled; verify focus loss doesn't trip a false transition.
- **Two-device sync** — out of scope; `listening_sessions` is local-only, as today.

---

## 9. Touch list (files)

**JS/TS**
- `modules/plugins/audio-player/src/definitions.ts` — queue API types + methods
- `modules/plugins/audio-player/src/web.ts` — JS queue + `ended` advance
- `modules/apps/mobile/ports/app/audioPlayer.ts` — port: `openQueue`/`getQueueState`/`ackEvents`
- `modules/apps/mobile/infra/audio/capacitor/useCapacitorAudioPlayer.ts` — bridge new methods (ms↔s)
- `modules/apps/mobile/shruti/stores/usePlayerStore.ts` — build queue in `openTrack`; drain on init/resume
- composition root (app bootstrap) — run the journal drain early, before playlist badge compute
- `modules/apps/mobile/shruti/stores/player/usePlayerSession.ts` — foreground completion → advance
- `modules/apps/mobile/shruti/stores/usePlaylistStore.ts` — "next entry after itemId" selector
- `modules/apps/mobile/ui/features/settings/AutoPlayNextSettingsItem.vue` (new)
- `modules/apps/mobile/ui/features/settings/groups/*` — place the toggle
- `modules/apps/mobile/shruti/views/Settings/SettingsView.controller.ts` — `useConfig` key
- `modules/apps/mobile/ui/features/subscription/featureKeys.ts` — new slide(s)
- `modules/apps/mobile/shruti/i18n/locales/{en,ru}/settings.ts` — copy
- `modules/apps/mobile/public/subscription/*.png` (new assets)

**Android** (`modules/plugins/audio-player/android/.../audioplayer/`)
- `AudioPlayerService.java` — (2a) extend Media3 `MediaSessionService`, build `ExoPlayer` with the existing custom `RenderersFactory` (mix preserved), wrap in `MediaSession`; (2b) ExoPlayer playlist, `onMediaItemTransition`, durable journal (transitions + periodic position), persist-before-teardown, `setWakeMode`
- `AudioPlayerPlugin.java` — `setQueue/appendToQueue/getQueueState/ackEvents/skipTo*` bridge
- `mediaStateNotifications/*` — replaced by Media3 auto-notification (2a); `MediaSession` callbacks for next/prev
- `AndroidManifest.xml` — `MediaSessionService` intent-filter + `foregroundServiceType=mediaPlayback`

**iOS** (`modules/plugins/audio-player/ios/Sources/AudioPlayerPlugin/`)
- `AudioPlayerPlugin.swift` — `AVQueuePlayer`, per-item tap + rate, durable journal, next/prev
- `StereoMixTap.swift` — re-attach per item

---

## 10. References (standards / best practice)

Validated against current platform guidance during the plan review:

- **Background WebView JS is suspended** on iOS (`WKWebView` halts JS when backgrounded) and
  throttled/slept on Android even with audio playing — hence the native foreground service / media
  session is mandatory for real background audio. (WebKit bug 203293; Apache CB-10657; Capacitor
  background-audio guidance.)
- **Android background playback** → Media3 `MediaSessionService` + `MediaSession` is the 2025
  recommended architecture; it auto-builds/updates the per-item notification.
  ([developer.android.com/media/media3/session](https://developer.android.com/guide/topics/media/session/mediasessionservice))
- **ExoPlayer error handling** → no automatic skip on a failed playlist item; handle
  `onPlayerError` and advance manually. (google/ExoPlayer issues #4343, #8946.)
- **iOS** → `AVQueuePlayer` auto-advances under `.playback` in the background;
  `AVPlayerItemDidPlayToEndTime` fires natively; `MPNowPlayingInfoCenter` /
  `MPRemoteCommandCenter` for lock-screen metadata + next/prev.
</content>
</invoke>

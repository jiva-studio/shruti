# Dual-source audio mixing — design

Status: **proposed** (no code yet). Lets the listener blend two audio versions of
the same lecture in real time — the noisy **original** and the denoised
**clean** — with a single 0..1 slider in the floating player. `0` = original
only, `1` = clean only, in between = both mixed live.

## 1. Goal & UX

- A new **slide** (carousel page) in the mobile floating player
  (`ui/features/player/FloatingPlayer.vue`) carrying one slider that mixes
  original ↔ clean.
- The slide appears **only** when the playing variant has **both** an `original`
  and a `clean` audio (from the `track_audio` table). Otherwise the carousel is
  unchanged.
- Mixing is **real-time**: dragging the slider during playback changes the blend
  immediately, no restart/seek.
- Works on **iOS, Android, and Web** (web is a first-class test surface).

## 2. Two distinct mix modes — do not conflate

The player now has **two unrelated blends**. They must be modelled and labelled
separately.

| | Channel mix (existing) | Source mix (new) |
|---|---|---|
| What | L/R channels of **one** stereo file | **two** mono files (original + clean) |
| Where | `StereoMixTap` (iOS) / `StereoMixAudioProcessor` (Android) / Web Audio splitter | new dual-source graph |
| Slider | `MixControl`, [−1..+1], 0 = native stereo | new, [0..1], default = clean |
| Corpus | mostly **RU lectures** (L=lecture, R=translation) | any track the denoiser cleaned |
| Plugin call | `setMix({enabled, ratio})` | `setSourceMix({level})` (new) |

**They are effectively mutually exclusive in practice**: the denoiser outputs
**mono**, so a stereo dual-content (channel-mix) track can't be cleaned without
collapsing its L/R content. So a given variant is normally in *either* channel
mode *or* source mode, not both.

**Rule if both ever apply** (rare): show both slides (channel-mix page + source-mix
page), each independently controlling its own blend. The audio graph applies
channel-mix per-stream and source-mix across streams, so they compose. We do not
need special-case logic — just two sliders.

## 3. Gating — when the source-mix slide shows

Already wired by the catalog work: `track_audio` exposes all versions per
`(track, language)`. The mobile domain has `variant.audios: TrackAudio[]` with
`kind ∈ {original, clean}` and `variant.audio` = preferred pick (clean ?? original).

- **Source-mix available** ⇔ the playing variant's `audios` contains **both**
  `original` and `clean`.
- Expose a derived flag on the player store, e.g. `sourceMixAvailable` +
  `originalAudio` / `cleanAudio` refs.
- `FloatingPlayer` makes `PAGE_COUNT` dynamic: 3 normally, 4 when
  `sourceMixAvailable`. The new page slots **below speed** (or above mix — TBD,
  see open decisions). `FloatingPlayerPageDots` already takes `:count`.

## 4. Data & download layer — two files, one aggregated indicator

Today downloads are **one file per track**: `useDownloadStore` keys
`DownloadState` + `progress` (0..100) by `trackId`; `ensureDownloaded(trackId,
path)` fetches one file; the user DB (`mediaItems`, `IMediaItemRepository`) stores
one `localPath` per track. Source-mode needs **both** files, and the offline
indicator must reflect **both**.

### Persistence (user DB — local, not the content DB)
- `mediaItems` becomes keyed by **(trackId, kind)** with `kind ∈ {original,
  clean}`: `upsert(trackId, kind, state, localPath)`, `listReady()` returns
  per-kind rows, `failStaleDownloads()` per row. Local DB migration only — no
  scheme gate, no cross-app release coupling (unlike the content DB).

### Download orchestration (`useDownloadStore`)
- `ensureDownloaded(trackId, paths[])` accepts **1 or 2** paths (most tracks: 1).
- **Aggregated progress**: combine the per-file `(received, total)` from both
  transfers into one number — `progress = Σ received / Σ total × 100`. The
  store's `progress.get(trackId)` stays a single 0..100 the UI already reads, now
  representing both files together (byte-weighted, so a small clean file doesn't
  jump the bar).
- **Aggregated state** (the offline indicator means "playable offline", which is
  the ORIGINAL — clean is a bonus, so don't fail the whole track if only clean
  fails):
  - `downloading` while **any** leg is in flight,
  - `completed` once the **original** is on disk (track is offline-playable),
    even if `clean` is still pending/failed → the source-mix slide just stays
    disabled and clean retries best-effort,
  - `failed` only if the **original** leg fails,
  - separate `cleanReady` sub-signal gates the mix slide.
- The radial indicator (`getState`/`getProgress(trackId)`) is **unchanged at the
  call sites** — aggregation happens inside the store, so Home/Search/player rows
  keep working with no UI rewrite.
- `remove(trackId)` deletes **both** files; transcript cleanup unchanged.

### Fetch policy (ties to open decision #2)
- **Offline save** ("download for offline"): fetch **both** eagerly; the combined
  indicator covers both files start-to-finish. ← matches "качаем два, индикатор по двум".
- **Playback start**: may start on `original` immediately and pull `clean` in the
  background (so play isn't blocked on the 2nd file); the source-mix slide stays
  disabled/greyed until `clean` is ready, then enables. (Decision: eager-both vs
  original-first-lazy-clean.)
- Fallback: if `clean` is missing/evicted, fall back to single-source (original)
  and hide the slide.

### Cost
- **2× download + 2× storage** for clean-enabled tracks. Mitigations: lazy clean
  fetch on first engage, and/or the "economy" toggle (§9). Clean is mono and
  usually smaller than a stereo original, which softens storage a bit.

## 5. Plugin API changes (`modules/plugins/audio-player/src/definitions.ts`)

Source list, role by position:

- `OpenParams` / `QueueItem`: `audios: string[]` — sources in priority order
  (`audios[0]` plays and owns the timeline; `audios[1]` is the optional
  crossfade source). One entry → single-source behaviour. The player is
  agnostic about what each source is; the caller decides which file goes where.
- New method `setSourceMix({ level: number /* 0..1 */ }): Promise<void>`.
  `0` = original only, `1` = clean only. Distinct from `setMix` (channel).
- New status field (optional): echo current `sourceMixLevel` for resume.
- Mirror in the app port `ports/app/audioPlayer.ts` (`IAudioPlayer`).

State lives in the player store like `mixPosition` / `playbackSpeed`: a persisted
`sourceMixLevel` (per-user, default = 1 / clean), applied on open via
`applySourceMix()` and on every slider change.

## 6. Native architecture — single graph, single clock (no manual sync)

The key decision from research: use **one audio graph with one clock** feeding a
mixer, so the system keeps both sources sample-locked. We do **not** run two
independent players (that's the only path that would need hand-rolled drift
correction).

### iOS — `AVAudioEngine` (direct Web Audio analog)
Today: `AVQueuePlayer` (single source) + per-item `MTAudioProcessingTap`.
Target for source-mode tracks:
- `AVAudioEngine` with two `AVAudioPlayerNode` (original, clean) → `AVAudioMixerNode` → output.
- `nodeOriginal.volume = 1 − level`, `nodeClean.volume = level`; updated live.
- Both nodes on the engine's single render clock → inherent sync.
- Channel-mix (stereo→mono) becomes a tap/format step on the relevant node/mixer.
- **Cost**: re-implement queue / lock-screen (`MPNowPlayingInfoCenter`) /
  background on the engine. Biggest single chunk of work. Consider: keep
  `AVQueuePlayer` for normal (single-source) tracks and switch to the engine only
  for source-mode tracks, to limit blast radius.

### Android — decode + mix → one `AudioTrack`
Today: single `ExoPlayer` + `StereoMixAudioProcessor` in the sink. ExoPlayer has
no Web-Audio-like multi-source mixer graph, and two ExoPlayers = two clocks
(avoid).
Target for source-mode tracks:
- Decode both files (`MediaCodec`) and **mix into one `AudioTrack`** with
  per-stream gain (`1−level`, `level`) — reuse the loudness-comp math already in
  `StereoMixAudioProcessor`. One `AudioTrack` = one clock = inherent sync.
- **Cost**: a custom mixing playback path that still drives MediaSession /
  notification / position. More plumbing than iOS. Keep ExoPlayer for normal
  tracks; route only source-mode tracks through the custom mixer.

### Web — the Web Audio graph IS the mixer (test surface)
The mixing is native to Web Audio: source nodes → `GainNode`s → one
`destination`, which the `AudioContext` **sums automatically**. We never mix
samples by hand. The only question is how to get two files INTO the graph:
- `AudioBufferSourceNode` (via `decodeAudioData`) = one clock, sample-perfect
  sync — **but decodes the whole file into RAM** (~0.5 GB for a 1.5 h mono
  lecture). **Rejected** for lecture-length audio.
- `MediaElementAudioSourceNode` (wraps `<audio>`) = **streaming**, low memory.
  One node per element → two `<audio>` for two files.
Target: two `<audio>` → two `MediaElementAudioSourceNode` → two `GainNode`
(`1−level`, `level`) → destination (through the existing channel-mix graph when
present). Two streaming elements have independent heads, so a light drift watch
via `timeupdate` resyncs them — **web-only**, acceptable for a test surface.
Lowest effort — build here first to validate UX + the JS/store/API layer.

## 7. Player store + UI changes

- `usePlayerStore`: add `sourceMixAvailable`, `sourceMixLevel` (persisted),
  `applySourceMix()`, and resolve+download both paths in `openTrack`.
- `FloatingPlayer.vue`: dynamic `PAGE_COUNT`; new page renders a slider
  (reuse/adapt `MixControl` as a 0..1 single-ended variant, or a new
  `SourceMixControl.vue`) bound to `sourceMixLevel`; haptic tick like the others.
- i18n: new `player.sourceMix.*` strings (ru+en together, then the rest).
- Labels make the mode explicit (e.g. "Оригинал ↔ Чистый звук"), distinct from
  channel-mix ("Лево ↔ Право").

## 8. Phasing

1. **JS/API + store + Web** — define `audios[]`/`setSourceMix`, wire the
   store, build the web graph, ship the floating-player slide. Fully testable in
   the browser. ✅ validates UX and the whole non-native stack.
2. **iOS** — `AVAudioEngine` source-mode path.
3. **Android** — decode→mix→`AudioTrack` source-mode path.

Each phase is independently shippable (the slide just won't appear on a platform
until its native path lands; gate by capability).

## 9. Risks & costs

- **2× decode** (battery/CPU) and **2× download/storage** (bandwidth). Offer an
  **economy toggle** / lazy-fetch the clean file on first engage.
- **Lock-screen / now-playing** shows one item (primary) — fine.
- iOS engine swap is the riskiest single change; contain it to source-mode tracks.
- Clean is **mono**; never offer source-mix on a stereo dual-content track.
- Graceful fallback to single-source whenever the clean file is unavailable.

## 10. Producer dependency (feature is inert without it)

Nothing currently creates `clean` rows: `commit` writes only the `original`
`track_audio` row, and `denoiser-service` uploads to caller-chosen S3 keys. For
the slide to ever appear, a pipeline step must:

1. run the denoiser on a track's `original` audio,
2. upload the result to the canonical key `public/tracks/{id}/audio/clean.mp3`,
3. write a `track_audio` row `kind=clean` (path + filesize + duration) for that
   `(track, language)` — e.g. a new `lectorium-mcp` use case / tool, or extend
   commit/a dedicated `track.audio.denoise` step that wraps `denoiser-mcp`.

Until that exists:
- **Prod**: no track has clean → slide never shows (safe no-op).
- **Web/dev testing**: seed a `clean` row + place a `clean.mp3` for one track to
  exercise the UI/graph end-to-end.

This producer is **out of the player's scope** but is a hard prerequisite for the
feature to light up; track it as a sibling task.

## 11. Edge cases (must handle)

- **Duration mismatch** (mp3 re-encode can shift a few ms): `original` is the
  **timeline master** (position/duration/seek). `clean` is slaved; if shorter it
  ends silent, if longer it's truncated. Never let clean drive the clock.
- **Playback rate**: the speed slider must apply to **both** sources identically
  (web: both `playbackRate`; iOS: same time-pitch on both nodes; Android: both
  decoders). A rate applied to one only → instant desync.
- **No zipper noise**: ramp gains over ~10–20 ms on slider change (`setTargetAtTime`
  / linear ramp), never set instantaneously, or the user hears clicks.
- **Endpoints 0 / 1**: at exactly original-only or clean-only the muted source may
  keep decoding (battery) — optional optimization to pause it, but then re-seek it
  to the live position before un-muting (avoid a gap). Default: keep both running
  for simplicity; optimize later.
- **Format mismatch**: `clean` is mono; an `original` could be stereo. Normalize
  both to a common format before the mixer (downmix/route) so the mix node gets
  matching channel layouts.
- **Stream stall/underrun** (one source buffers, the other doesn't) → desync.
  Couple the transports: if either underruns, pause both and resume together
  (web: pause both on `waiting`; native single-graph largely handles this).
- **Queue transitions**: recompute `sourceMixAvailable` on every item change; the
  slide appears/disappears per track. **Clamp the carousel page index** when
  `PAGE_COUNT` shrinks (e.g. was on the source-mix page, next track has no clean).
- **Interruptions / background / route change** (calls, headphones unplug):
  pause/resume both together; single-graph approaches handle this natively.
- **mediaItems migration**: existing single-file rows migrate to
  `(trackId, kind='original')`.
- **Clean evicted by OS** after download: on play, re-resolve per kind; if clean
  gone, disable the slide and best-effort re-fetch.
- **setSourceMix on a single-source track**: native must no-op safely.

## 12. Open decisions

1. **DECIDED** — Slider is single-ended **[0..1]**: left = `original` (**default
   0**, "plays original"), drag right gradually mixes in `clean`, far right = pure
   `clean`. New carousel page (placement below speed, TBD-minor).
4. **DECIDED** — Level is a **global persisted preference** (like speed), but its
   **default is 0 (original)**; applied per track when clean is available.
2. **OPEN** — Fetch policy: download clean eagerly with original (offline save), or
   lazily on first engage? (proposed: eager on offline-save; original-first +
   clean-in-background on playback.)
3. **OPEN (iOS, phase 2)** — full `AVAudioEngine` migration vs engine-only-for-
   source-mode (propose the latter).

# @shruti/plugin-audio-player


## Install

```bash
npm install @shruti/plugin-audio-player
npx cap sync
```

## API

<docgen-index>

* [`open(...)`](#open)
* [`play()`](#play)
* [`togglePause()`](#togglepause)
* [`seek(...)`](#seek)
* [`seekBy(...)`](#seekby)
* [`stop()`](#stop)
* [`setMix(...)`](#setmix)
* [`setPlaybackRate(...)`](#setplaybackrate)
* [`setProgressInterval(...)`](#setprogressinterval)
* [`onProgressChanged(...)`](#onprogresschanged)
* [`onPositionJump(...)`](#onpositionjump)
* [`setQueue(...)`](#setqueue)
* [`appendToQueue(...)`](#appendtoqueue)
* [`getQueueState()`](#getqueuestate)
* [`ackEvents(...)`](#ackevents)
* [`skipToNext()`](#skiptonext)
* [`skipToPrevious()`](#skiptoprevious)
* [`onItemTransition(...)`](#onitemtransition)
* [Interfaces](#interfaces)
* [Type Aliases](#type-aliases)

</docgen-index>

<docgen-api>
<!--Update the source file JSDoc comments and rerun docgen to update the docs below-->

### open(...)

```typescript
open(params: OpenParams) => Promise<void>
```

| Param        | Type                                              |
| ------------ | ------------------------------------------------- |
| **`params`** | <code><a href="#openparams">OpenParams</a></code> |

--------------------


### play()

```typescript
play() => Promise<void>
```

--------------------


### togglePause()

```typescript
togglePause() => Promise<void>
```

--------------------


### seek(...)

```typescript
seek(options: { position: number; }) => Promise<void>
```

| Param         | Type                               |
| ------------- | ---------------------------------- |
| **`options`** | <code>{ position: number; }</code> |

--------------------


### seekBy(...)

```typescript
seekBy(options: SeekByParams) => Promise<void>
```

| Param         | Type                                                  |
| ------------- | ----------------------------------------------------- |
| **`options`** | <code><a href="#seekbyparams">SeekByParams</a></code> |

--------------------


### stop()

```typescript
stop() => Promise<void>
```

--------------------


### setMix(...)

```typescript
setMix(params: SetMixParams) => Promise<void>
```

| Param        | Type                                                  |
| ------------ | ----------------------------------------------------- |
| **`params`** | <code><a href="#setmixparams">SetMixParams</a></code> |

--------------------


### setPlaybackRate(...)

```typescript
setPlaybackRate(params: SetPlaybackRateParams) => Promise<void>
```

| Param        | Type                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| **`params`** | <code><a href="#setplaybackrateparams">SetPlaybackRateParams</a></code> |

--------------------


### setProgressInterval(...)

```typescript
setProgressInterval(params: SetProgressIntervalParams) => Promise<void>
```

| Param        | Type                                                                            |
| ------------ | ------------------------------------------------------------------------------- |
| **`params`** | <code><a href="#setprogressintervalparams">SetProgressIntervalParams</a></code> |

--------------------


### onProgressChanged(...)

```typescript
onProgressChanged(callback: (status: Status) => void) => Promise<AudioPlayerListenerResult>
```

| Param          | Type                                                           |
| -------------- | -------------------------------------------------------------- |
| **`callback`** | <code>(status: <a href="#status">Status</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#audioplayerlistenerresult">AudioPlayerListenerResult</a>&gt;</code>

--------------------


### onPositionJump(...)

```typescript
onPositionJump(callback: (jump: PositionJump) => void) => Promise<AudioPlayerListenerResult>
```

Engine-initiated position jumps (lock screen, remote controls), so the
app can journal the discontinuity rather than count the skipped audio
as listened.

| Param          | Type                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| **`callback`** | <code>(jump: <a href="#positionjump">PositionJump</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#audioplayerlistenerresult">AudioPlayerListenerResult</a>&gt;</code>

--------------------


### setQueue(...)

```typescript
setQueue(params: SetQueueParams) => Promise<void>
```

Replace the playback queue and start at `startIndex` /
`startPosition`. A single track is just a queue of length 1, so this
is the one play path — `open()` is kept as a thin convenience wrapper
over a 1-item queue on the app side.

| Param        | Type                                                      |
| ------------ | --------------------------------------------------------- |
| **`params`** | <code><a href="#setqueueparams">SetQueueParams</a></code> |

--------------------


### appendToQueue(...)

```typescript
appendToQueue(params: { items: QueueItem[]; }) => Promise<void>
```

Append items to the tail of the current queue (e.g. on resume when a
download finished while backgrounded).

| Param        | Type                                 |
| ------------ | ------------------------------------ |
| **`params`** | <code>{ items: QueueItem[]; }</code> |

--------------------


### getQueueState()

```typescript
getQueueState() => Promise<QueueState>
```

Read the now-playing snapshot + the buffered transition journal.
Does not clear the journal — see `ackEvents`.

**Returns:** <code>Promise&lt;<a href="#queuestate">QueueState</a>&gt;</code>

--------------------


### ackEvents(...)

```typescript
ackEvents(options: { upToSeq: number; }) => Promise<void>
```

Clear journal entries with `seq &lt;= upToSeq` once JS has persisted
them. Idempotent; survives multiple background→kill cycles.

| Param         | Type                              |
| ------------- | --------------------------------- |
| **`options`** | <code>{ upToSeq: number; }</code> |

--------------------


### skipToNext()

```typescript
skipToNext() => Promise<void>
```

Lock-screen / in-app skip to the next queue item.

--------------------


### skipToPrevious()

```typescript
skipToPrevious() => Promise<void>
```

Lock-screen / in-app skip to the previous queue item.

--------------------


### onItemTransition(...)

```typescript
onItemTransition(callback: (transition: QueueTransition) => void) => Promise<AudioPlayerListenerResult>
```

Best-effort foreground push on each transition — pure UI sugar; the
durable journal drained via `getQueueState` is the source of truth.

| Param          | Type                                                                                 |
| -------------- | ------------------------------------------------------------------------------------ |
| **`callback`** | <code>(transition: <a href="#queuetransition">QueueTransition</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#audioplayerlistenerresult">AudioPlayerListenerResult</a>&gt;</code>

--------------------


### Interfaces


#### AudioPlayerListenerResult

| Prop             | Type                |
| ---------------- | ------------------- |
| **`callbackId`** | <code>string</code> |


### Type Aliases


#### OpenParams

Open file request parameters for the audio player.

<code>{ // The ID of the playlist item associated with this file itemId: string, // The URL of the audio track to play url: string, // The title of the audio track to be displayed // in the system player UI title: string, // The author of the audio track to be displayed // in the system player UI author: string, // Optional http(s)/content artwork URL shown as the system player / // lock-screen large icon. file:// URLs are ignored — native falls back // to a bundled branded image instead. cover?: string, }</code>


#### SeekByParams

Relative seek by the given delta in seconds (negative = back). The
implementations clamp to `[0, duration]` so callers can fire ±N
without worrying about the boundaries.

<code>{ delta: number }</code>


#### SetMixParams

Stereo-mix configuration.

Stereo recordings in our corpus may carry the original lecture in the
left channel and a translation in the right channel. Played as native
stereo this is uncomfortable in headphones — each ear hears different
content. `setMix` lets the UI blend both channels into a single mono
signal sent to both ears, with `ratio` controlling the bias between
left (original) and right (translation).

When `enabled` is false the plugin must pass the original stereo
through unchanged, so users who want the raw bilingual experience
still get it.

<code>{ enabled: boolean /** * 0 — both ears hear the left channel (original) only. * 1 — both ears hear the right channel (translation) only. * 0.5 — balanced mono mix of both channels. * * Implementations apply loudness compensation so perceived volume * stays roughly constant across the range. */ ratio: number }</code>


#### SetPlaybackRateParams

Playback rate. `1.0` is normal speed; `2.0` is double-speed. The
implementations preserve pitch (no chipmunk effect) — `preservesPitch`
on web, `PlaybackParameters` with `pitch=1` on Android, and
`audioTimePitchAlgorithm = .timeDomain` on iOS.

<code>{ rate: number }</code>


#### SetProgressIntervalParams

How often the engine should push progress (`onProgressChanged`) to the
WebView while playing. This governs ONLY the JS bridge — the system
player / lock screen updates independently and interpolates position
between updates, so it stays smooth regardless of this value.

The caller adapts it to context: ~500 ms when a transcript view needs
sub-second word highlighting, ~1000 ms when only the floating-player
progress ring is visible, and a slow heartbeat (e.g. 5000 ms) when the
app is backgrounded — where a 2 Hz stream would otherwise pile up in
the (throttled) WebView and flush as a janky burst on resume.

<code>{ /** Emit interval in milliseconds. Clamped to a sane floor by the engine. */ intervalMs: number }</code>


#### Status

<a href="#status">Status</a> of the audio player.
Contains information about the current playback state.

<code>{ itemId: string, playing: boolean, position: number, duration: number, }</code>


#### PositionJump

A position jump the engine performed without JS asking — lock-screen
scrubbing, the system ±15s / seek commands, a Bluetooth remote. Seeks made
through `seek()` / `seekBy()` are deliberately NOT reported: the caller
already knows about those and journals them itself.

Positions in seconds, like the rest of this surface.

<code>{ itemId: string fromPosition: number toPosition: number }</code>


#### SetQueueParams

<code>{ items: QueueItem[] // Index within `items` to start playback from. startIndex: number // Resume position for the start item, in seconds. Auto-advanced items // always start at 0; only the start item honours this. startPosition: number }</code>


#### QueueItem

One entry in the native playback queue. The whole point of the queue
is **background continuous playback**: native (ExoPlayer playlist /
AVQueuePlayer) advances through these items on its own when the app's
JS is suspended. So every item carries everything native needs to play
it and to label the lock screen without calling back into JS.

Positions/durations are in **seconds** here, matching the rest of the
plugin surface (the app-side adapter converts to milliseconds).

<code>{ // Playlist item id — the bookkeeping key echoed back in <a href="#status">Status</a> / events itemId: string // file:// (preferred) or HTTP url url: string title: string author: string // Optional http(s)/content artwork URL for the lock-screen large icon; // file:// is ignored in favour of a bundled branded image. cover?: string // Total duration in seconds, if known. Lets native report a completion // duration in transition events without probing the media. duration?: number }</code>


#### QueueState

Snapshot of the native player + the drained transition journal. JS
reads this on launch/resume to (a) reconcile what played in the
background into `listening_sessions`, and (b) resync the now-playing
UI. Reading does NOT clear the journal — call `ackEvents` after the
events have been persisted so nothing is lost on a crash mid-drain.

<code>{ currentItemId: string | null // Current position / duration of the now-playing item, in seconds. position: number duration: number playing: boolean events: QueueTransition[] }</code>


#### QueueTransition

A record of one item finishing and (maybe) the next starting. Native
appends one of these to a **durable on-disk journal** the instant it
happens — so the log survives the app being killed in the background
before JS ever wakes. JS drains the journal on next launch / resume.

Only `reason: "auto"` (a natural end) means the item was completed; a
skip or an error finishes the item at `finishedAt` &lt; `duration`.

<code>{ finishedItemId: string // Where listening on the finished item began (its resume point / 0), s. fromPosition: number // Position the finished item ended at, in seconds (~= duration on auto). finishedAt: number // Total duration of the finished item, in seconds. duration: number // The item that started playing next, or null when the queue ran dry. startedItemId: string | null reason: "auto" | "skip-next" | "skip-prev" | "error" // Native wall-clock when the transition happened (epoch ms). The // completion may be hours old by the time JS drains it. at: number // Native wall-clock when listening on this item BEGAN (epoch ms) — the // `fromPosition` counterpart, so `[fromAt, at]` is the run's real // wall-clock span instead of one estimated from the audio span at 1×. // Absent on entries an older build left in the durable journal. fromAt?: number // Monotonic per-install sequence — drives the idempotent ack-based clear. seq: number }</code>

</docgen-api>

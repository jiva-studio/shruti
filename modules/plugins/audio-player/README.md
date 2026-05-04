# @lectorium/plugin-audio-player


## Install

```bash
npm install @lectorium/plugin-audio-player
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
* [`onProgressChanged(...)`](#onprogresschanged)
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


### onProgressChanged(...)

```typescript
onProgressChanged(callback: (status: Status) => void) => Promise<AudioPlayerListenerResult>
```

| Param          | Type                                                           |
| -------------- | -------------------------------------------------------------- |
| **`callback`** | <code>(status: <a href="#status">Status</a>) =&gt; void</code> |

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

<code>{ // The ID of the playlist item associated with this file itemId: string, // The URL of the audio track to play url: string, // The title of the audio track to be displayed // in the system player UI title: string, // The author of the audio track to be displayed // in the system player UI author: string, }</code>


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


#### Status

<a href="#status">Status</a> of the audio player.
Contains information about the current playback state.

<code>{ itemId: string, playing: boolean, position: number, duration: number, }</code>

</docgen-api>

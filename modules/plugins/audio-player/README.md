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
* [`stop()`](#stop)
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


### stop()

```typescript
stop() => Promise<void>
```

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


#### Status

<a href="#status">Status</a> of the audio player.
Contains information about the current playback state.

<code>{ itemId: string, playing: boolean, position: number, duration: number, }</code>

</docgen-api>

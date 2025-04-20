# @lectorium/audio-player


## Install

```bash
npm install @lectorium/audio-player
npx cap sync
```

## API

<docgen-index>

- [@lectorium/audio-player](#lectoriumaudio-player)
  - [Install](#install)
  - [API](#api)
    - [open(...)](#open)
    - [play()](#play)
    - [togglePause()](#togglepause)
    - [seek(...)](#seek)
    - [stop()](#stop)
    - [onProgressChanged(...)](#onprogresschanged)
    - [Interfaces](#interfaces)
      - [AudioPlayerListenerResult](#audioplayerlistenerresult)
    - [Type Aliases](#type-aliases)
      - [OpenParams](#openparams)
      - [Status](#status)

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

<code>{ url: string, title: string, author: string, trackId: string, }</code>


#### Status

<code>{ position: number, playing: boolean, duration: number, trackId: string, }</code>

</docgen-api>

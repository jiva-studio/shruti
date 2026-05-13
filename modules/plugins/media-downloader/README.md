# @shruti/plugin-media-downloader

Background-capable media downloader for Shruti.

- Android: WorkManager + OkHttp + foreground service.
- iOS: URLSessionConfiguration.background.
- Web: fetch streaming + Cache API.

<docgen-index>

* [`download(...)`](#download)
* [`pause(...)`](#pause)
* [`resume(...)`](#resume)
* [`cancel(...)`](#cancel)
* [`getTask(...)`](#gettask)
* [`listTasks()`](#listtasks)
* [`resolveLocalUrl(...)`](#resolvelocalurl)
* [`deleteFile(...)`](#deletefile)
* [`addListener('progress', ...)`](#addlistenerprogress-)
* [`addListener('stateChanged', ...)`](#addlistenerstatechanged-)
* [`addListener('completed', ...)`](#addlistenercompleted-)
* [`addListener('failed', ...)`](#addlistenerfailed-)
* [`removeAllListeners()`](#removealllisteners)
* [Interfaces](#interfaces)
* [Type Aliases](#type-aliases)

</docgen-index>

<docgen-api>
<!--Update the source file JSDoc comments and rerun docgen to update the docs below-->

Background-capable media downloader.

Native implementations:
- Android: WorkManager + OkHttp. Survives app suspension within WorkManager's regular (non-foreground) execution window (~10 min per attempt).
- iOS:     URLSession with `.background` configuration. Survives app suspension; the OS may relaunch the app to deliver completion events.
- Web:     fetch streaming + Cache API. Background lifecycle is bound to the tab; this implementation is for parity / local development.

### download(...)

```typescript
download(options: DownloadOptions) => Promise<DownloadTask>
```

Start a download (or attach to an in-flight one with the same `id`).
Returns the initial <a href="#downloadtask">`DownloadTask`</a> snapshot. Progress is delivered via
the `progress` event; final completion via `completed` (or `failed`).

| Param         | Type                                                        |
| ------------- | ----------------------------------------------------------- |
| **`options`** | <code><a href="#downloadoptions">DownloadOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#downloadtask">DownloadTask</a>&gt;</code>

--------------------


### pause(...)

```typescript
pause(options: { id: string; }) => Promise<void>
```

iOS only. Android rejects with "not supported".

| Param         | Type                         |
| ------------- | ---------------------------- |
| **`options`** | <code>{ id: string; }</code> |

--------------------


### resume(...)

```typescript
resume(options: { id: string; }) => Promise<void>
```

| Param         | Type                         |
| ------------- | ---------------------------- |
| **`options`** | <code>{ id: string; }</code> |

--------------------


### cancel(...)

```typescript
cancel(options: { id: string; deletePartial?: boolean; }) => Promise<void>
```

Cancel and remove the task. Optionally delete the partial file on disk.

| Param         | Type                                                  |
| ------------- | ----------------------------------------------------- |
| **`options`** | <code>{ id: string; deletePartial?: boolean; }</code> |

--------------------


### getTask(...)

```typescript
getTask(options: { id: string; }) => Promise<{ task: DownloadTask | null; }>
```

Snapshot of one task by id. Returns `{ task: null }` if the platform doesn't know it.
The wrapping object is required because Capacitor cannot resolve a bare `null`.

| Param         | Type                         |
| ------------- | ---------------------------- |
| **`options`** | <code>{ id: string; }</code> |

**Returns:** <code>Promise&lt;{ task: <a href="#downloadtask">DownloadTask</a> | null; }&gt;</code>

--------------------


### listTasks()

```typescript
listTasks() => Promise<{ tasks: DownloadTask[]; }>
```

Snapshot of every task the platform currently tracks (running + recently completed).
Used at app start to rebuild UI state after a kill/relaunch.

**Returns:** <code>Promise&lt;{ tasks: DownloadTask[]; }&gt;</code>

--------------------


### resolveLocalUrl(...)

```typescript
resolveLocalUrl(options: { url: string; }) => Promise<{ localUrl: string | null; }>
```

Resolve a previously-downloaded URL to a local URI, or `null` if not cached.

| Param         | Type                          |
| ------------- | ----------------------------- |
| **`options`** | <code>{ url: string; }</code> |

**Returns:** <code>Promise&lt;{ localUrl: string | null; }&gt;</code>

--------------------


### deleteFile(...)

```typescript
deleteFile(options: { url: string; }) => Promise<void>
```

Delete a cached file by its source URL. No-op if it doesn't exist.

| Param         | Type                          |
| ------------- | ----------------------------- |
| **`options`** | <code>{ url: string; }</code> |

--------------------


### addListener('progress', ...)

```typescript
addListener(event: 'progress', listenerFunc: (event: ProgressEvent) => void) => Promise<PluginListenerHandle>
```

| Param              | Type                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| **`event`**        | <code>'progress'</code>                                                     |
| **`listenerFunc`** | <code>(event: <a href="#progressevent">ProgressEvent</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;</code>

--------------------


### addListener('stateChanged', ...)

```typescript
addListener(event: 'stateChanged', listenerFunc: (event: StateChangedEvent) => void) => Promise<PluginListenerHandle>
```

| Param              | Type                                                                                |
| ------------------ | ----------------------------------------------------------------------------------- |
| **`event`**        | <code>'stateChanged'</code>                                                         |
| **`listenerFunc`** | <code>(event: <a href="#statechangedevent">StateChangedEvent</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;</code>

--------------------


### addListener('completed', ...)

```typescript
addListener(event: 'completed', listenerFunc: (event: CompletedEvent) => void) => Promise<PluginListenerHandle>
```

| Param              | Type                                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| **`event`**        | <code>'completed'</code>                                                      |
| **`listenerFunc`** | <code>(event: <a href="#completedevent">CompletedEvent</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;</code>

--------------------


### addListener('failed', ...)

```typescript
addListener(event: 'failed', listenerFunc: (event: FailedEvent) => void) => Promise<PluginListenerHandle>
```

| Param              | Type                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| **`event`**        | <code>'failed'</code>                                                   |
| **`listenerFunc`** | <code>(event: <a href="#failedevent">FailedEvent</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;</code>

--------------------


### removeAllListeners()

```typescript
removeAllListeners() => Promise<void>
```

--------------------


### Interfaces


#### DownloadTask

| Prop                  | Type                                            | Description                                                                     |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| **`id`**              | <code>string</code>                             |                                                                                 |
| **`state`**           | <code><a href="#taskstate">TaskState</a></code> |                                                                                 |
| **`progress`**        | <code>number</code>                             | 0..1. Undefined while contentLength is unknown (server omitted Content-Length). |
| **`bytesDownloaded`** | <code>number</code>                             |                                                                                 |
| **`contentLength`**   | <code>number</code>                             |                                                                                 |
| **`localUrl`**        | <code>string</code>                             | Local URI of the finished file. Present only when `state === "completed"`.      |
| **`error`**           | <code>string</code>                             | Failure reason. Present only when `state === "failed"`.                         |


#### DownloadOptions

Options for `download()`. The `id` is app-chosen and is the addressing
key for `getTask` / `cancel` / events. Calling `download()` with an `id`
that is already in flight returns the existing task (idempotent).

| Prop              | Type                                                                | Description                                     |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| **`id`**          | <code>string</code>                                                 |                                                 |
| **`url`**         | <code>string</code>                                                 |                                                 |
| **`destination`** | <code><a href="#downloaddestination">DownloadDestination</a></code> |                                                 |
| **`headers`**     | <code><a href="#record">Record</a>&lt;string, string&gt;</code>     | Extra HTTP request headers (auth tokens, etc.). |
| **`network`**     | <code>'any' \| 'wifi-only'</code>                                   | Restrict the network type. Default `"any"`.     |


#### PluginListenerHandle

| Prop         | Type                                      |
| ------------ | ----------------------------------------- |
| **`remove`** | <code>() =&gt; Promise&lt;void&gt;</code> |


#### ProgressEvent

| Prop                  | Type                | Description                                      |
| --------------------- | ------------------- | ------------------------------------------------ |
| **`id`**              | <code>string</code> |                                                  |
| **`bytesDownloaded`** | <code>number</code> |                                                  |
| **`contentLength`**   | <code>number</code> |                                                  |
| **`progress`**        | <code>number</code> | 0..1. Undefined when contentLength is 0/unknown. |


#### StateChangedEvent

| Prop       | Type                                                  |
| ---------- | ----------------------------------------------------- |
| **`task`** | <code><a href="#downloadtask">DownloadTask</a></code> |


#### CompletedEvent

| Prop                  | Type                |
| --------------------- | ------------------- |
| **`id`**              | <code>string</code> |
| **`localUrl`**        | <code>string</code> |
| **`bytesDownloaded`** | <code>number</code> |


#### FailedEvent

| Prop            | Type                 | Description                                                                              |
| --------------- | -------------------- | ---------------------------------------------------------------------------------------- |
| **`id`**        | <code>string</code>  |                                                                                          |
| **`error`**     | <code>string</code>  |                                                                                          |
| **`retryable`** | <code>boolean</code> | Whether the failure is recoverable on retry (network drop) vs terminal (404, disk full). |


### Type Aliases


#### TaskState

<code>'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'</code>


#### DownloadDestination

Where the downloaded file should land on disk.

`directory` selects the platform-specific base folder:
- `cache` → maps to `Context.cacheDir` on Android, `NSCachesDirectory` on iOS,
  `caches.open(...)` on Web. Files here may be evicted by the OS under
  storage pressure.
- `data`  → maps to app-private persistent storage (Android `filesDir`,
  iOS `NSDocumentDirectory`). Web treats it identically to `cache`.

The final path is `&lt;base&gt;/&lt;subdir&gt;/&lt;filename&gt;`. `subdir` is optional;
when absent the file is written directly under `&lt;base&gt;`.

<code>{ directory: 'cache' | 'data'; subdir?: string; filename: string; }</code>


#### Record

Construct a type with a set of properties K of type T

<code>{ [P in K]: T; }</code>

</docgen-api>

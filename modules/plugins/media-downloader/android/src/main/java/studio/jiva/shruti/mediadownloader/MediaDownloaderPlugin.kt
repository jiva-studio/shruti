package studio.jiva.shruti.mediadownloader

import android.os.Handler
import android.os.Looper
import androidx.lifecycle.LiveData
import androidx.lifecycle.Observer
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import java.io.File
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Capacitor bridge for `MediaDownloader`.
 *
 * Lifecycle:
 *  - `download(options)` → enqueue a `DownloadWorker` request, persist
 *    metadata in `DownloadStore`, observe its `LiveData<WorkInfo>`,
 *    forward state/progress to JS via `notifyListeners`.
 *  - On plugin `load()` we re-attach observers to every WorkRequest with
 *    the global tag, so progress for downloads that survived a process
 *    restart keeps flowing into the UI.
 *
 * Path resolution: the JS adapter passes a `destination` whose `directory`
 * selects the base folder — `"data"` → `filesDir` (durable; used for the
 * user's saved-for-offline audio + transcripts) or `"cache"` → `cacheDir`
 * (OS-reclaimable; used for ephemeral share clips). We don't second-guess
 * the subdir/filename (computed from the URL pathname); we just create
 * parent dirs and let the worker write there.
 */
@CapacitorPlugin(name = "MediaDownloader")
class MediaDownloaderPlugin : Plugin() {

    private val activeObservers = mutableMapOf<UUID, Observer<WorkInfo?>>()
    private val activeLiveData = mutableMapOf<UUID, LiveData<WorkInfo?>>()
    // Workers that `download()` replaced with a fresh request under the same
    // id. Their CANCELLED delivery must never reach JS: events are addressed
    // by `id`, so it would settle — and thereby cancel — the download that
    // just started. Written from Capacitor's background thread, read on the
    // main looper, hence the concurrent set.
    private val supersededWorkers: MutableSet<UUID> =
        Collections.newSetFromMap(ConcurrentHashMap())
    private lateinit var store: DownloadStore
    // Capacitor invokes plugin methods on a background HandlerThread, but
    // LiveData.observeForever() / removeObserver() must run on the main
    // thread. We post all observer mutations through this main looper.
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun load() {
        super.load()
        store = DownloadStore(context)
        // Reconciling with WorkManager blocks, and `load()` runs on the main
        // thread — so it happens on a thread of our own that then goes away.
        Thread({ reattachSurvivors() }, "media-downloader-reattach").start()
    }

    /**
     * Re-subscribe to the downloads that outlived the previous process, and
     * drop the entries that are only weight.
     *
     * A completed entry is no longer a task — it is the index that maps a
     * file key to the file on disk — so the steady state of a library full of
     * saved lectures and nothing downloading asks WorkManager nothing at all
     * and observes nothing. What is left is answered in ONE query.
     *
     * Anything WorkManager has forgotten (it prunes finished work) or has
     * finished is kept only while its file is still there; a failed attempt
     * leaves none, which is what stops the store growing with every failure
     * and every extra CDN candidate for the life of the install.
     */
    private fun reattachSurvivors() {
        val pending = store.all().filter { !it.completed }
        if (pending.isEmpty()) return
        // Never prune on a query we could not make: an entry whose file is
        // not on disk yet is a download in progress, not a dead one.
        val infos = runCatching { workInfoByWorkerId() }.getOrNull() ?: return
        for (entry in pending) {
            // A `download()` on the plugin thread may have re-enqueued this
            // id while we were querying; that entry is not ours to judge.
            if (store.get(entry.id)?.workerId != entry.workerId) continue
            val state = infos[entry.workerId]?.state
            when {
                state != null && !state.isFinished -> attachObserver(entry.id, entry.workerId)
                File(entry.localPath).exists() -> store.put(entry.copy(completed = true))
                else -> store.remove(entry.id)
            }
        }
    }

    override fun handleOnDestroy() {
        // Detach observers but leave the WorkManager queue intact.
        // removeObserver() must run on main thread.
        mainHandler.post {
            for ((id, observer) in activeObservers) {
                activeLiveData[id]?.removeObserver(observer)
            }
            activeObservers.clear()
            activeLiveData.clear()
        }
        super.handleOnDestroy()
    }

    // ── Plugin API ────────────────────────────────────────────────────────

    @PluginMethod
    fun download(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("'id' is required")
        val url = call.getString("url") ?: return call.reject("'url' is required")
        val fileKey = call.getString("fileKey") ?: return call.reject("'fileKey' is required")
        val destination = call.getObject("destination")
            ?: return call.reject("'destination' is required")

        val localPath = resolveLocalPath(destination)
            ?: return call.reject("invalid destination")

        // Idempotency vs. recovery. If this id is already tracked we only
        // ride the existing work when it is *genuinely running* — then a
        // duplicate download() is a no-op that returns live state.
        //
        // Any other prior state is treated as stale and replaced. After a
        // process death mid-download (common on OEMs that aggressively kill
        // background WorkManager jobs — MIUI/Xiaomi et al.) the job is left
        // ENQUEUED/BLOCKED and may never run again on its own, while a partial
        // `.download` temp sits on disk. Returning that job would leave the
        // caller spinning on a "pending" task forever (and the final file
        // never appears). So we cancel the stale work, drop its partial temp,
        // and fall through to enqueue a fresh request — every reopen of the
        // app thus re-kicks an interrupted download to completion.
        val existing = store.get(id)
        if (existing != null) {
            val info = WorkManager.getInstance(context).getWorkInfoById(existing.workerId).get()
            if (info != null && info.state == WorkInfo.State.RUNNING) {
                call.resolve(taskJson(id, info, localPath))
                return
            }
            // Retire the old observer BEFORE cancelling. `cancelWorkById` is
            // what makes WorkManager deliver CANCELLED to it, and between
            // that call and the `store.put` below the store still resolves
            // this id to the OLD worker — so the observer would take its
            // normal path and emit a `cancelled` event under an id the fresh
            // request is about to reuse, rejecting the download we are
            // starting. Marking first (and detaching) closes that window
            // regardless of how the two main-looper posts interleave.
            supersededWorkers.add(existing.workerId)
            detach(existing.workerId)
            WorkManager.getInstance(context).cancelWorkById(existing.workerId)
            // The partial is only ours to drop when no live sibling writes to
            // the same path — hedged candidates share a destination while
            // differing in id, so this entry can name the temp another
            // candidate is filling. See `mayDeleteSupersededTemp`.
            if (mayDeleteSupersededTemp(id, existing.localPath, trackedWork())) {
                File(existing.localPath + ".download").delete()
            }
            store.remove(id)
        }

        val network = call.getString("network", "any") ?: "any"
        val headers = call.getObject("headers")

        val constraints = Constraints.Builder()
            .setRequiredNetworkType(if (network == "wifi-only") NetworkType.UNMETERED else NetworkType.CONNECTED)
            .build()

        val input: Data = workDataOf(
            DownloadWorker.INPUT_URL to url,
            DownloadWorker.INPUT_LOCAL_PATH to localPath,
            DownloadWorker.INPUT_HEADERS to serialiseHeaders(headers),
        )

        val request = OneTimeWorkRequestBuilder<DownloadWorker>()
            .setInputData(input)
            .setConstraints(constraints)
            .addTag(DownloadWorker.GLOBAL_TAG)
            .addTag(id)
            .build()

        store.put(DownloadStore.Entry(id, request.id, fileKey, url, localPath))
        WorkManager.getInstance(context).enqueue(request)
        attachObserver(id, request.id)

        val task = JSObject().apply {
            put("id", id)
            put("state", "pending")
            put("bytesDownloaded", 0)
            put("contentLength", 0)
        }
        call.resolve(task)
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        call.reject("pause is not supported on Android")
    }

    @PluginMethod
    fun resume(call: PluginCall) {
        call.reject("resume is not supported on Android")
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("'id' is required")
        val deletePartial = call.getBoolean("deletePartial", false) ?: false
        val entry = store.get(id) ?: run { call.resolve(); return }
        WorkManager.getInstance(context).cancelWorkById(entry.workerId)
        if (deletePartial) {
            File(entry.localPath).delete()
            File(entry.localPath + ".download").delete()
        }
        store.remove(id)
        call.resolve()
    }

    @PluginMethod
    fun getTask(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("'id' is required")
        val entry = store.get(id) ?: run {
            call.resolve(JSObject().apply { put("task", JSObject.NULL) })
            return
        }
        val info = WorkManager.getInstance(context).getWorkInfoById(entry.workerId).get()
        if (info == null) {
            call.resolve(JSObject().apply { put("task", JSObject.NULL) })
            return
        }
        val task = taskJson(id, info, entry.localPath)
        val response = JSObject().apply { put("task", task) }
        call.resolve(response)
    }

    @PluginMethod
    fun listTasks(call: PluginCall) {
        val tasks = JSONArray()
        val infos = workInfoByWorkerId()
        for (entry in store.all()) {
            val info = infos[entry.workerId] ?: continue
            tasks.put(taskJson(entry.id, info, entry.localPath))
        }
        val response = JSObject().apply { put("tasks", tasks) }
        call.resolve(response)
    }

    @PluginMethod
    fun resolveLocalUrl(call: PluginCall) {
        val fileKey = call.getString("fileKey") ?: return call.reject("'fileKey' is required")
        // Any candidate entry for this key names the one destination they all
        // share, so answer with the first that is actually on disk.
        val file = store.findAllByFileKey(fileKey)
            .map { File(it.localPath) }
            .firstOrNull { it.exists() }
        val response = JSObject().apply {
            if (file != null) {
                put("localUrl", "file://" + file.absolutePath)
            } else {
                put("localUrl", JSObject.NULL)
            }
        }
        call.resolve(response)
    }

    @PluginMethod
    fun deleteFile(call: PluginCall) {
        val fileKey = call.getString("fileKey") ?: return call.reject("'fileKey' is required")
        // All of them: one lecture owns an entry per raced CDN candidate, and
        // dropping only the first stranded the siblings — entries pointing at
        // a file that is no longer there, which nothing would ever clean up.
        for (entry in store.findAllByFileKey(fileKey)) {
            val file = File(entry.localPath)
            file.delete()
            File(entry.localPath + ".download").delete()
            pruneEmptyParents(file)
            store.remove(entry.id)
        }
        call.resolve()
    }

    // ── WorkManager bridging ──────────────────────────────────────────────

    private fun attachObserver(id: String, workerId: UUID) {
        // Capacitor calls plugin methods on a background HandlerThread, but
        // both `getWorkInfoByIdLiveData()` returns a LiveData whose
        // `observeForever()` enforces main-thread access. Hop to main here
        // and do the entire LiveData wiring there.
        mainHandler.post {
            if (activeObservers.containsKey(workerId)) return@post
            val live = WorkManager.getInstance(context).getWorkInfoByIdLiveData(workerId)
            val observer = Observer<WorkInfo?> { info ->
                if (info == null) return@Observer
                val known = store.findByWorkerId(workerId)
                // Whether this update may be reported at all — a cancelled
                // worker the caller awaits, or one `download()` replaced
                // under the same id — is decided by `workUpdateAction`.
                val action = workUpdateAction(
                    superseded = supersededWorkers.remove(workerId),
                    tracksThisWorker = known != null,
                    trackedWorkerId = store.get(id)?.workerId,
                    workerId = workerId,
                    state = info.state,
                )
                when (action) {
                    WorkUpdateAction.WAIT -> return@Observer
                    WorkUpdateAction.DETACH -> {
                        detach(workerId)
                        return@Observer
                    }
                    WorkUpdateAction.REPORT_CANCELLED -> {
                        notifyCancelled(id)
                        detach(workerId)
                        return@Observer
                    }
                    WorkUpdateAction.REPORT_REMOVED -> {
                        notifyRemoved(id)
                        detach(workerId)
                        return@Observer
                    }
                    WorkUpdateAction.PROCEED -> Unit
                }
                // PROCEED is only returned for a worker the store tracks;
                // the elvis restates that for the compiler.
                val entry = known ?: return@Observer
                val task = taskJson(id, info, entry.localPath)

                // Progress from setProgress() while the worker is running.
                val progressBytes = info.progress.getLong(DownloadWorker.PROGRESS_BYTES, 0L)
                val progressTotal = info.progress.getLong(DownloadWorker.PROGRESS_TOTAL, 0L)
                if (info.state == WorkInfo.State.RUNNING && progressBytes > 0) {
                    val progressData = JSObject().apply {
                        put("id", id)
                        put("bytesDownloaded", progressBytes)
                        put("contentLength", progressTotal)
                        if (progressTotal > 0) put("progress", progressBytes.toDouble() / progressTotal.toDouble())
                    }
                    notifyListeners("progress", progressData)
                }

                notifyListeners("stateChanged", JSObject().apply { put("task", task) })

                when (info.state) {
                    WorkInfo.State.SUCCEEDED -> {
                        val output = info.outputData
                        val payload = JSObject().apply {
                            put("id", id)
                            put("localUrl", "file://" + entry.localPath)
                            put("bytesDownloaded", output.getLong(DownloadWorker.OUTPUT_BYTES, 0L))
                        }
                        notifyListeners("completed", payload)
                        // Keep the entry — it is how the file is found again —
                        // but retire it as a task, so the next start neither
                        // queries nor observes it.
                        store.put(entry.copy(completed = true))
                        detach(workerId)
                    }
                    WorkInfo.State.FAILED -> {
                        val message = info.outputData.getString(DownloadWorker.OUTPUT_ERROR) ?: "failed"
                        val payload = JSObject().apply {
                            put("id", id)
                            put("error", message)
                        }
                        notifyListeners("failed", payload)
                        // Nothing landed, so the entry indexes nothing. Only
                        // `download()`, `cancel()` and `deleteFile()` used to
                        // prune, and none of them runs after a failure — so
                        // every failed attempt stayed in the store forever.
                        store.remove(entry.id)
                        detach(workerId)
                    }
                    WorkInfo.State.CANCELLED -> {
                        notifyCancelled(id)
                        store.remove(entry.id)
                        detach(workerId)
                    }
                    else -> { /* ENQUEUED, RUNNING, BLOCKED — keep observing */ }
                }
            }
            activeObservers[workerId] = observer
            activeLiveData[workerId] = live
            // LiveData wants a LifecycleOwner, but Capacitor plugins don't have one.
            // observeForever() is safe because we manage detach() ourselves.
            live.observeForever(observer)
        }
    }

    /**
     * A cancellation is terminal for the JS caller as well: its promise
     * resolves on `completed` and rejects on `failed`, so without an event
     * here it would stay pending forever and never release the download
     * slot. The `cancelled` code distinguishes a deliberate abort from a
     * genuine failure, so the UI can skip the red "retry" affordance.
     */
    private fun notifyCancelled(id: String) {
        val payload = JSObject().apply {
            put("id", id)
            put("error", "cancelled")
            put("code", "cancelled")
        }
        notifyListeners("failed", payload)
    }

    /**
     * The work reached a terminal state after `deleteFile()` dropped its
     * bookkeeping, so there is no local file to hand back even if the bytes
     * did land. Terminal for the caller, and — like a cancellation — the
     * result of a deliberate local action, so the `removed` code keeps the
     * caller from treating it as a CDN fault and rotating to another server
     * for bytes the user just deleted.
     */
    private fun notifyRemoved(id: String) {
        val payload = JSObject().apply {
            put("id", id)
            put("error", "download was removed")
            put("code", "removed")
        }
        notifyListeners("failed", payload)
    }

    private fun detach(workerId: UUID) {
        // observer mutations must happen on the main thread.
        mainHandler.post {
            val observer = activeObservers.remove(workerId) ?: return@post
            activeLiveData.remove(workerId)?.removeObserver(observer)
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /**
     * Every tracked download WorkManager still knows about, with the one bit
     * the cleanup decision needs: whether it can still be writing. An entry
     * whose work has been pruned is dropped rather than assumed live — it has
     * no worker left to hold anything.
     */
    private fun trackedWork(): List<TrackedWork> {
        val infos = workInfoByWorkerId()
        return store.all().mapNotNull { entry ->
            val info = infos[entry.workerId] ?: return@mapNotNull null
            TrackedWork(entry.id, entry.localPath, info.state.isFinished)
        }
    }

    /**
     * Everything WorkManager still knows about our downloads, in ONE query.
     *
     * Asking per entry meant a blocking round trip each, on the background
     * thread Capacitor shares between every plugin — so a walk of the store
     * (which the eviction path takes on each removal) stalled audio-player
     * and preferences calls queued behind it. Every request carries the
     * global tag, so one query answers for all of them.
     */
    private fun workInfoByWorkerId(): Map<UUID, WorkInfo> {
        val infos = WorkManager.getInstance(context)
            .getWorkInfosByTag(DownloadWorker.GLOBAL_TAG)
            .get() ?: return emptyMap()
        return infos.associateBy { it.id }
    }

    /**
     * Drop the directories the deleted file leaves behind (#160).
     *
     * A destination mirrors the URL path, so every track owns a chain of
     * directories that nothing else writes to; removing the file emptied
     * them but left them on disk.
     *
     * `File.delete()` on a directory is the entire guard: it removes an empty
     * one and refuses every other, so there is no "check then remove" window
     * a sibling could lose a file in. That is what protects a hedged CDN
     * candidate still filling the shared `.download` temp — the temp sits in
     * this very directory, which therefore isn't empty. A candidate that has
     * not opened its temp yet leaves nothing to see, but `DownloadWorker`
     * mkdirs the parent chain before it does, so pruning ahead of it costs
     * nothing.
     *
     * Walks up while each level came away, and never past `filesDir` /
     * `cacheDir` — the bases themselves stay.
     */
    private fun pruneEmptyParents(file: File) {
        val bases = listOf(context.filesDir.absolutePath, context.cacheDir.absolutePath)
        var dir: File? = file.parentFile
        while (dir != null) {
            val path = dir.absolutePath
            if (bases.none { path.startsWith("$it/") }) return
            if (!dir.delete()) return
            dir = dir.parentFile
        }
    }

    private fun resolveLocalPath(destination: JSObject): String? {
        val directory = destination.optString("directory", "cache")
        val subdir = destination.optString("subdir", "")
        val filename = destination.optString("filename", "")
        if (filename.isEmpty()) return null
        val base: File = when (directory) {
            "data" -> context.filesDir
            else -> context.cacheDir
        }
        val parent: File = if (subdir.isEmpty()) base else File(base, subdir)
        return File(parent, filename).absolutePath
    }

    private fun serialiseHeaders(headers: JSObject?): String {
        if (headers == null) return ""
        val sb = StringBuilder()
        val keys = headers.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            val v = headers.optString(k, "")
            if (sb.isNotEmpty()) sb.append('\n')
            sb.append(k).append('=').append(v)
        }
        return sb.toString()
    }

    private fun taskJson(id: String, info: WorkInfo, localPath: String): JSObject {
        val state = when (info.state) {
            WorkInfo.State.ENQUEUED -> "pending"
            WorkInfo.State.RUNNING -> "running"
            WorkInfo.State.SUCCEEDED -> "completed"
            WorkInfo.State.FAILED -> "failed"
            WorkInfo.State.CANCELLED -> "cancelled"
            WorkInfo.State.BLOCKED -> "pending"
        }
        val out = info.outputData
        val progressBytes = info.progress.getLong(DownloadWorker.PROGRESS_BYTES, 0L)
        val progressTotal = info.progress.getLong(DownloadWorker.PROGRESS_TOTAL, 0L)
        val finalBytes = out.getLong(DownloadWorker.OUTPUT_BYTES, progressBytes)
        val finalTotal = out.getLong(DownloadWorker.OUTPUT_TOTAL, progressTotal)
        val task = JSObject().apply {
            put("id", id)
            put("state", state)
            put("bytesDownloaded", finalBytes)
            put("contentLength", finalTotal)
            if (finalTotal > 0) put("progress", finalBytes.toDouble() / finalTotal.toDouble())
            if (info.state == WorkInfo.State.SUCCEEDED) {
                put("localUrl", "file://" + localPath)
            }
            if (info.state == WorkInfo.State.FAILED) {
                val msg = out.getString(DownloadWorker.OUTPUT_ERROR) ?: "failed"
                put("error", msg)
            }
        }
        return task
    }
}

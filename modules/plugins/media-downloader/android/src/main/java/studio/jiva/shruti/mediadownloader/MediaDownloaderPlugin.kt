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
import java.util.UUID

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
    private lateinit var store: DownloadStore
    // Capacitor invokes plugin methods on a background HandlerThread, but
    // LiveData.observeForever() / removeObserver() must run on the main
    // thread. We post all observer mutations through this main looper.
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun load() {
        super.load()
        store = DownloadStore(context)
        // Re-subscribe to any tasks that outlived the previous process.
        for (entry in store.all()) attachObserver(entry.id, entry.workerId)
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
        val destination = call.getObject("destination")
            ?: return call.reject("'destination' is required")

        val localPath = resolveLocalPath(destination)
            ?: return call.reject("invalid destination")

        // Idempotency: if this id is already tracked and the worker is alive, return its current state.
        val existing = store.get(id)
        if (existing != null) {
            val info = WorkManager.getInstance(context).getWorkInfoById(existing.workerId).get()
            if (info != null && !info.state.isFinished) {
                call.resolve(taskJson(id, info, localPath))
                return
            }
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

        store.put(DownloadStore.Entry(id, request.id, url, localPath))
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
        val wm = WorkManager.getInstance(context)
        for (entry in store.all()) {
            val info = wm.getWorkInfoById(entry.workerId).get() ?: continue
            tasks.put(taskJson(entry.id, info, entry.localPath))
        }
        val response = JSObject().apply { put("tasks", tasks) }
        call.resolve(response)
    }

    @PluginMethod
    fun resolveLocalUrl(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("'url' is required")
        val entry = store.findByUrl(url)
        val file = entry?.let { File(it.localPath) }
        val response = JSObject().apply {
            if (file != null && file.exists()) {
                put("localUrl", "file://" + file.absolutePath)
            } else {
                put("localUrl", JSObject.NULL)
            }
        }
        call.resolve(response)
    }

    @PluginMethod
    fun deleteFile(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("'url' is required")
        val entry = store.findByUrl(url)
        if (entry != null) {
            File(entry.localPath).delete()
            File(entry.localPath + ".download").delete()
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
                val entry = store.findByWorkerId(workerId) ?: return@Observer
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
                        detach(workerId)
                    }
                    WorkInfo.State.FAILED -> {
                        val message = info.outputData.getString(DownloadWorker.OUTPUT_ERROR) ?: "failed"
                        val retryable = info.runAttemptCount < 3
                        val payload = JSObject().apply {
                            put("id", id)
                            put("error", message)
                            put("retryable", retryable)
                        }
                        notifyListeners("failed", payload)
                        detach(workerId)
                    }
                    WorkInfo.State.CANCELLED -> {
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

    private fun detach(workerId: UUID) {
        // observer mutations must happen on the main thread.
        mainHandler.post {
            val observer = activeObservers.remove(workerId) ?: return@post
            activeLiveData.remove(workerId)?.removeObserver(observer)
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

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

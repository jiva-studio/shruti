package studio.jiva.shruti.mediadownloader

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The worker that actually downloads the file.
 *
 * Runs as a foreground service via setForeground() — required on Android
 * 14+ for any background work that takes longer than ~10s under the
 * dataSync foreground service type. Progress is reported through
 * setProgress() which `MediaDownloaderPlugin` reads via the work info
 * LiveData and forwards to JS.
 *
 * Files are written via OkHttp's streamed response to a temporary
 * .download neighbour, then atomically renamed. That keeps a partial file
 * from being mistaken for a complete one if the worker is interrupted.
 */
internal class DownloadWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    companion object {
        const val GLOBAL_TAG = "lectorium.media-downloader"
        const val INPUT_URL = "url"
        const val INPUT_HEADERS = "headers"          // serialised as String key=value\n pairs
        const val INPUT_LOCAL_PATH = "localPath"
        const val INPUT_NOTIFICATION_TITLE = "notificationTitle"
        const val INPUT_NOTIFICATION_BODY = "notificationBody"
        const val INPUT_SHOW_NOTIFICATION = "showNotification"

        const val PROGRESS_BYTES = "bytes"
        const val PROGRESS_TOTAL = "total"
        const val OUTPUT_LOCAL_PATH = "localPath"
        const val OUTPUT_BYTES = "bytes"
        const val OUTPUT_TOTAL = "total"
        const val OUTPUT_ERROR = "error"

        private const val NOTIFICATION_ID = 0xACD0 // arbitrary, just stable

        // Throttle progress emits so we don't flood the IPC bridge.
        private const val PROGRESS_EMIT_INTERVAL_MS = 100L
    }

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val url = inputData.getString(INPUT_URL)
            ?: return@withContext Result.failure(errorOutput("missing url"))
        val localPath = inputData.getString(INPUT_LOCAL_PATH)
            ?: return@withContext Result.failure(errorOutput("missing localPath"))
        val showNotification = inputData.getBoolean(INPUT_SHOW_NOTIFICATION, true)
        val notificationTitle = inputData.getString(INPUT_NOTIFICATION_TITLE) ?: "Lectorium"
        val notificationBody = inputData.getString(INPUT_NOTIFICATION_BODY) ?: "Downloading..."
        val headers = parseHeaders(inputData.getString(INPUT_HEADERS))

        if (showNotification) {
            try {
                setForeground(buildForegroundInfo(notificationTitle, notificationBody, 0, indeterminate = true))
            } catch (_: Exception) {
                // Falling back to a non-foreground execution; WorkManager
                // will still finish the download but the OS may kill it
                // sooner if the app is backgrounded for a long time.
            }
        }

        val targetFile = File(localPath)
        targetFile.parentFile?.mkdirs()
        val tempFile = File(targetFile.parentFile, targetFile.name + ".download")

        return@withContext try {
            val requestBuilder = Request.Builder().url(url)
            for ((k, v) in headers) requestBuilder.addHeader(k, v)
            val response = client.newCall(requestBuilder.build()).execute()
            if (!response.isSuccessful) {
                response.close()
                return@withContext Result.failure(errorOutput("HTTP ${response.code}"))
            }
            val responseBody = response.body ?: return@withContext Result.failure(errorOutput("empty body"))
            val total = responseBody.contentLength().coerceAtLeast(0L)
            var received = 0L
            var lastEmit = 0L

            responseBody.byteStream().use { input ->
                tempFile.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read == -1) break
                        if (isStopped) {
                            input.close()
                            output.close()
                            tempFile.delete()
                            return@withContext Result.failure(errorOutput("cancelled"))
                        }
                        output.write(buffer, 0, read)
                        received += read

                        val now = System.currentTimeMillis()
                        if (now - lastEmit >= PROGRESS_EMIT_INTERVAL_MS) {
                            lastEmit = now
                            setProgress(workDataOf(
                                PROGRESS_BYTES to received,
                                PROGRESS_TOTAL to total,
                            ))
                            if (showNotification && total > 0) {
                                val pct = ((received * 100) / total).toInt()
                                try {
                                    setForeground(buildForegroundInfo(notificationTitle, notificationBody, pct, indeterminate = false))
                                } catch (_: Exception) { /* see fallback above */ }
                            }
                        }
                    }
                }
            }

            // Final progress + atomic rename.
            setProgress(workDataOf(
                PROGRESS_BYTES to received,
                PROGRESS_TOTAL to (if (total > 0) total else received),
            ))
            if (targetFile.exists()) targetFile.delete()
            if (!tempFile.renameTo(targetFile)) {
                tempFile.delete()
                return@withContext Result.failure(errorOutput("rename failed"))
            }

            Result.success(workDataOf(
                OUTPUT_LOCAL_PATH to targetFile.absolutePath,
                OUTPUT_BYTES to received,
                OUTPUT_TOTAL to (if (total > 0) total else received),
            ))
        } catch (e: IOException) {
            tempFile.delete()
            // Network errors are transient; let WorkManager retry per its
            // default exponential backoff. Anything else is terminal.
            if (runAttemptCount < 3) Result.retry()
            else Result.failure(errorOutput(e.message ?: "io error"))
        } catch (e: Exception) {
            tempFile.delete()
            Result.failure(errorOutput(e.message ?: "unknown error"))
        }
    }

    private fun buildForegroundInfo(
        title: String,
        body: String,
        progressPct: Int,
        indeterminate: Boolean,
    ): ForegroundInfo {
        val notification = DownloadNotification.build(applicationContext, title, body, progressPct, indeterminate)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIFICATION_ID, notification)
        }
    }

    private fun parseHeaders(raw: String?): List<Pair<String, String>> {
        if (raw.isNullOrEmpty()) return emptyList()
        return raw.split('\n').mapNotNull { line ->
            val idx = line.indexOf('=')
            if (idx <= 0) null else line.substring(0, idx) to line.substring(idx + 1)
        }
    }

    private fun errorOutput(message: String) = workDataOf(OUTPUT_ERROR to message)
}

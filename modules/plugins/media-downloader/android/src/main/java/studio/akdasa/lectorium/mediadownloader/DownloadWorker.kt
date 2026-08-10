package studio.jiva.shruti.mediadownloader

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.channels.OverlappingFileLockException
import java.util.concurrent.TimeUnit

/**
 * The worker that actually downloads the file.
 *
 * Runs as a regular (non-foreground) WorkManager task. Typical lecture
 * payloads (30-150 MB) complete in under 10 minutes on wifi/4G, which fits
 * inside the regular execution window. Progress is reported through
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

        const val PROGRESS_BYTES = "bytes"
        const val PROGRESS_TOTAL = "total"
        const val OUTPUT_LOCAL_PATH = "localPath"
        const val OUTPUT_BYTES = "bytes"
        const val OUTPUT_TOTAL = "total"
        const val OUTPUT_ERROR = "error"

        // Throttle progress emits so we don't flood the IPC bridge.
        private const val PROGRESS_EMIT_INTERVAL_MS = 100L
    }

    /**
     * Timeouts are short because this worker no longer owns the retry
     * policy — the JS candidate loop does, and it hedges regions ~5 s apart
     * with a ~15 s ceiling. A 30 s connect would let one dead region hold
     * that whole budget by itself, which is the wait this is meant to end.
     */
    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val url = inputData.getString(INPUT_URL)
            ?: return@withContext Result.failure(errorOutput("missing url"))
        val localPath = inputData.getString(INPUT_LOCAL_PATH)
            ?: return@withContext Result.failure(errorOutput("missing localPath"))
        val headers = parseHeaders(inputData.getString(INPUT_HEADERS))

        val targetFile = File(localPath)
        targetFile.parentFile?.mkdirs()
        val tempFile = File(targetFile.parentFile, targetFile.name + ".download")
        // Several workers can be downloading this same file at once: the JS
        // layer hedges CDN regions against each other and keeps them all
        // pointed at one destination. Only the worker holding the temp file's
        // lock may write to it or delete it — a loser that cleaned up on its
        // way out would unlink the file the winner is still filling, and the
        // winner's final rename would then fail.
        var ownsTempFile = false

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

            // Claim the write. Opened in append mode so the claim is decided
            // BEFORE anything is truncated — opening for truncate first is
            // exactly how a straggler would wipe the winner's bytes.
            val output = FileOutputStream(tempFile, true)
            val lock = try {
                output.channel.tryLock()
            } catch (_: OverlappingFileLockException) {
                null
            }
            if (lock == null) {
                output.close()
                response.close()
                return@withContext Result.failure(errorOutput("another download owns this file"))
            }
            ownsTempFile = true
            output.channel.truncate(0)

            responseBody.byteStream().use { input ->
                output.use {
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
            if (ownsTempFile) tempFile.delete()
            // No retry here. Retrying the SAME dead region was the expensive
            // part of the old behaviour: three attempts plus WorkManager's
            // exponential backoff (clamped at MIN_BACKOFF_MILLIS = 10 s, so
            // `setBackoffCriteria` could not have shortened it) cost minutes
            // before another region was even tried. The JS candidate loop is
            // the retry mechanism now, and it hedges regions in parallel — so
            // every failure here is terminal and must be reported at once.
            Result.failure(errorOutput(e.message ?: "io error"))
        } catch (e: Exception) {
            if (ownsTempFile) tempFile.delete()
            Result.failure(errorOutput(e.message ?: "unknown error"))
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

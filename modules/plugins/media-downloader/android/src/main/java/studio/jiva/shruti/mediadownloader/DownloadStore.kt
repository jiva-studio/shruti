package studio.jiva.shruti.mediadownloader

import android.content.Context
import org.json.JSONObject
import java.util.UUID

/**
 * Per-download metadata that lives outside WorkManager's own data:
 *  - the file key (the caller's name for the file, so a saved file is still
 *    found after the active CDN changes) and the source URL it came from
 *  - the absolute on-disk path of the eventual file
 *  - the Worker UUID (so we can address WorkManager APIs by id-string)
 *
 * WorkManager already persists its queue to its own SQLite DB, so this
 * store only adds the small bits WorkManager doesn't track for us.
 *
 * Backed by SharedPreferences. Tiny dataset, simple format.
 */
internal class DownloadStore(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences(
        "shruti.media-downloader.tasks",
        Context.MODE_PRIVATE,
    )

    data class Entry(
        val id: String,
        val workerId: UUID,
        /**
         * What names the file, independent of the host it was fetched from.
         * Several CDNs serve the same file and which one is active changes
         * under the app, so an entry indexed by its URL became unfindable the
         * moment the region did — and the caller read that miss as "the
         * download is gone".
         */
        val fileKey: String,
        val url: String,
        val localPath: String,
    )

    fun put(entry: Entry) {
        val json = JSONObject().apply {
            put("workerId", entry.workerId.toString())
            put("fileKey", entry.fileKey)
            put("url", entry.url)
            put("localPath", entry.localPath)
        }
        prefs.edit().putString(entry.id, json.toString()).apply()
    }

    fun get(id: String): Entry? {
        val raw = prefs.getString(id, null) ?: return null
        return parse(id, raw)
    }

    fun findByFileKey(fileKey: String): Entry? {
        for ((key, raw) in prefs.all) {
            if (raw !is String) continue
            val entry = parse(key, raw) ?: continue
            if (entry.fileKey == fileKey) return entry
        }
        return null
    }

    fun findByWorkerId(workerId: UUID): Entry? {
        for ((key, raw) in prefs.all) {
            if (raw !is String) continue
            val entry = parse(key, raw) ?: continue
            if (entry.workerId == workerId) return entry
        }
        return null
    }

    fun all(): List<Entry> {
        val out = mutableListOf<Entry>()
        for ((key, raw) in prefs.all) {
            if (raw !is String) continue
            parse(key, raw)?.let(out::add)
        }
        return out
    }

    fun remove(id: String) {
        prefs.edit().remove(id).apply()
    }

    private fun parse(id: String, raw: String): Entry? {
        return try {
            val json = JSONObject(raw)
            Entry(
                id = id,
                workerId = UUID.fromString(json.getString("workerId")),
                // Entries written before the key existed are addressed by the
                // path of their URL, which is what the key is — so an upgrade
                // keeps finding files downloaded by the previous build.
                fileKey = json.optString("fileKey").ifEmpty {
                    android.net.Uri.parse(json.getString("url")).path.orEmpty()
                },
                url = json.getString("url"),
                localPath = json.getString("localPath"),
            )
        } catch (_: Exception) {
            null
        }
    }
}

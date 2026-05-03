package studio.jiva.shruti.mediadownloader

import android.content.Context
import org.json.JSONObject
import java.util.UUID

/**
 * Per-download metadata that lives outside WorkManager's own data:
 *  - the source URL (so resolveLocalUrl(url) can find an id)
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
        val url: String,
        val localPath: String,
    )

    fun put(entry: Entry) {
        val json = JSONObject().apply {
            put("workerId", entry.workerId.toString())
            put("url", entry.url)
            put("localPath", entry.localPath)
        }
        prefs.edit().putString(entry.id, json.toString()).apply()
    }

    fun get(id: String): Entry? {
        val raw = prefs.getString(id, null) ?: return null
        return parse(id, raw)
    }

    fun findByUrl(url: String): Entry? {
        for ((key, raw) in prefs.all) {
            if (raw !is String) continue
            val entry = parse(key, raw) ?: continue
            if (entry.url == url) return entry
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
                url = json.getString("url"),
                localPath = json.getString("localPath"),
            )
        } catch (_: Exception) {
            null
        }
    }
}

import type { DailyTotal, ListeningJournal, ListeningSession } from "../../ports/ListeningJournal.js"
import type { Adb } from "./Adb.js"

const DATABASE = "databases/userSQLite.db"

/** The statement crosses two shells; only the device's one sees these quotes. */
function quote(sql: string): string {
  return `'${sql.replace(/'/g, `'\\''`)}'`
}

export class AndroidListeningJournal implements ListeningJournal {
  constructor(private readonly adb: Adb) {}

  async sessions(): Promise<readonly ListeningSession[]> {
    const rows = this.query(
      `SELECT id, item_id, started_at, ended_at, from_position, to_position
         FROM listening_sessions ORDER BY started_at, id`,
    )
    return rows.map(([id, itemId, startedAt, endedAt, fromPosition, toPosition]) => ({
      id: id!,
      itemId: itemId!,
      startedAt: Number(startedAt),
      endedAt: Number(endedAt),
      fromPosition: Number(fromPosition),
      toPosition: Number(toPosition),
    }))
  }

  async dailyTotals(): Promise<readonly DailyTotal[]> {
    // Deliberately the app's own `getDailyTotals`, storm dedup and all, minus
    // its window: a spec asserting on a day should read the number the heatmap
    // will render for it, not a second opinion about what the rows mean.
    const rows = this.query(
      `SELECT date(ended_at, 'unixepoch', 'localtime') AS day,
              SUM(MAX(0, mx_to - from_position))
         FROM (SELECT ended_at, from_position, MAX(to_position) AS mx_to
                 FROM listening_sessions
                GROUP BY item_id, started_at, ended_at, from_position)
        GROUP BY day ORDER BY day`,
    )
    return rows.map(([date, listenedSeconds]) => ({
      date: date!,
      listenedSeconds: Number(listenedSeconds),
    }))
  }

  private query(sql: string): string[][] {
    const statement = quote(sql.replace(/\s+/g, " ").trim())
    const out = this.adb.shell(
      `run-as ${this.adb.appPackage} sqlite3 ${DATABASE} ${statement} 2>/dev/null`,
    )
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("|"))
  }
}

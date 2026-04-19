import nano from "nano"

export interface CouchDbConfig {
  url: string
  user?: string
  password?: string
}

export function connectCouch(cfg: CouchDbConfig): nano.ServerScope {
  if (cfg.user && cfg.password) {
    const url = new URL(cfg.url)
    url.username = encodeURIComponent(cfg.user)
    url.password = encodeURIComponent(cfg.password)
    return nano(url.toString())
  }
  return nano(cfg.url)
}

export async function listAllDocs<T extends { _id: string }>(
  // `any` sidesteps a nano typing quirk where DocumentScope<T> isn't
  // assignable to DocumentScope<unknown> due to method bivariance.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: nano.DocumentScope<any>
): Promise<T[]> {
  const result: T[] = []
  let bookmark: string | undefined
  // 200 per batch — CouchDB default limit is 25; be explicit.
  const limit = 500
  let skip = 0

  while (true) {
    const page = await db.list({
      include_docs: true,
      limit,
      skip,
    })
    if (page.rows.length === 0) break
    for (const row of page.rows) {
      if (row.id.startsWith("_design/")) continue
      if (!row.doc) continue
      result.push(row.doc as unknown as T)
    }
    if (page.rows.length < limit) break
    skip += page.rows.length
    // Avoid infinite loops on bad pagination
    if (skip > 1_000_000) throw new Error("listAllDocs: cursor runaway")
  }

  return result
}

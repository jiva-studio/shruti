import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { connectCouch, listAllDocs, type CouchDbConfig } from "./couchdb.js"

interface CouchTranscriptDoc {
  _id: string  // format: "{trackId}::transcript::{language}"
  version?: number
  blocks: unknown[]
}

export interface ExportStats {
  exported: number
  skipped: number
}

function parseId(id: string): { trackId: string; language: string } | null {
  const match = id.match(/^(.+)::transcript::([a-z0-9-]+)$/i)
  if (!match) return null
  return { trackId: match[1], language: match[2] }
}

export async function exportTranscripts(
  outputDir: string,
  couchCfg: CouchDbConfig
): Promise<ExportStats> {
  const cx = connectCouch(couchCfg)
  const transcripts = cx.use<CouchTranscriptDoc>("transcripts")

  const docs = await listAllDocs<CouchTranscriptDoc>(transcripts)
  console.log(`[transcripts] fetched ${docs.length} documents`)

  const stats: ExportStats = { exported: 0, skipped: 0 }

  for (const doc of docs) {
    const parsed = parseId(doc._id)
    if (!parsed) {
      console.warn(`[transcripts] skipping malformed id: ${doc._id}`)
      stats.skipped += 1
      continue
    }

    const filePath = join(
      outputDir,
      parsed.trackId,
      "transcripts",
      `${parsed.language}.json`
    )
    mkdirSync(dirname(filePath), { recursive: true })
    const body = JSON.stringify({
      version: doc.version ?? 1,
      blocks: doc.blocks ?? [],
    })
    writeFileSync(filePath, body, "utf8")
    stats.exported += 1
  }

  return stats
}

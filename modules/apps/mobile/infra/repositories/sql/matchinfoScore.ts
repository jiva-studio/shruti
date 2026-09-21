import type { TrackId } from "@lib/domain/core.js"

/**
 * Shapes a SQLite BLOB column arrives in: raw bytes from sql.js, a plain
 * number array from @capacitor-community/sqlite on Android and iOS, or base64
 * from the same plugin's alternate path. The producer is a native plugin, so
 * normalising is the consumer's job.
 */
export type SqlBlob = Uint8Array | number[] | string | null | undefined

export function normalizeBlob(value: SqlBlob): Uint8Array | null {
  if (value == null) return null
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return Uint8Array.from(value)
  if (typeof value !== "string") return null
  try {
    const bin = atob(value)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/**
 * Relevance for one matched row from an FTS4 `matchinfo(s, 'pcx')` blob — a
 * sequence of little-endian u32: `[p, c, (hits_in_row, hits_in_corpus,
 * rows_with_term) per phrase × column]`.
 *
 *   score = Σ hits_in_row × log((N + 1) / max(1, rows_with_term))
 *
 * One-term BM25 without saturation: cheap, and good enough at low-thousands
 * corpus scale. A missing or malformed blob scores 0, so the row still
 * surfaces, just unranked. Notindexed columns report no hits and contribute
 * nothing on their own.
 */
export function scoreMatchinfo(raw: SqlBlob, totalDocs: number): number {
  const blob = normalizeBlob(raw)
  if (!blob || blob.byteLength < 8) return 0
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  const u32 = (i: number): number => view.getUint32(i * 4, true)
  const p = u32(0)
  const c = u32(1)
  if (p === 0 || c === 0) return 0
  if (blob.byteLength < (2 + p * c * 3) * 4) return 0

  const idfCap = Math.log(totalDocs + 1)
  let score = 0
  for (let phrase = 0; phrase < p; phrase++) {
    for (let col = 0; col < c; col++) {
      const base = 2 + (phrase * c + col) * 3
      const hitsInRow = u32(base)
      const rowsWithTerm = u32(base + 2)
      if (hitsInRow === 0) continue
      score += hitsInRow * (rowsWithTerm > 0 ? Math.log((totalDocs + 1) / rowsWithTerm) : idfCap)
    }
  }
  return score
}

export interface ScoredSearchRow {
  readonly id: TrackId
  readonly date: string | null
  readonly __minfo: SqlBlob
}

/** Match ids in relevance order, ties broken by date DESC then id ASC. */
export function rankSearchRows(
  rows: readonly ScoredSearchRow[],
  totalDocs: number
): readonly TrackId[] {
  return rows
    .map((row) => ({
      id: row.id,
      date: row.date ?? "",
      score: scoreMatchinfo(row.__minfo, totalDocs),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.date !== b.date) return b.date < a.date ? -1 : 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .map((r) => r.id)
}

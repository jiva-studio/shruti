import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { Readable, PassThrough } from "node:stream"
import cliProgress from "cli-progress"
import type { S3Target } from "./uploadToS3.js"

/**
 * Wasabi-side configuration. Wasabi is S3-compatible — only the
 * endpoint differs (`https://s3.<region>.wasabisys.com`). We treat it
 * as a generic source S3 reader.
 */
export interface WasabiSource {
  bucket: string
  /** Region segment for the endpoint, e.g. "us-east-1" or "eu-central-1". */
  region: string
  /** Optional explicit endpoint override. Defaults to the regional URL. */
  endpoint?: string
  accessKeyId: string
  secretAccessKey: string
}

export interface MigrateMediaOptions {
  source: WasabiSource
  destinations: S3Target[]
  /** oldCouchTrackId → new prefixed track id. Built by importFromCouch. */
  trackIdMap: ReadonlyMap<string, string>
  /** When true, also copy `library/tracks/{old}/artifacts/**` to
   *  `artifacts/tracks/{new}/...`. Default true (user wants them). */
  includeArtifacts?: boolean
  /** Concurrent file copies. Defaults to 4. */
  concurrency?: number
}

interface CopyJob {
  /** Source key in Wasabi, e.g. `library/tracks/{old}/audio/original.mp3`. */
  sourceKey: string
  /** Destination key in AWS+Yandex, e.g. `public/tracks/{new}/audio/original.mp3`. */
  destKey: string
  /** Bytes; populated from Wasabi ListObjectsV2 response. */
  size: number
}

const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".db": "application/x-sqlite3",
}

function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf(".")
  if (dot < 0) return "application/octet-stream"
  return CONTENT_TYPES[key.substring(dot).toLowerCase()] ?? "application/octet-stream"
}

function makeWasabiClient(src: WasabiSource): S3Client {
  return new S3Client({
    region: src.region,
    endpoint: src.endpoint ?? `https://s3.${src.region}.wasabisys.com`,
    credentials: {
      accessKeyId: src.accessKeyId,
      secretAccessKey: src.secretAccessKey,
    },
    // Wasabi accepts virtual-hosted-style requests but path-style is
    // friendlier when buckets contain dots; doesn't hurt us either way.
    forcePathStyle: true,
  })
}

function makeDestClient(target: S3Target): S3Client {
  const hasExplicit = Boolean(target.accessKeyId && target.secretAccessKey)
  return new S3Client({
    region: target.region ?? "us-east-1",
    endpoint: target.endpoint,
    credentials: hasExplicit
      ? {
          accessKeyId: target.accessKeyId!,
          secretAccessKey: target.secretAccessKey!,
        }
      : undefined,
    forcePathStyle: Boolean(target.endpoint),
  })
}

/**
 * Translate a Wasabi source key into the new bucket key for the given
 * track. Returns `null` if the key falls outside the conventions we
 * recognise (we never silently rewrite unknown shapes).
 *
 *   library/tracks/{old}/audio/original.mp3
 *     → public/tracks/{new}/audio/original.mp3
 *   library/tracks/{old}/transcripts/{lang}.json
 *     → public/tracks/{new}/transcripts/{lang}.json
 *   library/tracks/{old}/artifacts/...
 *     → artifacts/tracks/{new}/...
 */
function rewriteKey(
  sourceKey: string,
  oldTrackId: string,
  newTrackId: string,
  includeArtifacts: boolean
): string | null {
  const prefix = `library/tracks/${oldTrackId}/`
  if (!sourceKey.startsWith(prefix)) return null
  const rest = sourceKey.slice(prefix.length)
  if (rest.startsWith("audio/") || rest.startsWith("transcripts/")) {
    return `public/tracks/${newTrackId}/${rest}`
  }
  if (rest.startsWith("artifacts/")) {
    if (!includeArtifacts) return null
    return `artifacts/tracks/${newTrackId}/${rest.slice("artifacts/".length)}`
  }
  // Anything else under the track dir is unexpected — skip and warn upstream.
  return null
}

async function listAllUnderPrefix(
  client: S3Client,
  bucket: string,
  prefix: string
): Promise<Array<{ key: string; size: number }>> {
  const out: Array<{ key: string; size: number }> = []
  let continuationToken: string | undefined
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    )
    for (const obj of resp.Contents ?? []) {
      if (obj.Key && typeof obj.Size === "number") {
        out.push({ key: obj.Key, size: obj.Size })
      }
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined
  } while (continuationToken)
  return out
}

async function objectExistsWithSize(
  client: S3Client,
  bucket: string,
  key: string,
  expectedSize: number
): Promise<boolean> {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    if (typeof head.ContentLength !== "number") return false
    // Same key + same size = same bytes for our purposes. We don't
    // compare ETags — Wasabi/AWS/Yandex may use different multipart
    // boundaries and yield different ETags for byte-identical objects.
    return head.ContentLength === expectedSize
  } catch (err) {
    const name = (err as { name?: string }).name ?? ""
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    if (name === "NotFound" || name === "NoSuchKey" || status === 404) return false
    throw err
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return Buffer.concat(chunks)
}

interface DestState {
  client: S3Client
  bucket: string
  label: string
}

async function copyOne(
  job: CopyJob,
  source: { client: S3Client; bucket: string },
  dests: DestState[]
): Promise<{ skipped: number; uploaded: number; bytesCopied: number }> {
  // 1. For each destination, decide whether we need to upload.
  const need: DestState[] = []
  for (const d of dests) {
    const present = await objectExistsWithSize(d.client, d.bucket, job.destKey, job.size)
    if (!present) need.push(d)
  }
  if (need.length === 0) {
    return { skipped: dests.length, uploaded: 0, bytesCopied: 0 }
  }

  // 2. GET once from Wasabi, buffer in memory, PUT to each target that
  // needs it. Buffering avoids re-downloading the same object twice
  // (one per target) at the cost of holding the whole file in RAM.
  // Audio files we expect are 10–60 MB — comfortably inside one
  // worker's memory budget.
  const get = await source.client.send(
    new GetObjectCommand({ Bucket: source.bucket, Key: job.sourceKey })
  )
  if (!(get.Body instanceof Readable)) {
    throw new Error(
      `[migrate-media] unexpected GetObject body for ${job.sourceKey} — not a Readable stream`
    )
  }
  const body = await streamToBuffer(get.Body)
  const contentType = get.ContentType ?? contentTypeFor(job.sourceKey)

  for (const d of need) {
    await d.client.send(
      new PutObjectCommand({
        Bucket: d.bucket,
        Key: job.destKey,
        Body: body,
        ContentType: contentType,
      })
    )
  }

  return {
    skipped: dests.length - need.length,
    uploaded: need.length,
    bytesCopied: body.length * need.length,
  }
}

/**
 * Copies media for every imported track from Wasabi to all destination
 * buckets, server-to-server (no local disk). Idempotent: HEAD on each
 * destination first, skip when present with matching size. Resumable:
 * just re-run the command, finished objects are skipped.
 *
 * The track id map is loaded from the persistent state file by the
 * caller, so on a re-run every (oldId → newId) is the same as before
 * and HEAD lookups hit the same destination keys.
 */
export async function migrateMedia(opts: MigrateMediaOptions): Promise<void> {
  const includeArtifacts = opts.includeArtifacts ?? true
  const concurrency = opts.concurrency ?? 4

  const sourceClient = makeWasabiClient(opts.source)
  const dests: DestState[] = opts.destinations.map((t) => ({
    client: makeDestClient(t),
    bucket: t.bucket,
    label: t.label,
  }))

  console.log(
    `[migrate-media] source=wasabi://${opts.source.bucket} → ${dests
      .map((d) => `${d.label}://${d.bucket}`)
      .join(", ")}`
  )
  console.log(
    `[migrate-media] tracks=${opts.trackIdMap.size}, includeArtifacts=${includeArtifacts}, concurrency=${concurrency}`
  )

  // 1. Discovery pass — list every object under each track's prefix.
  // We do this serially because we want a single global progress bar
  // and the listing itself is fast (a few seconds per track).
  console.log(`[migrate-media] listing source objects…`)
  const discoveryBar = new cliProgress.SingleBar(
    {
      format: "  list  [{bar}] {value}/{total} tracks · {jobs} files queued",
      barCompleteChar: "█",
      barIncompleteChar: "░",
    },
    cliProgress.Presets.shades_classic
  )
  discoveryBar.start(opts.trackIdMap.size, 0, { jobs: 0 })

  const jobs: CopyJob[] = []
  let listed = 0
  for (const [oldTrackId, newTrackId] of opts.trackIdMap) {
    const objs = await listAllUnderPrefix(
      sourceClient,
      opts.source.bucket,
      `library/tracks/${oldTrackId}/`
    )
    for (const obj of objs) {
      const destKey = rewriteKey(obj.key, oldTrackId, newTrackId, includeArtifacts)
      if (!destKey) continue
      jobs.push({ sourceKey: obj.key, destKey, size: obj.size })
    }
    listed += 1
    discoveryBar.update(listed, { jobs: jobs.length })
  }
  discoveryBar.stop()

  if (jobs.length === 0) {
    console.log(`[migrate-media] nothing to copy.`)
    return
  }

  const totalBytes = jobs.reduce((sum, j) => sum + j.size, 0)
  console.log(
    `[migrate-media] queued ${jobs.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`
  )

  // 2. Copy pass with concurrency + progress bar.
  const bar = new cliProgress.SingleBar(
    {
      format:
        "  copy  [{bar}] {value}/{total} · {percentage}% · {mbDone}/{mbTotal} MiB · skipped={skipped} · uploaded={uploaded}",
      barCompleteChar: "█",
      barIncompleteChar: "░",
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  )

  let done = 0
  let skipped = 0
  let uploaded = 0
  let bytesProcessed = 0

  bar.start(jobs.length, 0, {
    skipped: 0,
    uploaded: 0,
    mbDone: "0",
    mbTotal: (totalBytes / 1024 / 1024).toFixed(1),
  })

  const queue = jobs.slice()
  async function worker(): Promise<void> {
    while (true) {
      const job = queue.shift()
      if (!job) return
      try {
        const r = await copyOne(job, { client: sourceClient, bucket: opts.source.bucket }, dests)
        if (r.uploaded > 0) uploaded += 1
        else skipped += 1
        bytesProcessed += job.size
        done += 1
        bar.update(done, {
          skipped,
          uploaded,
          mbDone: (bytesProcessed / 1024 / 1024).toFixed(1),
          mbTotal: (totalBytes / 1024 / 1024).toFixed(1),
        })
      } catch (err) {
        bar.stop()
        console.error(
          `\n[migrate-media] failed on ${job.sourceKey} → ${job.destKey}: ${(err as Error).message}`
        )
        throw err
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)
  bar.stop()

  console.log(
    `[migrate-media] done. files=${jobs.length}, skipped=${skipped}, uploaded=${uploaded}, ` +
      `bytes=${(bytesProcessed / 1024 / 1024).toFixed(1)} MiB`
  )
}

// `Upload` is imported for future large-file streaming; not currently
// used because in-memory buffering is fine at our object sizes. Kept
// so multipart can be added without re-wiring imports if/when needed.
void Upload
void PassThrough

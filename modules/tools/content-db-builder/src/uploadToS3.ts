import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"
import { readFileSync, statSync } from "node:fs"
import { basename, join, relative, sep } from "node:path"
import { walk } from "./walk.js"

export interface S3Target {
  label: string
  bucket: string
  region?: string
  endpoint?: string
  accessKeyId: string
  secretAccessKey: string
}

export interface UploadOptions {
  /** Local directory that mirrors the bucket — its tree is uploaded verbatim. */
  inputDir: string
  targets: S3Target[]
}

const CONTENT_TYPES: Record<string, string> = {
  ".db": "application/x-sqlite3",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
}

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return "application/octet-stream"
  return CONTENT_TYPES[path.substring(dot).toLowerCase()] ?? "application/octet-stream"
}

function makeClient(target: S3Target): S3Client {
  return new S3Client({
    region: target.region ?? "us-east-1",
    endpoint: target.endpoint,
    credentials: {
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
    },
    forcePathStyle: Boolean(target.endpoint), // Yandex likes path-style
  })
}

async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array,
  contentType: string
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  )
}

async function getObjectJson<T>(
  client: S3Client,
  bucket: string,
  key: string
): Promise<T | null> {
  try {
    const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const body = await resp.Body?.transformToString()
    if (!body) return null
    return JSON.parse(body) as T
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") return null
    throw err
  }
}

export async function uploadDirectory(opts: UploadOptions): Promise<void> {
  const files: string[] = []
  walk(opts.inputDir, (f) => files.push(f))

  if (files.length === 0) {
    console.warn(`[upload] no files under ${opts.inputDir}`)
    return
  }

  for (const target of opts.targets) {
    const client = makeClient(target)
    console.log(`[upload:${target.label}] ${files.length} files → s3://${target.bucket}`)
    for (const file of files) {
      const key = relative(opts.inputDir, file).split(sep).join("/")
      const body = readFileSync(file)
      await putObject(client, target.bucket, key, body, contentTypeFor(file))
      const sz = statSync(file).size
      console.log(`[upload:${target.label}]   ${key} (${sz} bytes)`)
    }
  }
}

/**
 * Updates `public/config.json` on each target to advertise the new DB version.
 * Config shape: { databases: [{ version, scheme }] } — newest first, kept
 * truncated to `keep` entries.
 */
export async function updateConfigJson(
  targets: S3Target[],
  version: number,
  scheme: number,
  keep = 5
): Promise<void> {
  for (const target of targets) {
    const client = makeClient(target)
    const key = "public/config.json"
    const existing = (await getObjectJson<{ databases: Array<{ version: number; scheme: number }> }>(
      client,
      target.bucket,
      key
    )) ?? { databases: [] }

    const dedup = existing.databases.filter((d) => d.version !== version)
    const next = [{ version, scheme }, ...dedup]
      .sort((a, b) => b.version - a.version)
      .slice(0, keep)

    const body = Buffer.from(JSON.stringify({ databases: next }, null, 2), "utf8")
    await putObject(client, target.bucket, key, body, "application/json")
    console.log(`[upload:${target.label}] updated ${key} with version ${version} (scheme ${scheme})`)
  }
}

export function parseVersionFromDbFilename(file: string): number {
  const name = basename(file)
  const match = name.match(/lectorium\.(\d+)\.db$/)
  if (!match) throw new Error(`cannot parse version from ${name}`)
  return Number(match[1])
}

export function findDbFile(inputDir: string): string {
  const dbDir = join(inputDir, "public", "db")
  const files: string[] = []
  walk(dbDir, (f) => {
    if (f.endsWith(".db")) files.push(f)
  })
  if (files.length === 0) throw new Error(`no .db files under ${dbDir}`)
  files.sort() // lexicographic = chronological (timestamp versions)
  return files[files.length - 1]
}

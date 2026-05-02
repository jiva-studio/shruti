#!/usr/bin/env node
import "dotenv/config"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildDb } from "./buildDb.js"
import {
  uploadDirectory,
  updateConfigJson,
  findDbFile,
  parseVersionFromDbFilename,
  type S3Target,
} from "./uploadToS3.js"
import { readSchemeFromDb } from "./readScheme.js"
import { migrateMedia, type WasabiSource } from "./migrateMedia.js"
import { IdMap } from "./idMap.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const ID_MAP_PATH = join(HERE, "..", "state", "id-map.json")

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function optionalEnv(name: string): string | undefined {
  const v = process.env[name]
  return v && v.length > 0 ? v : undefined
}

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx < 0 || idx + 1 >= args.length) return undefined
  return args[idx + 1]
}

function parseFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

/**
 * Destination targets for uploads. AWS is required; Yandex is added
 * when `S3_YANDEX_*` vars are set so we can mirror the same content
 * to both providers in a single pass.
 *
 * AWS credentials may be omitted — the SDK then resolves them through
 * its default chain (env / shared config / SSO / IMDS). For Yandex,
 * because the endpoint is custom, explicit creds are required.
 */
function s3Targets(): S3Target[] {
  const targets: S3Target[] = [
    {
      label: "aws",
      bucket: requireEnv("S3_AWS_BUCKET"),
      region: optionalEnv("S3_AWS_REGION") ?? "us-east-1",
      accessKeyId: optionalEnv("S3_AWS_ACCESS_KEY_ID"),
      secretAccessKey: optionalEnv("S3_AWS_SECRET_ACCESS_KEY"),
    },
  ]
  const yandexBucket = optionalEnv("S3_YANDEX_BUCKET")
  if (yandexBucket) {
    targets.push({
      label: "yandex",
      bucket: yandexBucket,
      region: optionalEnv("S3_YANDEX_REGION") ?? "ru-central1",
      endpoint: optionalEnv("S3_YANDEX_ENDPOINT") ?? "https://storage.yandexcloud.net",
      accessKeyId: requireEnv("S3_YANDEX_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("S3_YANDEX_SECRET_ACCESS_KEY"),
    })
  }
  return targets
}

function wasabiSource(): WasabiSource {
  return {
    bucket: requireEnv("S3_WASABI_BUCKET"),
    region: optionalEnv("S3_WASABI_REGION") ?? "us-east-1",
    endpoint: optionalEnv("S3_WASABI_ENDPOINT"),
    accessKeyId: requireEnv("S3_WASABI_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("S3_WASABI_SECRET_ACCESS_KEY"),
  }
}

async function cmdBuild(args: string[]): Promise<void> {
  const outputDir = parseArg(args, "--output") ?? "./out"
  const filterAuthor = parseArg(args, "--author")
  const result = await buildDb({
    outputDir,
    filterAuthor,
    couch: {
      url: requireEnv("COUCHDB_URL"),
      user: optionalEnv("COUCHDB_USER"),
      password: optionalEnv("COUCHDB_PASSWORD"),
    },
  })
  console.log(`built: ${result.outputFile} (tracks=${result.trackIdMap.size})`)
}

async function cmdUpload(args: string[]): Promise<void> {
  const inputDir = parseArg(args, "--input") ?? "./out"
  const targets = s3Targets()

  const dbFile = findDbFile(inputDir)
  const version = parseVersionFromDbFilename(dbFile)
  const scheme = readSchemeFromDb(dbFile)
  if (!scheme) {
    throw new Error(`cannot read scheme from ${dbFile} — migrations table empty?`)
  }

  await uploadDirectory({ inputDir, targets })
  await updateConfigJson(targets, version, scheme)
  console.log(
    `uploaded version ${version} (scheme ${scheme}) to: ${targets
      .map((t) => `${t.label}://${t.bucket}`)
      .join(", ")}`
  )
}

async function cmdMigrateMedia(args: string[]): Promise<void> {
  const filterAuthor = parseArg(args, "--author")
  const concurrencyArg = parseArg(args, "--concurrency")
  const concurrency = concurrencyArg ? Number(concurrencyArg) : undefined
  const includeArtifacts = !parseFlag(args, "--no-artifacts")

  const idMap = new IdMap(ID_MAP_PATH)
  const tracks = idMap.snapshot("tracks")
  if (tracks.size === 0) {
    throw new Error(
      `id map at ${ID_MAP_PATH} has no tracks. Run 'build' first to populate it.`
    )
  }

  // The id map holds every track ever imported across all runs. If the
  // caller filters by author, narrow to just that author's tracks by
  // re-reading Couch; otherwise migrate everything in the map.
  let workingMap: ReadonlyMap<string, string> = tracks
  if (filterAuthor) {
    const { connectCouch, listAllDocs } = await import("./couchdb.js")
    const cx = connectCouch({
      url: requireEnv("COUCHDB_URL"),
      user: optionalEnv("COUCHDB_USER"),
      password: optionalEnv("COUCHDB_PASSWORD"),
    })
    interface CouchTrackHead { _id: string; type: string; author?: string | null }
    const couchTracks = cx.use<CouchTrackHead>("tracks")
    const all = await listAllDocs<CouchTrackHead>(couchTracks)
    const keep = new Set(
      all
        .filter((d) => d.type === "track" && (d.author ?? "").toLowerCase() === filterAuthor.toLowerCase())
        .map((d) => d._id)
    )
    const narrowed = new Map<string, string>()
    for (const [oldId, newId] of tracks) {
      if (keep.has(oldId)) narrowed.set(oldId, newId)
    }
    workingMap = narrowed
    console.log(
      `[migrate-media] --author=${filterAuthor}: ${narrowed.size}/${tracks.size} tracks selected`
    )
  }

  await migrateMedia({
    source: wasabiSource(),
    destinations: s3Targets(),
    trackIdMap: workingMap,
    includeArtifacts,
    concurrency,
  })
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv
  switch (cmd) {
    case "build":
      await cmdBuild(rest)
      break
    case "migrate-media":
      await cmdMigrateMedia(rest)
      break
    case "upload":
      await cmdUpload(rest)
      break
    case "--help":
    case "-h":
    case undefined:
      console.log(
        `Usage:
  content-db-builder build [--output DIR] [--author SLUG]
      Build shruti.{version}.db from CouchDB. With --author, only
      tracks matching that author slug (e.g. acbsp) are imported.

  content-db-builder migrate-media [--author SLUG] [--no-artifacts] [--concurrency N]
      Copy media from Wasabi to AWS + Yandex (server-to-server).
      Idempotent: existing destination objects with matching size are
      skipped. With --author, only that author's tracks are migrated.
      Without --no-artifacts, library/tracks/{old}/artifacts/** is
      mirrored to artifacts/tracks/{new}/.

  content-db-builder upload [--input DIR]
      Upload local ./out tree (db + config.json) to AWS + Yandex.

Env vars (see .env.example):
  COUCHDB_URL, COUCHDB_USER, COUCHDB_PASSWORD
  S3_AWS_BUCKET, S3_AWS_REGION, S3_AWS_ACCESS_KEY_ID, S3_AWS_SECRET_ACCESS_KEY
  S3_YANDEX_BUCKET, S3_YANDEX_REGION, S3_YANDEX_ENDPOINT,
    S3_YANDEX_ACCESS_KEY_ID, S3_YANDEX_SECRET_ACCESS_KEY
  S3_WASABI_BUCKET, S3_WASABI_REGION, S3_WASABI_ENDPOINT,
    S3_WASABI_ACCESS_KEY_ID, S3_WASABI_SECRET_ACCESS_KEY
`
      )
      break
    default:
      console.error(`unknown command: ${cmd}`)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

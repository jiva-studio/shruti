#!/usr/bin/env node
import "dotenv/config"
import { buildDb } from "./buildDb.js"
import { exportTranscripts } from "./exportTranscripts.js"
import {
  uploadDirectory,
  updateConfigJson,
  findDbFile,
  parseVersionFromDbFilename,
  type S3Target,
} from "./uploadToS3.js"
import { readSchemeFromDb } from "./readScheme.js"

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

function s3Targets(): S3Target[] {
  const out: S3Target[] = []
  const awsKey = optionalEnv("S3_AWS_ACCESS_KEY_ID")
  const awsSecret = optionalEnv("S3_AWS_SECRET_ACCESS_KEY")
  if (awsKey && awsSecret) {
    out.push({
      label: "aws",
      bucket: requireEnv("S3_AWS_BUCKET"),
      region: optionalEnv("S3_AWS_REGION") ?? "us-east-1",
      accessKeyId: awsKey,
      secretAccessKey: awsSecret,
    })
  }
  const yaKey = optionalEnv("S3_YANDEX_ACCESS_KEY_ID")
  const yaSecret = optionalEnv("S3_YANDEX_SECRET_ACCESS_KEY")
  if (yaKey && yaSecret) {
    out.push({
      label: "yandex",
      bucket: requireEnv("S3_YANDEX_BUCKET"),
      endpoint: optionalEnv("S3_YANDEX_ENDPOINT") ?? "https://storage.yandexcloud.net",
      accessKeyId: yaKey,
      secretAccessKey: yaSecret,
    })
  }
  if (out.length === 0) {
    throw new Error(
      "No S3 credentials configured. Set S3_AWS_* and/or S3_YANDEX_* in the environment."
    )
  }
  return out
}

async function cmdBuild(args: string[]): Promise<void> {
  const outputDir = parseArg(args, "--output") ?? "./out"
  const output = await buildDb({
    outputDir,
    couch: {
      url: requireEnv("COUCHDB_URL"),
      user: optionalEnv("COUCHDB_USER"),
      password: optionalEnv("COUCHDB_PASSWORD"),
    },
  })
  console.log(`built: ${output}`)
}

async function cmdExportTranscripts(args: string[]): Promise<void> {
  const outputDir = parseArg(args, "--output") ?? "./out/public/tracks"
  const stats = await exportTranscripts(outputDir, {
    url: requireEnv("COUCHDB_URL"),
    user: optionalEnv("COUCHDB_USER"),
    password: optionalEnv("COUCHDB_PASSWORD"),
  })
  console.log(`exported: ${stats.exported}, skipped: ${stats.skipped}`)
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
  console.log(`uploaded version ${version} (scheme ${scheme}) to ${targets.length} target(s)`)
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv
  switch (cmd) {
    case "build":
      await cmdBuild(rest)
      break
    case "export-transcripts":
      await cmdExportTranscripts(rest)
      break
    case "upload":
      await cmdUpload(rest)
      break
    case "--help":
    case "-h":
    case undefined:
      console.log(
        `Usage:
  content-db-builder build [--output DIR]             Build lectorium.{version}.db from CouchDB
  content-db-builder export-transcripts [--output DIR] Export transcripts as JSON files
  content-db-builder upload [--input DIR]             Upload ./out tree to S3 + update config.json
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

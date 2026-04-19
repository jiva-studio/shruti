#!/usr/bin/env node
import "dotenv/config"
import { buildDb } from "./buildDb.js"
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

/**
 * Only AWS is wired in this phase. The Yandex mirror will be set up
 * as a separate migration step (rclone one-shot, plus its own script).
 * Do NOT re-add `S3_YANDEX_*` support here without an accompanying
 * infra change — we want a single source of truth for the bucket
 * while we stabilise content ingestion.
 *
 * Credentials are optional: when both `S3_AWS_ACCESS_KEY_ID` and
 * `S3_AWS_SECRET_ACCESS_KEY` are empty, the SDK falls back to its
 * default provider chain — env, shared config / credentials files,
 * SSO, IMDS. That lets `aws sso login` + `AWS_PROFILE=...` just work
 * without pasting keys into .env.
 */
function s3Targets(): S3Target[] {
  const accessKeyId = optionalEnv("S3_AWS_ACCESS_KEY_ID")
  const secretAccessKey = optionalEnv("S3_AWS_SECRET_ACCESS_KEY")
  return [
    {
      label: "aws",
      bucket: requireEnv("S3_AWS_BUCKET"),
      region: optionalEnv("S3_AWS_REGION") ?? "us-east-1",
      accessKeyId,
      secretAccessKey,
    },
  ]
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
  console.log(`uploaded version ${version} (scheme ${scheme}) to AWS (${targets[0].bucket})`)
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv
  switch (cmd) {
    case "build":
      await cmdBuild(rest)
      break
    case "upload":
      await cmdUpload(rest)
      break
    case "--help":
    case "-h":
    case undefined:
      console.log(
        `Usage:
  content-db-builder build [--output DIR]              Build lectorium.{version}.db from CouchDB
  content-db-builder upload [--input DIR]              Upload ./out tree to AWS S3 + update config.json

Env vars (see .env.example):
  COUCHDB_URL, COUCHDB_USER, COUCHDB_PASSWORD
  S3_AWS_BUCKET, S3_AWS_REGION, S3_AWS_ACCESS_KEY_ID, S3_AWS_SECRET_ACCESS_KEY
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

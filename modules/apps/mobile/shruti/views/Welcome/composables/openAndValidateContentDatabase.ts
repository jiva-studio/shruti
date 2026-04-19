/**
 * Opens a content DB at `dbPath`, reads its scheme via `readScheme`, and either
 * accepts it (scheme 0 = legacy/unknown, or matches `supportedScheme`) or drops
 * it as stale and retries.
 *
 * "Drop" here means: close the connection, mark the path as already-tried in
 * `incompatibleDbPaths` (so `findLocalDatabase` won't pick it again next pass),
 * delete the local file, bust the cached remote config (so the next pass re-
 * probes for a freshly-advertised compatible DB), then call `retry`. The hard
 * cap on `incompatibleDbPaths.size` guards against an unexpected loop — e.g.
 * a CDN-served DB whose actual scheme disagrees with what config advertises.
 *
 * Extracted from `WelcomeView.controller.ts` so it can be unit-tested without
 * mounting the full composable.
 */
export interface SchemeValidatorDeps {
  readonly supportedScheme: number
  readonly maxRetries: number
  open(dbPath: string): Promise<void>
  close(): Promise<void>
  readScheme(): Promise<number>
  dropDb(dbPath: string): Promise<void>
  invalidateConfig(): Promise<void>
  retry(): Promise<void>
}

export async function openAndValidateContentDatabase(
  dbPath: string,
  incompatibleDbPaths: Set<string>,
  deps: SchemeValidatorDeps
): Promise<void> {
  await deps.open(dbPath)
  const dbScheme = await deps.readScheme()

  if (dbScheme === 0 || dbScheme === deps.supportedScheme) return

  await deps.close()
  incompatibleDbPaths.add(dbPath)
  if (incompatibleDbPaths.size > deps.maxRetries) {
    throw new Error(`Database scheme mismatch: expected ${deps.supportedScheme}, got ${dbScheme}`)
  }
  await deps.dropDb(dbPath)
  await deps.invalidateConfig()
  return deps.retry()
}

// Known violation: a rejection handler that drops the error.
export function closeQuietly(close: () => Promise<void>): Promise<void> {
  return close().catch(() => undefined)
}

export function readQuietly(read: () => Promise<string>): Promise<string | null> {
  return read().then(undefined, () => null)
}

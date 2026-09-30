// Known violation: a rejected promise dropped without a word.
export function closeQuietly(close: () => Promise<void>): Promise<void> {
  return close().catch(() => undefined)
}

export function readQuietly(read: () => Promise<string>): Promise<string | null> {
  return read().catch(() => null)
}

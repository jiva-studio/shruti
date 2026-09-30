// Known violation: a rejection handler that drops the error behind a type assertion.
export function listQuietly(list: () => Promise<string[]>): Promise<string[]> {
  return list().catch(() => [] as string[])
}

export function checkQuietly(check: () => Promise<"granted" | "denied">): Promise<string> {
  return check().catch(() => "denied" as const)
}

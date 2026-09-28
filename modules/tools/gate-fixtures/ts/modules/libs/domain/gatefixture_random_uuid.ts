// Known violation: the domain mints an id itself.
export function idFixture(): string {
  return crypto.randomUUID()
}

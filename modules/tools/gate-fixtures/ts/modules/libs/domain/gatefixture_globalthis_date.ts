// Known violation: the domain reads the clock through the global object.
export function stampFixture(): number {
  return globalThis.Date.now()
}

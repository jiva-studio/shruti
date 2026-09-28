// Known violation: the domain reads the clock through Date held under another
// name.
const Clock = Date

export function stampFixture(): number {
  return Clock.now()
}

// Known violation: the domain reads the clock through Date() called as a
// function.
export function stampFixture(): string {
  return Date()
}

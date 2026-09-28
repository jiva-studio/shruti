// Known violation: the domain reads the ambient clock.
export function stampFixture(): number {
  return Date.now()
}

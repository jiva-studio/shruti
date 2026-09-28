// Known violation: the domain reads the clock through a computed member.
export function stampFixture(): number {
  return Date["now"]()
}

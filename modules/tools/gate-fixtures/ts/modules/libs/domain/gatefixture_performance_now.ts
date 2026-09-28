// Known violation: the domain reads the monotonic clock.
export function stampFixture(): number {
  return performance.now()
}

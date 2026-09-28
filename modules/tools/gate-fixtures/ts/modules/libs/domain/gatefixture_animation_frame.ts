// Known violation: the domain waits for a frame.
export function frameFixture(run: () => void): number {
  return requestAnimationFrame(run)
}

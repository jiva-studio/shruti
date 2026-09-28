// Known violation: the domain schedules work.
export function deferFixture(run: () => void): void {
  queueMicrotask(run)
}

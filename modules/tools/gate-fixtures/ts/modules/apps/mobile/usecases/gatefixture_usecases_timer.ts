// Known violation: a use case arms a real timer instead of taking a schedule.
export function fixture(run: () => void): () => void {
  const id = setTimeout(run, 1000)
  return () => clearTimeout(id)
}

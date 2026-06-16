/** Return a new array with the items in random order (Fisher-Yates). The input
 *  is not mutated. Shared by the discovery surfaces (Search tiles/collections/
 *  lectures, recommendation cold-start) and the chat suggestion chips. */
export function shuffled<T>(items: readonly T[]): T[] {
  const pool = [...items]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool
}

export function useDedupedCallFunction<T extends any[], R>(
  fn: (...args: T) => Promise<R> | R
): (...args: T) => Promise<R | undefined> {
  const calledArgs = new Set<string>()

  return async (...args: T): Promise<R | undefined> => {
    const key = JSON.stringify(args)
    if (calledArgs.has(key)) return undefined

    calledArgs.add(key)
    return await fn(...args)
  }
}
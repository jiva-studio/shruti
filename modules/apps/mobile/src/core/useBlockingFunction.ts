export function useBlockingFunction(
  fn: () => Promise<void> | void
) {
  let isRunning = false
  let shouldRunAgain = false

  async function call() {
    if (isRunning) {
      shouldRunAgain = true
      return
    }

    isRunning = true
    try {
      await fn()
    } finally {
      isRunning = false
      if (shouldRunAgain) {
        shouldRunAgain = false
        call()
      }
    }
  }

  return call
}
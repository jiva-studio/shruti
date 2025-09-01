export interface RetryOptions {
  maxRetries?: number;
  delayMs?: number;
  isRecoverable?: (error: unknown) => boolean;
}

export function useRetriableFunction<TArgs extends any[], TResult>(
  fn: (...args: TArgs) => Promise<TResult | undefined>,
  {
    maxRetries = 3,
    delayMs = 100,
    isRecoverable = () => true,
  }: RetryOptions = {}
) {
  return async (...args: TArgs): Promise<TResult | undefined> => {
    let attempt = 0
    let lastError: unknown

    while (attempt <= maxRetries) {
      try {
        return await fn(...args)
      } catch (error: any) {
        lastError = error
        if (isRecoverable(error)) { return }
        if (attempt >= maxRetries) { throw error }
        attempt++
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
    }

    throw lastError
  }
}
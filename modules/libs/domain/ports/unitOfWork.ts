/**
 * Port for atomic multi-step operations. Implementations wrap the
 * underlying SQLite transaction.
 */
export interface IUnitOfWork {
  run<T>(fn: () => Promise<T>): Promise<T>
}

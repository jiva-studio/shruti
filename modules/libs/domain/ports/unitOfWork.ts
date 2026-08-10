/**
 * Handle to one in-flight transaction. Opaque — only its **identity** carries
 * meaning: the unit of work hands a fresh handle to the callback it runs, and
 * a call that presents that handle back is, by construction, a call issued
 * from inside that transaction.
 *
 * This is what makes nesting decidable. A bare "am I in a transaction?" flag
 * cannot tell "called from within the callback" from "called concurrently
 * while the callback is awaiting" — the flag is raised for the callback's
 * whole duration, so an unrelated write issued from another call stack was
 * spliced into the foreign transaction and lost on its rollback (#1493).
 * JavaScript has no ambient execution-context store in a browser/WebView
 * (`AsyncLocalStorage` is Node-only), so the context travels explicitly.
 */
export interface ITransaction {
  readonly kind: "transaction"
}

/**
 * Port for atomic multi-step operations. Implementations wrap the underlying
 * SQLite transaction.
 *
 * `run(fn)` opens a transaction and invokes `fn` with its handle. Passing that
 * handle back — as `run(fn, tx)`, or through a repository method's trailing
 * `tx` argument — JOINS the transaction it identifies instead of opening a
 * second one (SQLite has no nested transactions and the adapters serialise
 * transaction blocks, so a nested `BEGIN` would dead-lock). Every other call
 * gets a transaction of its own.
 *
 * The handle is typed optional on the callback purely so the many
 * `run(async () => …)` callbacks that never nest stay valid; a real
 * implementation always supplies it.
 */
export interface IUnitOfWork {
  run<T>(fn: (tx?: ITransaction) => Promise<T>, tx?: ITransaction): Promise<T>
}

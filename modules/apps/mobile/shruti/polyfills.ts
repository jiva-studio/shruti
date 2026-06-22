// Polyfills for older Android System WebViews (e.g. Android 11 / Chrome < 92),
// which lack Array/String .at — used by `marked` (in-app help, chat markdown)
// and others, otherwise crashing with "t.at is not a function".
function at(this: { length: number; [i: number]: unknown }, index: number): unknown {
  const len = this.length
  let n = Math.trunc(index) || 0
  if (n < 0) n += len
  return n < 0 || n >= len ? undefined : this[n]
}

if (!Array.prototype.at) {
  Object.defineProperty(Array.prototype, "at", { value: at, writable: true, configurable: true })
}
if (!String.prototype.at) {
  Object.defineProperty(String.prototype, "at", { value: at, writable: true, configurable: true })
}

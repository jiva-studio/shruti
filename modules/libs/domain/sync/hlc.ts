/**
 * Hybrid Logical Clock (HLC).
 *
 * Every synced change is stamped with an HLC so two devices deterministically
 * — and identically — pick a winner on conflict without trusting the phone's
 * wall clock. Wire format is `<physical_ms>:<counter>:<device_id>`, e.g.
 * `000001718000000000:00000:device-abc`.
 *
 * The `physical` component is unix milliseconds; `counter` bumps whenever the
 * clock does not advance (or runs backwards) so successive writes in the same
 * millisecond stay ordered; `device_id` is the final tiebreak so both sides
 * converge on the same winner. HLCs compare on `(physical, counter, device_id)`.
 *
 * `toString` zero-pads `physical` and `counter` to fixed widths so a plain
 * lexicographic string comparison (what the server does on the `hlc` text
 * column) yields the SAME order as {@link compareHlc}. Keep both sides in sync
 * if the widths ever change.
 *
 * Because `(counter, device_id)` makes every write unique, the HLC string also
 * doubles as the idempotency key for retried pushes.
 *
 * Pure value object — no IO, no infra imports.
 */

/** Digits reserved for the physical (unix-ms) component when serialized.
 *  15 digits covers timestamps up to the year ~5138, well beyond any real
 *  device clock. */
export const HLC_PHYSICAL_DIGITS = 15

/** Digits reserved for the counter component when serialized. 5 digits
 *  (0–99999) is far more than the number of writes physically possible inside
 *  a single millisecond; an overflow advances `physical` instead (see
 *  {@link hlcNow}). */
export const HLC_COUNTER_DIGITS = 5

const MAX_COUNTER = 10 ** HLC_COUNTER_DIGITS - 1

/** An HLC as a structured value. Serialize with {@link hlcToString}. */
export interface Hlc {
  /** Unix time in milliseconds — the "physical" component. */
  readonly physical: number
  /** Monotonic tiebreak within a single `physical` millisecond. */
  readonly counter: number
  /** Stable per-device id — the final tiebreak on otherwise-equal clocks. */
  readonly deviceId: string
}

/**
 * Produce the HLC for a new local event.
 *
 * Standard HLC "local/send" rule: take the max of the wall clock and the last
 * seen physical time; if physical did not advance, bump the counter; otherwise
 * reset the counter to 0. A counter overflow (impossible in practice) rolls
 * over into the next millisecond so the serialized form never overruns its
 * fixed width.
 *
 * @param deviceId stable id of this device (the HLC tiebreak).
 * @param lastSeen the highest HLC this device has previously issued or
 *                 observed, or `null` on the very first event.
 * @param now      injectable wall clock (unix ms); defaults to `Date.now()`.
 */
export function hlcNow(deviceId: string, lastSeen: Hlc | null, now: number = Date.now()): Hlc {
  const wall = Math.floor(now)
  if (lastSeen === null) {
    return { physical: wall, counter: 0, deviceId }
  }
  const physical = Math.max(wall, lastSeen.physical)
  if (physical === lastSeen.physical) {
    const counter = lastSeen.counter + 1
    if (counter > MAX_COUNTER) {
      // Overflow within one millisecond — advance the clock so the counter
      // resets and the serialized width holds.
      return { physical: physical + 1, counter: 0, deviceId }
    }
    return { physical, counter, deviceId }
  }
  return { physical, counter: 0, deviceId }
}

/** Serialize an HLC to its zero-padded wire string. */
export function hlcToString(hlc: Hlc): string {
  const physical = String(hlc.physical).padStart(HLC_PHYSICAL_DIGITS, "0")
  const counter = String(hlc.counter).padStart(HLC_COUNTER_DIGITS, "0")
  return `${physical}:${counter}:${hlc.deviceId}`
}

/**
 * Parse a wire HLC string back into its structured form. The `device_id`
 * segment may itself contain `:`, so only the first two separators are
 * significant — everything after the second `:` is the device id.
 *
 * Throws on a structurally invalid string (a programmer error / corrupt row),
 * per the domain's "throw on impossible state" policy.
 */
export function parseHlc(value: string): Hlc {
  const first = value.indexOf(":")
  const second = value.indexOf(":", first + 1)
  if (first === -1 || second === -1) {
    throw new Error(`Invalid HLC string: ${value}`)
  }
  const physical = Number(value.slice(0, first))
  const counter = Number(value.slice(first + 1, second))
  const deviceId = value.slice(second + 1)
  if (!Number.isFinite(physical) || !Number.isFinite(counter) || deviceId === "") {
    throw new Error(`Invalid HLC string: ${value}`)
  }
  return { physical, counter, deviceId }
}

/**
 * Total order on HLCs: compare `physical`, then `counter`, then `deviceId`.
 * Returns a negative number when `a < b`, zero when equal, positive when
 * `a > b` — the `Array.prototype.sort` convention.
 */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.physical !== b.physical) return a.physical - b.physical
  if (a.counter !== b.counter) return a.counter - b.counter
  if (a.deviceId < b.deviceId) return -1
  if (a.deviceId > b.deviceId) return 1
  return 0
}

/** {@link compareHlc} on wire strings — parses both sides first. */
export function compareHlcString(a: string, b: string): number {
  return compareHlc(parseHlc(a), parseHlc(b))
}

/** The greater of two wire HLCs, treating `null` as "nothing on record".
 *  `null` only when both sides are. */
export function maxHlcString(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return compareHlcString(a, b) >= 0 ? a : b
}

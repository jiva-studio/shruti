/**
 * Render a byte count the way a phone's storage screen would — "8 GB",
 * "1.5 GB", "740 MB" — with the unit localised by `Intl`.
 *
 * Below 1 GiB the number is shown in megabytes: a 340 MB cache reads as
 * "0.3 GB" otherwise, which looks like nothing was downloaded at all.
 */
export function formatStorageSize(bytes: number, locale: string): string {
  const mib = bytes / (1024 * 1024)
  const useGigabytes = mib >= 1024
  const value = useGigabytes ? mib / 1024 : mib
  // Whole numbers past 10 — "12.4 GB" is noise at that scale, and the
  // presets themselves are round.
  const fractionDigits = useGigabytes && value < 10 && !Number.isInteger(value) ? 1 : 0
  try {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: useGigabytes ? "gigabyte" : "megabyte",
      unitDisplay: "short",
      maximumFractionDigits: fractionDigits,
    }).format(value)
  } catch {
    // `style: "unit"` is ECMA-402 and universally available on our targets,
    // but an unknown unit throws rather than degrading — never let a
    // settings row fail to render over a label.
    return `${value.toFixed(fractionDigits)} ${useGigabytes ? "GB" : "MB"}`
  }
}

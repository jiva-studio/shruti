/**
 * Compact duration label for activity badges. Tiers:
 *   < 1h   → "Nm"
 *   < 1d   → "Hh Mm" (or "Hh" when minutes are zero)
 *   ≥ 1d   → "Dd Hh" (drop minutes once we're in days — pixels are scarce
 *            in a chip and the user already gets daily resolution from
 *            the heatmap itself).
 *
 * Localised via the home.duration.* namespace.
 */
export type DurationTranslate = (key: string, named?: Record<string, number | string>) => string

export function formatListeningDuration(seconds: number, t: DurationTranslate): string {
  const total = Math.max(0, Math.floor(seconds))
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600) % 24
  const d = Math.floor(total / 86_400)

  if (d > 0) {
    return h > 0 ? t("app.duration.daysAndHours", { d, h }) : t("app.duration.days", { n: d })
  }
  if (h > 0) {
    return m > 0 ? t("app.duration.hoursAndMinutes", { h, m }) : t("app.duration.hours", { n: h })
  }
  return t("app.duration.minutes", { n: m })
}

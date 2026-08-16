import { watch, type Ref } from "vue"
import { useConfig } from "./useConfig.js"

/**
 * In-app text size, applied as a scale on the root font size (#1890).
 *
 * On iOS there was no way to enlarge a transcript or a verse at all: the
 * viewport meta ships `user-scalable=no`, WKWebView does not honour Dynamic
 * Type, and Ionic's own typography pins the root to a literal 16px behind an
 * `@supports(-webkit-touch-callout: none)` block — i.e. on iOS only. This
 * setting is the app's own answer, and it works the same on both platforms.
 *
 * It is expressed as a **percentage** rather than an absolute px value on
 * purpose. `font-size: 130%` on the root resolves against the WebView's
 * default font size, which on Android already carries the system font-size
 * setting; a px value would pin it and quietly take that scaling away.
 * Android's behaviour is therefore unchanged at the default scale, and
 * multiplied — not replaced — at any other.
 */
export const TEXT_SCALE_KEY = "settings.appearance.textScale"

/** 1 = the size the app has always rendered at. */
export const DEFAULT_TEXT_SCALE = 1

/** Offered in Settings → Appearance. The top of the range is deliberately
 *  short of iOS's accessibility sizes: the player, the tab bar and the
 *  onboarding carousel are laid out in fixed px and stop reflowing cleanly
 *  well before 2x. */
export const TEXT_SCALE_PRESETS = [0.9, 1, 1.15, 1.3, 1.5] as const

const MIN_TEXT_SCALE = TEXT_SCALE_PRESETS[0]
const MAX_TEXT_SCALE = TEXT_SCALE_PRESETS[TEXT_SCALE_PRESETS.length - 1]!

/** A stored value that predates a preset change — or was never a number —
 *  must not be able to render the app unreadable or invisible. */
export function clampTextScale(value: unknown): number {
  // `typeof`, not `Number(value)` — the latter reads `null` and `""` as 0,
  // which is finite, and would clamp a missing preference to the smallest
  // preset instead of leaving it at the default.
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TEXT_SCALE
  return Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, value))
}

/** Write the scale onto the document root. Inline, so it wins over Ionic's
 *  iOS-only `html { font: 16px … }` rule without an `!important`. */
export function applyTextScale(scale: unknown, root?: HTMLElement): void {
  const el = root ?? (typeof document !== "undefined" ? document.documentElement : null)
  if (!el) return
  el.style.fontSize = `${Math.round(clampTextScale(scale) * 100)}%`
}

/** The stored preference. Shared ref — Settings writes it, App applies it. */
export function useTextScale(): Ref<number> {
  return useConfig<number>(TEXT_SCALE_KEY, DEFAULT_TEXT_SCALE)
}

/** Keeps the document root in step with the stored preference for the life of
 *  the app. Called once, from `App.vue`. */
export function useTextScaleApplied(): Ref<number> {
  const scale = useTextScale()
  // `immediate` matters: `useConfig` hydrates asynchronously, so the first
  // value seen here is the default and the stored one lands a tick later.
  watch(scale, (value) => applyTextScale(value), { immediate: true })
  return scale
}

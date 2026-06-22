// Generic, reusable UI primitives now live in @kit/ui (framework-agnostic,
// token-driven, i18n/router-free). Re-export them so existing
// `@ui/primitives` importers keep working unchanged.
export {
  AppPage,
  BuildInfo,
  Header,
  IconChip,
  LazyImage,
  Message,
  PageSticker,
  ProBadge,
  SafeAreaHeaderGradient,
  SectionHeader,
} from "@kit/ui"

// App-specific primitives that stay in Shruti:
//  - HighlightText: renders search-result <mark> highlight markup — Shruti
//    search-specific, intentionally kept local.
//  - WithDeleteAction: hardcodes the @tabler IconTrashFilled icon (app icon
//    set), so it isn't generic; kept local.
export { default as CachedImage } from "./CachedImage.vue"
export { default as FlatHeader } from "./FlatHeader.vue"
export { useCachedImageUrl } from "./useCachedImageUrl.js"
export { FILES_STORAGE_KEY, ASSET_FAILOVER_KEY } from "./filesStorageKey.js"
export { default as HighlightText } from "@lib/ui/primitives/HighlightText.vue"
export { default as WithDeleteAction } from "./WithDeleteAction.vue"
export { default as ToggleChip } from "./ToggleChip.vue"

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

// App-specific primitives that stay in Lectorium:
//  - FloatingChip: only used by the transcript SpeakerFloatingChip; not part of
//    the extraction set.
//  - HighlightText: renders search-result <mark> highlight markup — Lectorium
//    search-specific, intentionally kept local.
//  - WithDeleteAction: hardcodes the @tabler IconTrashFilled icon (app icon
//    set), so it isn't generic; kept local.
export { default as FlatHeader } from "./FlatHeader.vue"
export { default as FloatingChip } from "./FloatingChip.vue"
export { default as HighlightText } from "./HighlightText.vue"
export { default as WithDeleteAction } from "./WithDeleteAction.vue"

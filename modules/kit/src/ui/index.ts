// kit/ui — framework-agnostic, themeable UI primitives.
// Text comes via props/slots (no i18n), navigation via events (no router),
// appearance via CSS custom properties (no hardcoded brand values, no
// appearance props).
export { default as SectionHeader } from "./SectionHeader.vue"
export { default as Badge } from "./Badge.vue"
export { default as Heatmap } from "./Heatmap.vue"
export type { HeatmapCell } from "./heatmap.types.js"
export { default as BuildInfo } from "./BuildInfo.vue"
export type { BuildInfoId } from "./BuildInfo.vue"
// Page/layout primitives — Ionic-based, framework-agnostic (text via props/
// slots, navigation via events, appearance via CSS tokens, icons via slots).
export { default as AppPage } from "./AppPage.vue"
export { default as Header } from "./Header.vue"
export { default as IconChip } from "./IconChip.vue"
export { default as LazyImage } from "./LazyImage.vue"
export { default as Message } from "./Message.vue"
export { default as PageSticker } from "./PageSticker.vue"
export { default as ProBadge } from "./ProBadge.vue"
export { default as SafeAreaHeaderGradient } from "./SafeAreaHeaderGradient.vue"
// Floating bottom tab bar — glassy pill with tabs (prop + scoped icon slot),
// an optional leading affordance and an optional primary CTA. Navigation via
// `select`/`action` events (no router), appearance via `--kit-floating-tabbar-*`.
export { default as FloatingTabBar } from "./FloatingTabBar.vue"
export type { FloatingTab } from "./FloatingTabBar.vue"
// App-loading / first-launch screen: icon + name + status + optional progress,
// with an error/retry state. Text via props, icon via prop/slot, retry via event.
export { default as AppLoading } from "./AppLoading.vue"
// Settings — Ionic-based shells + reusable item variants. Built on IonItem/
// IonList/IonLabel/IonToggle/IonListHeader so native-Ionic apps adopt them
// directly. Text via props/slots (no i18n), interaction via events (no router).
export { default as SettingsGroup } from "./settings/SettingsGroup.vue"
export { default as SettingsItem } from "./settings/SettingsItem.vue"
export { default as SettingsToggleItem } from "./settings/SettingsToggleItem.vue"
export { default as SettingsSelectItem } from "./settings/SettingsSelectItem.vue"
export { default as SettingsTimeItem } from "./settings/SettingsTimeItem.vue"
export { default as SettingsActionItem } from "./settings/SettingsActionItem.vue"
export { default as SettingsAccountItem } from "./settings/SettingsAccountItem.vue"

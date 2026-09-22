// kit/composables — framework-agnostic Vue composables.
// They depend on no app composition root and no i18n/router: pass ports
// (preferences, locale control) and helpers (detectLocale) as arguments.
export {
  createUseConfig,
  type PreferencesPort,
  type ConfigSerializer,
  type UseConfig,
} from "./useConfig.js"
export { useAppLanguage, type LocaleControl } from "./useAppLanguage.js"
export {
  useToast,
  type UseToast,
  type ToastOptions,
  type ToastActionOptions,
  type ToastButton,
  type ToastOutcome,
  type ToastColor,
  type ToastPosition,
  type ToastLayout,
  type ToastPolicy,
} from "./useToast.js"
export { useLoading, type UseLoading } from "./useLoading.js"
export {
  useDebugUnlock,
  type UseDebugUnlock,
  type UseDebugUnlockOptions,
} from "./useDebugUnlock.js"

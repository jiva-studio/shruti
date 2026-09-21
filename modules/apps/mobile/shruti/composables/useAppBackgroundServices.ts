import type { Ref } from "vue"
import type { LanguageCode } from "@lib/domain/core.js"
import { useAppLanguageSeed } from "@shruti/composables/useAppLanguageSeed.js"
import { useAutoArchiveSweep } from "@shruti/composables/useAutoArchiveSweep.js"
import { useAutoDownloadLoop } from "@shruti/composables/useAutoDownloadLoop.js"
import { useChatResume } from "@shruti/composables/useChatResume.js"
import { useChatStoreProactiveSync } from "@shruti/composables/useChatStoreProactiveSync.js"
import { useChatTurnNotifications } from "@shruti/composables/useChatTurnNotifications.js"
import { useHardwareBackButton } from "@shruti/composables/useHardwareBackButton.js"
import { useLocaleSync } from "@shruti/composables/useLocaleSync.js"
import { usePlayerProgressCadence } from "@shruti/composables/usePlayerProgressCadence.js"
import { usePlayerProgressFlush } from "@shruti/composables/usePlayerProgressFlush.js"
import { usePlayerTutorialPulse } from "@shruti/composables/usePlayerTutorialPulse.js"
import { useProactiveDeepLink } from "@shruti/composables/useProactiveDeepLink.js"
import { useProactiveScheduler } from "@shruti/composables/useProactiveScheduler.js"
import { useSyncEngine } from "@shruti/composables/useSyncEngine.js"
import { useTextScaleApplied } from "@shruti/composables/useTextScale.js"
import { useUserNotifier } from "@shruti/composables/useUserNotifier.js"

/**
 * Everything the app root keeps running for the whole session, mounted once.
 * Returns the tutorial pulse, the only one the root's template reads.
 */
export function useAppBackgroundServices(appLanguage: Ref<LanguageCode>): {
  pulsing: ReturnType<typeof usePlayerTutorialPulse>
} {
  useLocaleSync(appLanguage)
  // Settings → Appearance → Text size, applied to the document root. Lives here
  // rather than in the Settings screen because the scale has to survive that
  // screen being closed.
  useTextScaleApplied()
  useAppLanguageSeed(appLanguage)
  useHardwareBackButton()
  usePlayerProgressFlush()
  usePlayerProgressCadence()
  useAutoArchiveSweep()
  const pulsing = usePlayerTutorialPulse()
  useAutoDownloadLoop()
  useProactiveScheduler()
  useSyncEngine()
  useChatResume()
  useUserNotifier()
  useChatTurnNotifications()
  useProactiveDeepLink()
  useChatStoreProactiveSync()
  return { pulsing }
}

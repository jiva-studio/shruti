import type { Ref } from "vue"
import type { LanguageCode } from "@lib/domain/core.js"
import { useAppLanguageSeed } from "@lectorium/composables/useAppLanguageSeed.js"
import { useAutoArchiveSweep } from "@lectorium/composables/useAutoArchiveSweep.js"
import { useAutoDownloadLoop } from "@lectorium/composables/useAutoDownloadLoop.js"
import { useChatResume } from "@lectorium/composables/useChatResume.js"
import { useChatStoreProactiveSync } from "@lectorium/composables/useChatStoreProactiveSync.js"
import { useChatTurnNotifications } from "@lectorium/composables/useChatTurnNotifications.js"
import { useHardwareBackButton } from "@lectorium/composables/useHardwareBackButton.js"
import { useLocaleSync } from "@lectorium/composables/useLocaleSync.js"
import { usePlayerProgressCadence } from "@lectorium/composables/usePlayerProgressCadence.js"
import { usePlayerProgressFlush } from "@lectorium/composables/usePlayerProgressFlush.js"
import { usePlayerTutorialPulse } from "@lectorium/composables/usePlayerTutorialPulse.js"
import { useProactiveDeepLink } from "@lectorium/composables/useProactiveDeepLink.js"
import { useProactiveScheduler } from "@lectorium/composables/useProactiveScheduler.js"
import { useSyncEngine } from "@lectorium/composables/useSyncEngine.js"
import { useTextScaleApplied } from "@lectorium/composables/useTextScale.js"
import { useUserNotifier } from "@lectorium/composables/useUserNotifier.js"

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

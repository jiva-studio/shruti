import { onBeforeUnmount, onMounted, ref, type Ref } from "vue"
import type { PluginListenerHandle } from "@capacitor/core"
import { Keyboard } from "@capacitor/keyboard"
import { useLectorium } from "@lectorium/lectorium.js"

/**
 * Tracks whether the native on-screen keyboard is currently visible so
 * root-level chrome — the FloatingPlayer — can step out of the way
 * while the user is typing.
 *
 * Uses `keyboardWillShow` / `keyboardWillHide` so the player fades out
 * before the keyboard finishes sliding in, and fades back in as it
 * slides away. On Android the `will`/`did` variants fire near
 * simultaneously, so the choice is purely an iOS optimization with no
 * Android downside.
 *
 * No-op on web: the Capacitor Keyboard plugin only ships native
 * implementations for iOS and Android.
 */
export function useKeyboardVisibility(): { isKeyboardOpen: Ref<boolean> } {
  const isKeyboardOpen = ref<boolean>(false)
  const isNative = useLectorium().platform !== "web"

  let showHandle: Promise<PluginListenerHandle> | undefined
  let hideHandle: Promise<PluginListenerHandle> | undefined

  onMounted(() => {
    if (!isNative) return
    try {
      showHandle = Keyboard.addListener("keyboardWillShow", () => {
        isKeyboardOpen.value = true
      })
      hideHandle = Keyboard.addListener("keyboardWillHide", () => {
        isKeyboardOpen.value = false
      })
    } catch {
      // Plugin missing on older Capacitor versions or in tests — fail
      // silently; the FloatingPlayer just won't react to the keyboard.
    }
  })

  onBeforeUnmount(async () => {
    try {
      const h1 = await showHandle
      await h1?.remove()
      const h2 = await hideHandle
      await h2?.remove()
    } catch {
      // See note in onMounted.
    }
  })

  return { isKeyboardOpen }
}

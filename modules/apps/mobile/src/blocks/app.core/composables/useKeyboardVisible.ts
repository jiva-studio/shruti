import { ref, onMounted, onUnmounted } from 'vue'
import { Keyboard } from '@capacitor/keyboard'
import { createSharedComposable } from '@vueuse/core'
import { Capacitor } from '@capacitor/core'

export const useKeyboardVisible = createSharedComposable(() => {
  const isKeyboardVisible = ref(false)

  const onShow = () => (isKeyboardVisible.value = true)
  const onHide = () => (isKeyboardVisible.value = false)

  onMounted(() => {
    if (Capacitor.getPlatform() === 'web') { return }
    Keyboard.addListener('keyboardDidShow', onShow)
    Keyboard.addListener('keyboardDidHide', onHide)
  })

  onUnmounted(() => {
    if (Capacitor.getPlatform() === 'web') { return }
    Keyboard.removeAllListeners()
  })

  return {
    isKeyboardVisible,
  }
})

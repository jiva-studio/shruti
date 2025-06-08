import { ref, onMounted, onUnmounted } from 'vue'
import { Keyboard } from '@capacitor/keyboard'
import { createSharedComposable } from '@vueuse/core'

export const useKeyboardVisible = createSharedComposable(() => {
  const isKeyboardVisible = ref(false)

  const onShow = () => (isKeyboardVisible.value = true)
  const onHide = () => (isKeyboardVisible.value = false)

  onMounted(() => {
    Keyboard.addListener('keyboardDidShow', onShow)
    Keyboard.addListener('keyboardDidHide', onHide)
  })

  onUnmounted(() => {
    Keyboard.removeAllListeners()
  })

  return {
    isKeyboardVisible,
  }
})

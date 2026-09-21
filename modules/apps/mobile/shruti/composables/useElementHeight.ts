import { onUnmounted, ref, watch, type Ref } from "vue"

/** Track one element's height for as long as it is mounted. */
export function useElementHeight(el: Ref<HTMLElement | null>): Ref<number> {
  const height = ref(0)
  let observer: ResizeObserver | null = null
  watch(
    el,
    (node) => {
      observer?.disconnect()
      observer = null
      if (!node) return
      observer = new ResizeObserver(() => (height.value = node.offsetHeight))
      observer.observe(node)
      height.value = node.offsetHeight
    },
    { immediate: true }
  )
  onUnmounted(() => observer?.disconnect())
  return height
}

import { onMounted, onUnmounted } from "vue"
import { useIngestPollingStore } from "@shruti/stores/useIngestPollingStore.js"

/**
 * Ask for live status of the in-flight personal-library items while this
 * surface is on screen.
 *
 * A thin claim on `useIngestPollingStore`, which owns the one poll loop: three
 * views call this, Ionic keeps all three mounted once visited, and one loop per
 * view meant three times the `GET /orchestrator/run/{jobId}` traffic for the
 * same job (#1589). The lifetime still belongs here — a view's mount and
 * unmount are what a claim is scoped to — but the loop itself does not.
 */
export function useIngestStatusPolling(): void {
  const polling = useIngestPollingStore()
  let release: (() => void) | null = null

  onMounted(() => {
    release = polling.retain()
  })
  onUnmounted(() => {
    release?.()
    release = null
  })
}

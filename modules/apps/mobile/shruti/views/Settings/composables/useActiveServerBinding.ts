import { ref, watch, type Ref } from "vue"
import type { CdnServer } from "@lib/domain/servers.js"

export interface SelectorItem {
  id: string
  title: string
}

export interface UseActiveServerBindingOptions {
  servers: readonly CdnServer[]
  initial: CdnServer
  setActiveServer: (server: CdnServer) => void
}

export interface UseActiveServerBindingReturn {
  activeServerId: Ref<string>
  serverItems: SelectorItem[]
}

/**
 * Two-way binding between a UI-friendly server-id ref and the app's
 * active server. Picking a new id calls `setActiveServer` with the
 * matching `CdnServer` so the rest of the app sees the change.
 */
export function useActiveServerBinding(
  options: UseActiveServerBindingOptions
): UseActiveServerBindingReturn {
  const activeServerId = ref<string>(options.initial.id)
  const serverItems: SelectorItem[] = options.servers.map((s) => ({ id: s.id, title: s.name }))

  watch(activeServerId, (next) => {
    const server = options.servers.find((s) => s.id === next)
    if (server) options.setActiveServer(server)
  })

  return { activeServerId, serverItems }
}

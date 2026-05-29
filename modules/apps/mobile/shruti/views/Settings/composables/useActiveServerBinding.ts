import { computed, type ComputedRef, type Ref } from "vue"
import type { CdnServer } from "@lib/domain/servers.js"

export interface SelectorItem {
  id: string
  title: string
}

export interface UseActiveServerBindingOptions {
  servers: readonly CdnServer[]
  /** Reactive reference to the currently-preferred server. The
   *  composition root mutates this directly (via `setActiveServer` /
   *  `setActiveServerById`); the binding just exposes its id for UI. */
  activeServer: Ref<CdnServer>
}

export interface UseActiveServerBindingReturn {
  activeServerId: ComputedRef<string>
  serverItems: SelectorItem[]
}

/**
 * Read-only view of the preferred server's id for UI use. The selector
 * write path simply flips `activeServer` (no migration); failover lives
 * inside the HTTP client.
 */
export function useActiveServerBinding(
  options: UseActiveServerBindingOptions
): UseActiveServerBindingReturn {
  const activeServerId = computed(() => options.activeServer.value.id)
  const serverItems: SelectorItem[] = options.servers.map((s) => ({ id: s.id, title: s.name }))
  return { activeServerId, serverItems }
}

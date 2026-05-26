import { computed, type ComputedRef, type Ref } from "vue"
import type { CdnServer } from "@lib/domain/servers.js"

export interface SelectorItem {
  id: string
  title: string
}

export interface UseActiveServerBindingOptions {
  servers: readonly CdnServer[]
  /** Reactive reference to the currently-active server. The
   *  composition root mutates this directly (via `setActiveServer` /
   *  `setActiveServerById`); the binding just exposes its id for UI. */
  activeServer: Ref<CdnServer>
}

export interface UseActiveServerBindingReturn {
  activeServerId: ComputedRef<string>
  serverItems: SelectorItem[]
}

/**
 * Read-only view of the active server's id for UI use. Region changes
 * are no longer driven by an `activeServerId` watcher — the Settings
 * tap handler explicitly runs the confirm + migration flow and the
 * composition root flips `activeServer` on success (signed-in path)
 * or the tap handler does so directly (anonymous path). This binding
 * just keeps the selector in sync with whatever the composition root
 * has set.
 */
export function useActiveServerBinding(
  options: UseActiveServerBindingOptions
): UseActiveServerBindingReturn {
  const activeServerId = computed(() => options.activeServer.value.id)
  const serverItems: SelectorItem[] = options.servers.map((s) => ({ id: s.id, title: s.name }))
  return { activeServerId, serverItems }
}

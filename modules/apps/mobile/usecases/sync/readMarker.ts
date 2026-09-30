import type { ISyncMarkerStore } from "./syncEnginePorts.js"

/** A device-local marker, or `null` when it is absent or cannot be read. */
export function readMarker(markers: ISyncMarkerStore, key: string): Promise<string | null> {
  return markers.get(key).catch((err: unknown) => {
    console.warn("[sync] marker read failed", key, err)
    return null
  })
}

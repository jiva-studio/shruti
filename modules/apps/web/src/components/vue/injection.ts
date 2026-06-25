import type { InjectionKey } from 'vue'

/** Provided by WebApp (the persistent island), injected by the in-chat track
 *  card: opens a track in the left panel via client-side select() — no page
 *  reload, the chat island stays mounted. */
export const OPEN_TRACK: InjectionKey<(trackId: string) => void> = Symbol('openTrack')

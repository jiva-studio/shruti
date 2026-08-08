/** What a tile currently is. `loading` is a tile standing in for one on its way. */
export type TileStatus = "loading" | "addable" | "pending" | "ready" | "failed"

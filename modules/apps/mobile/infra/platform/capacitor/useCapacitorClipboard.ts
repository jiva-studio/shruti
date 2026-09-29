import type { IClipboard } from "@ports/app/index.js"

/** {@link IClipboard} over `@capacitor/clipboard`, loaded on first use. */
export function useCapacitorClipboard(): IClipboard {
  return {
    async writeText(text) {
      const { Clipboard } = await import("@capacitor/clipboard")
      await Clipboard.write({ string: text })
    },
  }
}

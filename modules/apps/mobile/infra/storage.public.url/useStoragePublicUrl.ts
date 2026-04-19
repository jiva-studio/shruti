import type { IStoragePublicUrl } from "@ports/app/index.js"

export function useStoragePublicUrl(getUrlTemplate: () => string): IStoragePublicUrl {
  return {
    get: (path: string) => {
      return getUrlTemplate().replace("{path}", path)
    },
  }
}

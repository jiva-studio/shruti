// Known violation: a store reads the repository bundle instead of calling a use case.
import { useShruti } from "@shruti/shruti.js"

export async function fixture(): Promise<unknown> {
  return useShruti().repositories().notes.listRecent(1)
}

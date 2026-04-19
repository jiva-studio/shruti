import { readdirSync } from "node:fs"
import { join } from "node:path"

export function walk(dir: string, visit: (file: string) => void): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, visit)
    else if (entry.isFile()) visit(path)
  }
}

import type { IDatabase } from "@ports/app/index.js"

export interface Migration {
  name: string
  up: (db: IDatabase) => Promise<void>
}

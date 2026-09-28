import type { LibraryShelf } from "@usecases/library/libraryShelf.js"
import {
  loadLibraryShelf,
  removeFromLibrary,
  restoreToLibrary,
} from "@usecases/library/libraryShelf.js"
import { useShruti } from "@shruti/shruti.js"

export interface LibraryUseCases {
  loadShelf(): Promise<LibraryShelf>
  remove(id: string): Promise<void>
  restore(id: string): Promise<void>
}

/** The personal-library use cases, bound to the repositories. Each call
 *  resolves them afresh, so it throws until the databases are open. */
export function useLibraryUseCases(): LibraryUseCases {
  const app = useShruti()
  return {
    loadShelf: () => loadLibraryShelf(app.repositories()),
    remove: (id) => removeFromLibrary(id, app.repositories()),
    restore: (id) => restoreToLibrary(id, app.repositories()),
  }
}

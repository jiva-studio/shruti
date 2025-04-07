/**
 * Stores information about a source. For example, a book, letter, or other.
 */
export type Source = {
  _id: string
  version: number
  fullName: Record<string, string>
  shortName: Record<string, string>
}

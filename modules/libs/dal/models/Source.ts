/**
 * Stores information about a source. For example, a book, letter, or other.
 */
export type Source = {
  _id: string
  type: "source"
  version: number
  fullName: Record<string, string>
  shortName: Record<string, string>
}

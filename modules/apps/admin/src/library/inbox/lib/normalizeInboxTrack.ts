import type { Reference } from '@lectorium/dal/models'
import {
  useAuthorsService,
  useLocationsService,
  useSourcesService,
} from '@lectorium/admin/shared'

export function normalizeTitle(value: string | undefined): string {
  if (value === undefined) {
    return ''
  }
  return value.trim()
}

export function normalizeDate(value: string | number[]): string {
  if (Array.isArray(value)) {
    return value.join('-')
  }
  return value.toString()
}

export async function normalizeAuthor(
  value: string | undefined,
): Promise<string> {
  const authors = useAuthorsService()
  if (!value) {
    return 'Empty'
  }
  try {
    const author = await authors.getOne('author::' + value)
    return author.fullName['en']
  } catch (error) {
    return value ?? 'Empty'
  }
}

export async function normalizeLocation(
  value: string | undefined,
): Promise<string> {
  const locations = useLocationsService()
  if (!value) {
    return 'Empty'
  }
  try {
    const location = await locations.getOne('location::' + value)
    return location.name['en']
  } catch (error) {
    return value ?? 'Empty'
  }
}

export async function normalizeReference(
  reference: Reference | undefined,
): Promise<string> {
  const sourcesService = useSourcesService()
  if (!reference || reference.length === 0) {
    return '<Error>'
  }
  try {
    const book = reference[0].toString()
    const numbers = reference.slice(1)
    const source = await sourcesService.getOne('source::' + book.toLowerCase())
    return `${source.shortName['en']} ${numbers.join('.')}`
  } catch {
    return reference.join(' ')
  }
}

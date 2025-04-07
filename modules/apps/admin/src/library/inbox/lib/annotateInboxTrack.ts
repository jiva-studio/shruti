import type { InboxTrack, Reference } from '@lectorium/dal/models'
import {
  useAuthorsService,
  useLocationsService,
  useSourcesService,
} from '@lectorium/admin/shared'

export type Annotation = {
  text: string
  severity: 'error' | 'warn'
}

/* -------------------------------------------------------------------------- */
/*                                   Methods                                  */
/* -------------------------------------------------------------------------- */

export async function annotateInboxTrack(
  inboxTrack: InboxTrack,
): Promise<Record<string, Annotation[]>> {
  return {
    title: annotateTitle(inboxTrack.title.normalized || ''),
    date: annotateDate(inboxTrack.date.normalized || []),
    author: await annotateAuthor(inboxTrack.author.normalized || ''),
    location: await annotateLocation(inboxTrack.location.normalized || ''),
    references: (
      await Promise.all(
        (inboxTrack.references.normalized || []).flatMap(
          async (x) => await annotateReference(x),
        ),
      )
    ).flat(),
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

export function annotateTitle(title: string | undefined): Annotation[] {
  const annotations: Annotation[] = []
  if (!title) {
    annotations.push({ text: 'Title is empty', severity: 'error' })
  } else if (title.length < 5) {
    annotations.push({ text: 'Title is too short', severity: 'warn' })
  }
  return annotations
}

export function annotateDate(date: number[] | undefined): Annotation[] {
  const annotations: Annotation[] = []
  if (!date) {
    annotations.push({ text: 'Date is not found', severity: 'warn' })
  } else if (
    date.some((x) => x === undefined || x === null) ||
    date.length !== 3
  ) {
    annotations.push({ text: 'Date is incomplete', severity: 'warn' })
  } else {
    const parsedDate = new Date(`${date[0]}-${date[1]}-${date[2]}`)
    const isValidDate =
      parsedDate instanceof Date && !isNaN(parsedDate.getTime())
    if (!isValidDate) {
      annotations.push({ text: 'Date is invalid', severity: 'error' })
    }
  }
  return annotations
}

export async function annotateAuthor(
  author: string | undefined,
): Promise<Annotation[]> {
  const authorsService = useAuthorsService()
  const annotations: Annotation[] = []

  if (!author) {
    annotations.push({ text: 'Author is not found', severity: 'error' })
  } else {
    try {
      await authorsService.getOne('author::' + author)
    } catch (error) {
      annotations.push({
        text: `Author is not found by id "${author}"`,
        severity: 'error',
      })
    }
  }
  return annotations
}

export async function annotateLocation(
  location: string | undefined,
): Promise<Annotation[]> {
  const locationsService = useLocationsService()
  const annotations: Annotation[] = []

  if (!location) {
    annotations.push({ text: 'Location is not found', severity: 'warn' })
  } else {
    try {
      await locationsService.getOne('location::' + location)
    } catch (error) {
      annotations.push({ text: 'Location is not found', severity: 'error' })
    }
  }
  return annotations
}

export async function annotateReference(
  reference: Reference | undefined,
): Promise<Annotation[]> {
  const sourcesService = useSourcesService()
  const annotations: Annotation[] = []

  if (!reference || reference.length === 0) {
    annotations.push({ text: 'No references', severity: 'warn' })
    return annotations
  }

  try {
    const book = reference[0].toString()
    await sourcesService.getOne('source::' + book.toLowerCase())
  } catch {
    annotations.push({
      text: `Reference not found "${reference.join(' ')}"`,
      severity: 'error',
    })
  }
  return annotations
}

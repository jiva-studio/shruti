import { Track } from '@lectorium/dal/models'
import { TracksListItemData } from '@/app'
import { useDAL } from '@/app'

// TODO: move to @/app

export async function mapTrackToPlaylistItem(
  track: Track
): Promise<TracksListItemData> {
  return {
    trackId: track._id,
    title: mapTrackTitle(track.title),
    author: await mapAuthorFullNameById(track.author), 
    location: await mapLocationFullNameById(track.location),
    references: track.references.map(x => x.join(' ')),
    date: mapTrackDate(track.date),
    status: 'none', // TODO: set status based on playlist item
  }
}

/* -------------------------------------------------------------------------- */
/*                                    Title                                   */
/* -------------------------------------------------------------------------- */

function mapTrackTitle(
  titles: Record<string, string>,
  language: string = 'en'
): string {
  return titles[language] 
    || titles[Object.keys(titles)[0]] 
    || 'No title'
}

/* -------------------------------------------------------------------------- */
/*                                    Date                                    */
/* -------------------------------------------------------------------------- */

function mapTrackDate(
  input: [number, number?, number?],
  locale: string = 'ru-RU'
): string {
  if (input.length === 1) {
    return input[0].toString()
  } else if (input.length === 2) {
    return new Date(
      Number(input[0]),
      Number(input[1])-1,
    ).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
    })
  } else if (input.length === 3) {
    return new Date(
      Number(input[0]),
      Number(input[1])-1,
      Number(input[2])
    ).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    })
  }
  return ''
}

/* -------------------------------------------------------------------------- */
/*                                   Author                                   */
/* -------------------------------------------------------------------------- */

async function mapAuthorFullNameById(authorId: string) {
  try {
    const dal = useDAL()
    const author = await dal.authors.getOne('author::' + authorId)
    return author.fullName['en'] || 'Unknown'
  } catch (error) {
    return authorId
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Location                                  */
/* -------------------------------------------------------------------------- */

async function mapLocationFullNameById(locationId: string) {
  try {
    const dal = useDAL()
    const location = await dal.locations.getOne('location::' + locationId)
    return location.fullName['en'] || locationId
  } catch (error) {
    return locationId
  }
}
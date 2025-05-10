import type { InboxTrack } from '@lectorium/dal/models'
import type { EditInboxTrack } from '@lectorium/admin/library/inbox'

export function mapEditInboxTrackToInboxTrack(
  editInboxTrack: EditInboxTrack,
  inboxTrack: InboxTrack,
): InboxTrack {
  inboxTrack.title.normalized = editInboxTrack.title
  inboxTrack.author.normalized = editInboxTrack.author
  inboxTrack.location.normalized = editInboxTrack.location
  inboxTrack.date.normalized = editInboxTrack.date
  inboxTrack.references.normalized = editInboxTrack.references.map((x) =>
    x
      .split(/\s|\./)
      .map((item, index) =>
        index > 0 && !isNaN(parseInt(item)) ? parseInt(item) : item,
      ),
  )
  inboxTrack.languagesExtract = editInboxTrack.languagesExtract
  inboxTrack.languagesTranslateInto = editInboxTrack.languagesTranslateInto
  inboxTrack.status = editInboxTrack.status
  inboxTrack.tags = editInboxTrack.tags
  return inboxTrack
}

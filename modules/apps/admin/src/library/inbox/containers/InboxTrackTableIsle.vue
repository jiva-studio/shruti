<template>
  <InboxTracksTable
    :rows="inboxTracks"
    @open="onTrackSelected"
    @refresh="onRefresh"
  />
</template>

<script setup lang="ts">
import { useAsyncState } from '@vueuse/core'
import {
  type InboxTrackTableRow,
  InboxTracksTable,
  annotateTitle,
  normalizeTitle,
  normalizeDate,
  annotateDate,
  normalizeAuthor,
  annotateAuthor,
  annotateLocation,
  normalizeLocation,
  normalizeReference,
  annotateReference,
} from '@lectorium/admin/library/inbox'
import { useInboxTracksService, useSync } from '@lectorium/admin/shared'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const { sync } = useSync()
const inboxTracksService = useInboxTracksService()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const emit = defineEmits<{
  open: [trackId: string]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { state: inboxTracks, execute } = useAsyncState<InboxTrackTableRow[]>(
  getTracks,
  [],
  { immediate: true, resetOnExecute: false },
)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function getTracks() {
  const result: InboxTrackTableRow[] = []
  const inboxTracks = await inboxTracksService.getProcessable()
  for (const track of inboxTracks) {
    const r = await Promise.all(
      (track.references.normalized || []).map(async (x) => ({
        value: await normalizeReference(x),
        annotations: await annotateReference(x),
      })),
    )

    result.push({
      id: track._id,
      status: track.status,
      title: {
        value: normalizeTitle(track.title.normalized ?? track.title.extracted),
        annotations: annotateTitle(track.title.normalized),
      },
      date: {
        value: normalizeDate(track.date.normalized ?? track.date.extracted),
        annotations: annotateDate(track.date.normalized),
      },
      author: {
        value: await normalizeAuthor(
          track.author.normalized ?? track.author.extracted,
        ),
        annotations: await annotateAuthor(track.author.normalized),
      },
      location: {
        value: await normalizeLocation(
          track.location.normalized ?? track.location.extracted,
        ),
        annotations: await annotateLocation(track.location.normalized),
      },
      references: r,
    })
  }
  return result
}

async function onTrackSelected(id: string) {
  emit('open', id)
}

async function onRefresh() {
  await sync()
  await execute()
}
</script>

<template>
  <InboxTrackDrawer
    v-model:visible="visible"
    v-model:track="editTrack"
    :annotations="annotations"
    :authors="authors"
    :locations="locations"
    @save="onSave"
    @start-processing="onStartProcessing"
  />
</template>

<script setup lang="ts">
import { ref, toRefs, watch } from 'vue'
import { useAsyncState } from '@vueuse/core'
import {
  useAuthorsService,
  useInboxTracksService,
  useLocationsService,
} from '@lectorium/admin/shared'
import {
  type EditInboxTrack,
  type EditInboxTrackAnnotation,
  InboxTrackDrawer,
  annotateAuthor,
  annotateDate,
  annotateInboxTrack,
  annotateLocation,
  annotateReference,
  annotateTitle,
  normalizeReference,
  mapEditInboxTrackToInboxTrack,
} from '@lectorium/admin/library/inbox'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const authorsService = useAuthorsService()
const locationsService = useLocationsService()
const inboxTracksService = useInboxTracksService()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  trackId: string | undefined
}>()

const visible = defineModel<boolean>('visible', { required: true })

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { trackId } = toRefs(props)
const { state: authors } = useAsyncState(getAuthors, [], {
  resetOnExecute: false,
})
const { state: locations } = useAsyncState(getLocations, [], {
  resetOnExecute: false,
})

const editTrack = ref<EditInboxTrack>()
const annotations = ref<Record<string, EditInboxTrackAnnotation[]>>({})

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(trackId, onTrackLoad)
watch(
  editTrack,
  async (v) => {
    if (!v) return
    annotations.value.title = annotateTitle(v.title)
    annotations.value.date = annotateDate(v.date)
    annotations.value.author = await annotateAuthor(v.author)
    annotations.value.location = await annotateLocation(v.location)
    annotations.value.references = (
      await Promise.all(
        v.references.map(
          async (x) => await annotateReference(x.split(/\s|\./)),
        ),
      )
    ).flat()
  },
  { deep: true },
)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function onSave() {
  await save()
  visible.value = false
}

async function onStartProcessing() {
  if (!editTrack.value) return
  editTrack.value.status = 'pending'
  await save()
  visible.value = false
}

async function onTrackLoad(trackId: string | undefined) {
  if (!trackId) return

  const inboxTrack = await inboxTracksService.getOne(trackId)
  editTrack.value = {
    path: inboxTrack.path,
    status: inboxTrack.status,
    date: inboxTrack.date.normalized ?? [],
    references: await Promise.all(
      (inboxTrack.references.normalized ?? []).map(
        async (x) => await normalizeReference(x),
      ),
    ),
    title: inboxTrack.title.normalized ?? '',
    author: inboxTrack.author.normalized ?? '',
    location: inboxTrack.location.normalized ?? '',
    languagesExtract: inboxTrack.languagesExtract ?? [],
    languagesTranslateInto: inboxTrack.languagesTranslateInto ?? [],
  }
  annotations.value = await annotateInboxTrack(inboxTrack)
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

async function getAuthors() {
  const authors = await authorsService.getAll()
  return authors.map((x) => ({
    label: x.fullName['en'],
    value: x._id.replace('author::', ''),
  }))
}

async function getLocations() {
  const locations = await locationsService.getAll({ limit: 100 })
  return locations.map((x) => ({
    label: x.fullName['en'],
    value: x._id.replace('location::', ''),
  }))
}

async function save() {
  if (!props.trackId) return
  if (!editTrack.value) return
  const inboxTrack = await inboxTracksService.getOne(props.trackId)
  mapEditInboxTrackToInboxTrack(editTrack.value, inboxTrack)
  await inboxTracksService.updateOne(props.trackId, inboxTrack)
}
</script>

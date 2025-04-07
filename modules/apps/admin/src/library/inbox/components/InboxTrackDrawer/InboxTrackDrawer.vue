<template>
  <Drawer
    v-model:visible="visible"
    position="right"
    header="Edit Track"
    class="!w-full md:!w-80 lg:!w-[30rem]"
  >
    <div class="break-all">
      {{ track.path }}
    </div>

    <Divider />

    <div class="grid gap-6">
      <LanguageField
        id="extractLanguages"
        v-model:value="track.languagesExtract"
        label="Extract languages"
        :errors="annotations.languagesExtract"
      />

      <LanguageField
        id="translateInto"
        v-model:value="track.languagesTranslateInto"
        label="Translate into"
        :errors="annotations.languagesTranslateInto"
      />

      <Divider />

      <TitleField v-model:title="track.title" :errors="annotations.title" />

      <AuthorField
        v-model:author="track.author"
        :errors="annotations.author"
        :authors="authors"
      />

      <LocationField
        v-model:location="track.location"
        :errors="annotations.location"
        :locations="locations"
      />

      <DateField v-model:date="track.date" :errors="annotations.date" />

      <ReferencesField
        v-model:references="track.references"
        :errors="annotations.references"
      />
    </div>

    <template #footer>
      <div class="flex items-center gap-2">
        <Button
          v-tooltip.top="'Save changes'"
          icon="pi pi-save"
          class="flex-auto"
          @click="onSaveClicked"
        />
        <Button
          v-tooltip.top="'Save changes and start processing'"
          label="Start processing"
          icon="pi pi-angle-double-right"
          class="flex-auto"
          fluid
          :disabled="hasErrors"
          @click="onStartProcessingClicked"
        />
      </div>
    </template>
  </Drawer>
</template>

<script setup lang="ts">
import { defineModel, computed } from 'vue'
import Button from 'primevue/button'
import Drawer from 'primevue/drawer'
import Divider from 'primevue/divider'
import TitleField from './Fields/TitleField.vue'
import AuthorField from './Fields/AuthorField.vue'
import LocationField from './Fields/LocationField.vue'
import ReferencesField from './Fields/ReferencesField.vue'
import DateField from './Fields/DateField.vue'
import LanguageField from './Fields/LanguageField.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type EditInboxTrack = {
  path: string
  status:
    | 'new'
    | 'verification'
    | 'pending'
    | 'processing'
    | 'processed'
    | 'error'
  date: number[]
  references: string[]
  title: string
  author: string
  location: string
  languagesExtract: string[]
  languagesTranslateInto: string[]
}

export type EditInboxTrackAnnotation = {
  text: string
  severity: 'error' | 'warn'
}

const props = defineProps<{
  authors: { label: string; value: string }[]
  locations: { label: string; value: string }[]
  annotations: Record<string, EditInboxTrackAnnotation[]>
}>()

const emit = defineEmits<{
  save: []
  startProcessing: []
}>()

const visible = defineModel<boolean>('visible', {
  default: false,
  required: true,
})
const track = defineModel<EditInboxTrack>('track', { default: () => ({}) })

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const hasErrors = computed(() =>
  Object.keys(props.annotations)
    .map((x) => props.annotations[x])
    .some((x) => x.some((y) => y.severity === 'error')),
)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onSaveClicked() {
  emit('save')
}

function onStartProcessingClicked() {
  emit('startProcessing')
}
</script>

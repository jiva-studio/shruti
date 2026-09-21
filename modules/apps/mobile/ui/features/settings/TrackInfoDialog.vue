<script setup lang="ts">
import { computed } from "vue"
import {
  IonModal,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonContent,
  IonList,
  IonListHeader,
  IonLabel,
  IonReorderGroup,
} from "@ionic/vue"
import { Header } from "@ui/primitives/index.js"
import TrackInfoFieldRow from "./TrackInfoFieldRow.vue"
import TrackInfoTopSelect from "./TrackInfoTopSelect.vue"
import {
  TrackListItem,
  type TrackMetaConfig,
  type TrackMetaField,
  type TrackMetaFieldKey,
  type TrackMetaTopKey,
} from "@ui/components/tracks/list/index.js"

defineProps<{ open: boolean }>()

const config = defineModel<TrackMetaConfig>("config", { required: true })

const emit = defineEmits<{ "update:open": [open: boolean] }>()

// Sample reference shown in the preview row; everything else is i18n so
// it localizes with the rest of the dialog.
const PREVIEW_REFERENCES = ["BG 2.59"]

// The line rows = every field except whichever is promoted to the top
// widget, so the same piece of info is never offered twice.
const visibleBottom = computed<TrackMetaField[]>(() =>
  config.value.bottom.filter((f) => f.field !== config.value.top)
)

const topValue = computed<TrackMetaTopKey | null>({
  get: () => config.value.top,
  set: (value) => {
    config.value = { ...config.value, top: value }
  },
})

function onReorder(ev: CustomEvent): void {
  // Ionic reorders the (filtered) list we hand to complete() and returns
  // it. The top field is rendered inline above and excluded here, so we
  // append it back — its position in the stored array is irrelevant
  // until it returns to the line.
  const detail = ev.detail as { complete: (data: TrackMetaField[]) => TrackMetaField[] }
  const reordered = detail.complete([...visibleBottom.value])
  const topItem = config.value.bottom.find((f) => f.field === config.value.top)
  config.value = { ...config.value, bottom: topItem ? [...reordered, topItem] : reordered }
}

function onToggle(field: TrackMetaFieldKey, checked: boolean): void {
  config.value = {
    ...config.value,
    bottom: config.value.bottom.map((f) => (f.field === field ? { ...f, enabled: checked } : f)),
  }
}

function onClose(): void {
  emit("update:open", false)
}
</script>

<template>
  <IonModal :is-open="open" class="track-info-dialog" @did-dismiss="onClose">
    <Header class="flat-header">
      <IonToolbar>
        <IonTitle>{{ $t("settings.trackInfo.title") }}</IonTitle>
        <IonButtons slot="end">
          <IonButton strong @click="onClose">{{ $t("app.ok") }}</IonButton>
        </IonButtons>
      </IonToolbar>
    </Header>

    <IonContent>
      <!-- Live preview: a sample row that re-renders as the user changes
           the top widget, toggles and reorders the line fields below. -->
      <div class="preview">
        <TrackListItem
          track-id="preview"
          :title="$t('settings.trackInfo.preview.title')"
          :references="PREVIEW_REFERENCES"
          :tags="[]"
          :author="$t('settings.trackInfo.preview.author')"
          :location="$t('settings.trackInfo.preview.location')"
          :date="$t('settings.trackInfo.preview.date')"
          :duration="$t('settings.trackInfo.preview.duration')"
          :config="config"
        />
      </div>

      <!-- Top slot: a single prominent widget on the title row, or nothing. -->
      <IonList lines="none" class="ion-no-margin">
        <IonListHeader>
          <IonLabel>{{ $t("settings.trackInfo.top") }}</IonLabel>
        </IonListHeader>
        <TrackInfoTopSelect v-model="topValue" />
      </IonList>

      <!-- Bottom line: every field except the one promoted to the top
           widget — toggle each on/off and drag to reorder. -->
      <IonList lines="none" class="ion-no-margin">
        <IonListHeader>
          <IonLabel>{{ $t("settings.trackInfo.bottom") }}</IonLabel>
        </IonListHeader>
        <IonReorderGroup :disabled="false" @ion-reorder-end="onReorder">
          <TrackInfoFieldRow
            v-for="f in visibleBottom"
            :key="f.field"
            :label="$t(`settings.trackInfo.fields.${f.field}`)"
            :enabled="f.enabled"
            @toggle="(enabled: boolean) => onToggle(f.field, enabled)"
          />
        </IonReorderGroup>
      </IonList>
    </IonContent>
  </IonModal>
</template>

<style scoped>
.preview {
  margin: 8px 0 4px;
  pointer-events: none;
}
</style>

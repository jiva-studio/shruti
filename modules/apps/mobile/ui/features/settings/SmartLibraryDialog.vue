<template>
  <IonModal :is-open="open" class="smart-library-dialog" @did-dismiss="onClose">
    <Header class="flat-header">
      <IonToolbar>
        <IonTitle>{{ $t("settings.smartLibrary.title") }}</IonTitle>
        <IonButtons slot="end">
          <IonButton strong @click="onClose">{{ $t("app.ok") }}</IonButton>
        </IonButtons>
      </IonToolbar>
    </Header>

    <IonContent>
      <IonList lines="none" class="ion-no-margin ion-no-padding">
        <IonItem>
          <IonLabel>{{ $t("settings.smartLibrary.enable") }}</IonLabel>
          <IonToggle
            slot="end"
            :checked="isEnabled"
            label-placement="start"
            @ion-change="onToggleEnabled"
          />
        </IonItem>
      </IonList>

      <p class="hint">{{ $t("settings.smartLibrary.hint") }}</p>

      <IonListHeader>
        <IonLabel>{{ $t("settings.smartLibrary.sections.filter") }}</IonLabel>
      </IonListHeader>
      <IonList lines="none" class="ion-no-margin ion-no-padding">
        <IonItem button detail :disabled="!isEnabled" @click="emit('open-filters')">
          <IconChip slot="start">
            <IconFilterFilled :size="22" />
          </IconChip>
          <IonLabel class="ion-text-nowrap">
            <h2>{{ $t("settings.smartLibrary.filter.label") }}</h2>
            <p>{{ filterSummary || $t("settings.smartLibrary.filter.none") }}</p>
          </IonLabel>
        </IonItem>
      </IonList>

      <IonListHeader>
        <IonLabel>{{ $t("settings.smartLibrary.sections.target") }}</IonLabel>
      </IonListHeader>
      <IonList lines="none" class="ion-no-margin ion-no-padding">
        <IonRadioGroup :model-value="selectedPreset" @ion-change="onPresetChange">
          <IonItem v-for="preset in TARGET_PRESETS" :key="preset.id" :disabled="!isEnabled">
            <IonRadio :value="preset.id">
              {{ $t(`settings.smartLibrary.target.${preset.id}`) }}
            </IonRadio>
          </IonItem>
        </IonRadioGroup>
      </IonList>

      <IonListHeader>
        <IonLabel>{{ $t("settings.smartLibrary.sections.archive") }}</IonLabel>
      </IonListHeader>
      <IonList lines="none" class="ion-no-margin ion-no-padding">
        <IonRadioGroup :model-value="archiveDelay" @ion-change="onArchiveChange">
          <IonItem v-for="opt in ARCHIVE_OPTIONS" :key="opt" :disabled="!isEnabled">
            <IonRadio :value="opt">
              {{ $t(`settings.smartLibrary.archive.${archiveOptionKey(opt)}`) }}
            </IonRadio>
          </IonItem>
        </IonRadioGroup>
      </IonList>
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import {
  IonModal,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonContent,
  IonList,
  IonListHeader,
  IonItem,
  IonLabel,
  IonRadioGroup,
  IonRadio,
  IonToggle,
} from "@ionic/vue"
import { IconFilterFilled } from "@tabler/icons-vue"
import { Header, IconChip } from "@ui/primitives/index.js"
import {
  ARCHIVE_OPTIONS,
  archiveOptionKey,
  isSmartLibraryEnabled,
  smartLibraryToggled,
  type AutoArchiveDelay,
} from "./smartLibrary.js"

const TARGET_PRESETS = [
  { id: "30m", seconds: 30 * 60 },
  { id: "1h", seconds: 60 * 60 },
  { id: "2h", seconds: 2 * 60 * 60 },
  { id: "3h", seconds: 3 * 60 * 60 },
  { id: "5h", seconds: 5 * 60 * 60 },
  { id: "8h", seconds: 8 * 60 * 60 },
  { id: "10h", seconds: 10 * 60 * 60 },
] as const

type PresetId = (typeof TARGET_PRESETS)[number]["id"]

const props = defineProps<{
  open: boolean
  filterSummary: string
}>()

const targetSeconds = defineModel<number>("targetSeconds", { required: true, default: 0 })
const archiveDelay = defineModel<AutoArchiveDelay>("archiveDelay", {
  required: true,
  default: "off",
})
/**
 * The last schedule picked while the feature was on, persisted alongside the
 * live value. `archiveDelay` is forced to `"off"` whenever the master switch
 * goes off, so it cannot double as the memory (#1663).
 */
const lastArchiveDelay = defineModel<AutoArchiveDelay>("lastArchiveDelay", {
  required: true,
  default: "off",
})

const emit = defineEmits<{
  "update:open": [open: boolean]
  "open-filters": []
}>()

const lastNonZeroSeconds = ref<number>(targetSeconds.value > 0 ? targetSeconds.value : 0)

watch(targetSeconds, (v) => {
  if (v > 0) lastNonZeroSeconds.value = v
})

const isEnabled = computed<boolean>(() =>
  isSmartLibraryEnabled({ targetSeconds: targetSeconds.value, archiveDelay: archiveDelay.value })
)

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    // Heal builds that persisted a live delay behind the off switch (#1624),
    // so re-enabling can't resurrect an archive schedule the user never picked.
    if (!isEnabled.value) {
      archiveDelay.value = "off"
      return
    }
    // Seed the memory from a schedule chosen before it existed, so the first
    // off/on cycle after the upgrade doesn't lose it.
    lastArchiveDelay.value = archiveDelay.value
  }
)

const selectedPreset = computed<PresetId | undefined>(() => {
  const match = TARGET_PRESETS.find((p) => p.seconds === targetSeconds.value)
  return match?.id
})

function onToggleEnabled(ev: CustomEvent): void {
  const checked = (ev.detail as { checked: boolean }).checked
  const next = smartLibraryToggled(
    checked,
    { targetSeconds: targetSeconds.value, archiveDelay: archiveDelay.value },
    lastNonZeroSeconds.value,
    lastArchiveDelay.value
  )
  targetSeconds.value = next.targetSeconds
  archiveDelay.value = next.archiveDelay
}

function onPresetChange(ev: CustomEvent): void {
  const id = (ev.detail as { value?: PresetId }).value
  if (!id) return
  const preset = TARGET_PRESETS.find((p) => p.id === id)
  if (!preset) return
  targetSeconds.value = preset.seconds
}

function onArchiveChange(ev: CustomEvent): void {
  const value = (ev.detail as { value?: AutoArchiveDelay }).value
  if (!value) return
  archiveDelay.value = value
  // Only an explicit pick becomes the memory — the master switch's fail-closed
  // "off" must not overwrite it.
  if (isEnabled.value) lastArchiveDelay.value = value
}

function onClose(): void {
  emit("update:open", false)
}
</script>

<style scoped>
/* The bare hint paragraph would otherwise span the full content width,
   flush to the dialog's left/right edges. Indent it to line up with the
   list items above and below. */
.hint {
  margin-inline: 16px;
}
</style>

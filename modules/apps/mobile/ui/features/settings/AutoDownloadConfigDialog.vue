<template>
  <IonModal :is-open="open" class="auto-download-dialog" @did-dismiss="onClose">
    <Header>
      <IonToolbar>
        <IonTitle>{{ $t("settings.autoDownload.title") }}</IonTitle>
        <IonButtons slot="end">
          <IonButton strong @click="onClose">{{ $t("app.ok") }}</IonButton>
        </IonButtons>
      </IonToolbar>
    </Header>

    <IonContent>
      <IonList lines="none" class="ion-no-margin ion-no-padding">
        <IonItem>
          <IonLabel>{{ $t("settings.autoDownload.enable") }}</IonLabel>
          <IonToggle
            slot="end"
            :checked="isEnabled"
            label-placement="start"
            @ion-change="onToggleEnabled"
          />
        </IonItem>
      </IonList>

      <p class="hint">{{ $t("settings.autoDownload.hint") }}</p>

      <IonListHeader :class="{ 'is-disabled': !isEnabled }">
        <IonLabel>{{ $t("settings.autoDownload.sections.filter") }}</IonLabel>
      </IonListHeader>
      <IonList lines="none" class="ion-no-margin ion-no-padding">
        <IonItem button detail :disabled="!isEnabled" @click="emit('open-filters')">
          <IconChip slot="start">
            <IconFilterFilled :size="22" />
          </IconChip>
          <IonLabel class="ion-text-nowrap">
            <h2>{{ $t("settings.autoDownload.filter.label") }}</h2>
            <p>{{ filterSummary || $t("settings.autoDownload.filter.none") }}</p>
          </IonLabel>
        </IonItem>
      </IonList>

      <IonListHeader :class="{ 'is-disabled': !isEnabled }">
        <IonLabel>{{ $t("settings.autoDownload.sections.target") }}</IonLabel>
      </IonListHeader>
      <IonList lines="none" class="ion-no-margin ion-no-padding">
        <IonRadioGroup :model-value="selectedPreset" @ion-change="onPresetChange">
          <IonItem v-for="preset in PRESETS" :key="preset.id" :disabled="!isEnabled">
            <IonRadio :value="preset.id">
              {{ $t(`settings.autoDownload.target.${preset.id}`) }}
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

const DEFAULT_SECONDS = 30 * 60

const PRESETS = [
  { id: "30m", seconds: 30 * 60 },
  { id: "1h", seconds: 60 * 60 },
  { id: "2h", seconds: 2 * 60 * 60 },
  { id: "3h", seconds: 3 * 60 * 60 },
  { id: "5h", seconds: 5 * 60 * 60 },
  { id: "8h", seconds: 8 * 60 * 60 },
  { id: "10h", seconds: 10 * 60 * 60 },
] as const

type PresetId = (typeof PRESETS)[number]["id"]

defineProps<{
  open: boolean
  filterSummary: string
}>()

const targetSeconds = defineModel<number>("targetSeconds", { required: true, default: 0 })

const emit = defineEmits<{
  "update:open": [open: boolean]
  "open-filters": []
}>()

// Remember the most-recent non-zero target so toggling Off → On
// restores the user's previous selection instead of always defaulting.
const lastNonZeroSeconds = ref<number>(targetSeconds.value > 0 ? targetSeconds.value : 0)

watch(targetSeconds, (v) => {
  if (v > 0) lastNonZeroSeconds.value = v
})

const isEnabled = computed<boolean>(() => targetSeconds.value > 0)

const selectedPreset = computed<PresetId | undefined>(() => {
  const match = PRESETS.find((p) => p.seconds === targetSeconds.value)
  return match?.id
})

function onToggleEnabled(ev: CustomEvent): void {
  const checked = (ev.detail as { checked: boolean }).checked
  if (checked) {
    targetSeconds.value = lastNonZeroSeconds.value > 0 ? lastNonZeroSeconds.value : DEFAULT_SECONDS
  } else {
    targetSeconds.value = 0
  }
}

function onPresetChange(ev: CustomEvent): void {
  const id = (ev.detail as { value?: PresetId }).value
  if (!id) return
  const preset = PRESETS.find((p) => p.id === id)
  if (!preset) return
  targetSeconds.value = preset.seconds
}

function onClose(): void {
  emit("update:open", false)
}
</script>

<style scoped>
.hint {
  margin: 16px 16px 8px;
  font-size: 13px;
  line-height: 1.4;
  color: var(--ion-color-medium);
}

.is-disabled {
  opacity: 0.4;
}
</style>

<style>
.auto-download-dialog ion-header,
.auto-download-dialog ion-header::after {
  box-shadow: none !important;
  background-image: none;
}
.auto-download-dialog ion-header::after {
  display: none;
}
</style>

<template>
  <IonItem button detail lines="none" @click="open = true">
    <IconChip slot="start">
      <IconDownload :size="22" />
    </IconChip>

    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.autoDownload.title") }}</h2>
      <p>{{ $t("settings.autoDownload.description") }}</p>
    </IonLabel>
  </IonItem>

  <ListItemSelectorDialog
    v-model:open="open"
    :value="selected"
    :title="$t('settings.autoDownload.title')"
    :items="items"
    :allow-empty="false"
    @close="open = false"
    @select="onSelect"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { IonItem, IonLabel } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import { IconDownload } from "@tabler/icons-vue"
import { ListItemSelectorDialog } from "@ui/components/selectors/index.js"
import { IconChip } from "@ui/primitives/index.js"

const PRESETS = [
  { id: "off", seconds: 0 },
  { id: "30m", seconds: 30 * 60 },
  { id: "1h", seconds: 60 * 60 },
  { id: "2h", seconds: 2 * 60 * 60 },
  { id: "3h", seconds: 3 * 60 * 60 },
  { id: "5h", seconds: 5 * 60 * 60 },
  { id: "8h", seconds: 8 * 60 * 60 },
  { id: "10h", seconds: 10 * 60 * 60 },
] as const

type PresetId = (typeof PRESETS)[number]["id"]

const value = defineModel<number>({ required: true, default: 0 })

const { t } = useI18n()
const open = ref(false)

const items = computed<{ id: PresetId; title: string }[]>(() =>
  PRESETS.map((p) => ({ id: p.id, title: t(`settings.autoDownload.target.${p.id}`) }))
)

const selected = computed<PresetId>(() => {
  const match = PRESETS.find((p) => p.seconds === value.value)
  return match ? match.id : "off"
})

function onSelect(next?: string) {
  if (!next) return
  const preset = PRESETS.find((p) => p.id === next)
  if (!preset) return
  value.value = preset.seconds
}
</script>

<template>
  <IonItem button :detail="true" lines="none" @click="open = true">
    <IconChip slot="start">
      <CloudIcon />
    </IconChip>

    <IonLabel class="ion-text-wrap">
      <h2>{{ $t("settings.preferredServer.title") }}</h2>
      <p>{{ subtitle }}</p>
    </IonLabel>
  </IonItem>

  <ListItemSelectorDialog
    v-model:open="open"
    :value="value"
    :title="$t('settings.preferredServer.title')"
    :items="items"
    :allow-empty="false"
    @close="open = false"
    @select="onSelect"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { IonItem, IonLabel } from "@ionic/vue"
import { CloudIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"
import { ListItemSelectorDialog } from "@ui/components/selectors/index.js"

interface Props {
  items: { id: string; title: string }[]
}

const props = defineProps<Props>()
const value = defineModel<string>({ required: true, default: "" })

const open = ref(false)
const { t } = useI18n()

// Two lines: which server is currently active, plus the fall-through
// reassurance. Keeps users from worrying that picking the "wrong" one
// would break the app if it's unreachable.
const subtitle = computed(() => {
  const name = props.items.find((i) => i.id === value.value)?.title ?? value.value
  return `${name} · ${t("settings.preferredServer.fallbackHint")}`
})

function onSelect(next?: string): void {
  if (!next) return
  value.value = next
}
</script>

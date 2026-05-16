<template>
  <IonItem button detail lines="none" @click="open = true">
    <!-- Item Icon -->
    <IconChip slot="start">
      <ArchiveIcon />
    </IconChip>

    <!-- Text -->
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.autoArchive.title") }}</h2>
      <p>{{ $t("settings.autoArchive.description") }}</p>
    </IonLabel>
  </IonItem>

  <!-- Delay Selection Dialog -->
  <ListItemSelectorDialog
    v-model:open="open"
    :value="value"
    :title="$t('settings.autoArchive.title')"
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
import { ListItemSelectorDialog } from "@ui/components/selectors/index.js"
import { ArchiveIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type AutoArchiveDelay = "off" | "immediate" | "8h" | "1d" | "2d" | "3d"

const value = defineModel<AutoArchiveDelay>({ required: true, default: "off" })

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { t } = useI18n()
const open = ref(false)

// Fixed list — i18n labels resolve reactively when the UI language flips.
const items = computed<{ id: AutoArchiveDelay; title: string }[]>(() => [
  { id: "off", title: t("settings.autoArchive.delay.off") },
  { id: "immediate", title: t("settings.autoArchive.delay.immediate") },
  { id: "8h", title: t("settings.autoArchive.delay._8h") },
  { id: "1d", title: t("settings.autoArchive.delay._1d") },
  { id: "2d", title: t("settings.autoArchive.delay._2d") },
  { id: "3d", title: t("settings.autoArchive.delay._3d") },
])

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onSelect(next?: string) {
  if (!next) return
  value.value = next as AutoArchiveDelay
}
</script>

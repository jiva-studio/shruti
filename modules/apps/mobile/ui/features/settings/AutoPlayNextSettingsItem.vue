<template>
  <IonItem lines="none">
    <IconChip slot="start">
      <IconPlayerTrackNextFilled :size="22" />
    </IconChip>

    <IonLabel class="ion-text-nowrap">
      <h2>
        {{ $t("settings.player.autoPlayNext.title") }}
        <ProBadge :label="$t('app.proBadge')" />
      </h2>
      <p>{{ $t("settings.player.autoPlayNext.description") }}</p>
    </IonLabel>

    <IonToggle
      :key="toggleEpoch"
      slot="end"
      :checked="effectiveChecked"
      label-placement="start"
      @ion-change="onChange"
    />
  </IonItem>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { IonItem, IonLabel, IonToggle } from "@ionic/vue"
import { IconPlayerTrackNextFilled } from "@tabler/icons-vue"
import { IconChip, ProBadge } from "@ui/primitives/index.js"

const props = defineProps<{ isSubscribed: boolean }>()
const value = defineModel<boolean>({ required: true, default: false })
const emit = defineEmits<{ "request-paywall": [] }>()

// Master toggle is OFF for non-subscribers regardless of stored state —
// same contract as AutomaticScrollSettingsItem so an expired sub silently
// disables continuous playback without losing the user's preference.
const effectiveChecked = computed<boolean>(() => value.value && props.isSubscribed)

// Force-remount the toggle when we reject a non-Pro flip; the web
// component already toggled its own DOM state on tap and Vue won't diff
// back because `effectiveChecked` stayed false the whole time.
const toggleEpoch = ref(0)

function onChange(ev: CustomEvent): void {
  const checked = (ev.detail as { checked: boolean }).checked
  if (checked && !props.isSubscribed) {
    emit("request-paywall")
    toggleEpoch.value++
    return
  }
  value.value = checked
}
</script>

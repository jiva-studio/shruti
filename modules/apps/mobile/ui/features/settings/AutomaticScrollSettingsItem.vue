<template>
  <IonItem lines="none">
    <IconChip slot="start">
      <IconArrowAutofitDown :size="22" />
    </IconChip>

    <IonLabel class="ion-text-nowrap">
      <h2>
        {{ $t("settings.transcript.autoScroll.title") }}
        <ProBadge :label="$t('app.proBadge')" />
      </h2>
      <p>{{ $t("settings.transcript.autoScroll.description") }}</p>
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
import { IconArrowAutofitDown } from "@tabler/icons-vue"
import { IconChip, ProBadge } from "@ui/primitives/index.js"

const props = defineProps<{ isSubscribed: boolean }>()
const value = defineModel<boolean>({ required: true, default: false })
const emit = defineEmits<{ "request-paywall": [] }>()

// Master toggle is OFF for non-subscribers regardless of stored state —
// matches SmartLibraryDialog so an expired sub silently disables the
// feature without losing the user's preference.
const effectiveChecked = computed<boolean>(() => value.value && props.isSubscribed)

// Bumped to force-remount the toggle when we reject a non-Pro flip; the
// web component already toggled its own DOM state on tap, and Vue won't
// diff back to false because `effectiveChecked` stayed false the whole
// time. A fresh IonToggle boots from the correct `:checked` value.
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

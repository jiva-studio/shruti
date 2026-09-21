<script setup lang="ts">
import { computed } from "vue"
import { IonBackButton, IonButton, IonButtons, IonHeader, IonTitle, IonToolbar } from "@ionic/vue"
import { IconPlaylistAdd } from "@tabler/icons-vue"

// The toolbar rides over the hero: transparent at the top, opaque with the
// title once the hero has scrolled past. With no hero behind it (`flat`) it is
// opaque from the start, or its cream-on-scrim back button sits invisible.
const props = defineProps<{
  title: string
  scrollTop: number
  heroHeight: number
  flat: boolean
  addDisabled: boolean
  addLabel: string
}>()

const emit = defineEmits<{ add: [] }>()

const opacity = computed(() =>
  props.flat ? 1 : Math.min(1, Math.max(0, (props.scrollTop - (props.heroHeight - 120)) / 100))
)
const solid = computed(() => opacity.value > 0.5)
const titleStyle = computed(() => ({ opacity: opacity.value }))
const toolbarStyle = computed(() => ({
  "--background": `rgba(var(--ion-background-color-rgb), ${opacity.value})`,
}))
</script>

<template>
  <IonHeader class="hero-header ion-no-border">
    <IonToolbar class="hero-toolbar" :class="{ solid }" :style="toolbarStyle">
      <IonButtons slot="start">
        <IonBackButton default-href="/tabs/search" />
      </IonButtons>
      <IonTitle :style="titleStyle">{{ title }}</IonTitle>
      <IonButtons slot="end">
        <IonButton
          class="no-ripple"
          :disabled="addDisabled"
          :aria-label="addLabel"
          @click="emit('add')"
        >
          <IconPlaylistAdd :size="24" />
        </IonButton>
      </IonButtons>
    </IonToolbar>
  </IonHeader>
</template>

<style scoped>
.hero-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
}

.hero-header::after {
  display: none;
}

.hero-toolbar {
  --background: rgba(var(--ion-background-color-rgb), 0);
  --border-width: 0;
}

.hero-toolbar ion-back-button,
.hero-toolbar ion-buttons ion-button,
.hero-toolbar ion-buttons ion-button :deep(svg) {
  --color: var(--shruti-scrim-cream);
  color: var(--shruti-scrim-cream);
}

.hero-toolbar.solid ion-back-button,
.hero-toolbar.solid ion-buttons ion-button,
.hero-toolbar.solid ion-buttons ion-button :deep(svg) {
  --color: var(--ion-text-color);
  color: var(--ion-text-color);
}

.hero-toolbar ion-title {
  transition: opacity 120ms ease;
}
</style>

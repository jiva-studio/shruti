<script setup lang="ts">
import { IonLabel, IonList, IonListHeader } from "@ionic/vue"
import HelpIndicatorRow from "./HelpIndicatorRow.vue"
import type { UiTrackState } from "@ui/components/tracks/state/types.js"

interface Row {
  state: UiTrackState
  progress?: number
  // Path under `help.indicators.*` (no `.title`/`.description` suffix).
  labelKey: string
}

interface Screen {
  id: "home" | "search"
  rows: Row[]
}

// Rows are ordered by state precedence so the help reads in the same
// order the indicator picks a state at runtime. The Home "progress"
// row covers both `playing` and `queued` states — they render the same
// medium-coloured radial ring; only the value source differs (live
// playback vs saved position), and surfacing that as two help rows
// just confused readers.
const screens: Screen[] = [
  {
    id: "home",
    rows: [
      { state: "downloading", progress: 45, labelKey: "common.downloading" },
      { state: "failed", labelKey: "common.failed" },
      { state: "queued", progress: 60, labelKey: "home.progress" },
      { state: "completed", labelKey: "common.completed" },
    ],
  },
  {
    id: "search",
    rows: [
      { state: "downloading", progress: 45, labelKey: "common.downloading" },
      { state: "failed", labelKey: "common.failed" },
      { state: "completed", labelKey: "common.completed" },
      { state: "added", labelKey: "search.added" },
    ],
  },
]
</script>

<template>
  <div class="help-indicators">
    <p class="intro">{{ $t("help.indicators.intro") }}</p>

    <template v-for="screen in screens" :key="screen.id">
      <IonListHeader>
        <IonLabel>{{ $t(`help.indicators.screens.${screen.id}.title`) }}</IonLabel>
      </IonListHeader>
      <p class="screen-intro">
        {{ $t(`help.indicators.screens.${screen.id}.description`) }}
      </p>

      <IonList>
        <HelpIndicatorRow
          v-for="row in screen.rows"
          :key="row.labelKey"
          :state="row.state"
          :progress="row.progress"
          :title="$t(`help.indicators.${row.labelKey}.title`)"
          :description="$t(`help.indicators.${row.labelKey}.description`)"
        />
      </IonList>
    </template>
  </div>
</template>

<style scoped>
.help-indicators {
  padding: 0 0 24px;
}

.intro {
  padding: 0 16px;
  margin: 0 0 12px;
  color: var(--ion-color-medium);
}

.screen-intro {
  padding: 0 16px;
  margin: 4px 0 8px;
  color: var(--ion-color-medium);
}
</style>

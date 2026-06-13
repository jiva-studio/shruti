<template>
  <template v-for="item in items" :key="itemKey(item)">
    <PlaylistRow
      v-if="item.kind === 'track'"
      :row="item.row"
      @click="emit('click', $event)"
      @delete="emit('delete', $event)"
    />
    <IonAccordionGroup v-else :value="item.id" class="collection-group">
      <IonAccordion :value="item.id">
        <IonItem slot="header" lines="none" class="group-header">
          <IonLabel>{{ item.name }}</IonLabel>
          <IonNote slot="end">{{ item.rows.length }}</IonNote>
        </IonItem>
        <div slot="content" class="group-content">
          <PlaylistRow
            v-for="row in item.rows"
            :key="row.id"
            :row="row"
            @click="emit('click', $event)"
            @delete="emit('delete', $event)"
          />
        </div>
      </IonAccordion>
    </IonAccordionGroup>
  </template>
</template>

<script setup lang="ts">
import { IonAccordion, IonAccordionGroup, IonItem, IonLabel, IonNote } from "@ionic/vue"
import PlaylistRow from "./PlaylistRow.vue"
import type { PlaylistRenderItem } from "./types.js"

/**
 * Renders the Home playlist as a mix of standalone track rows and collapsible
 * collection groups. Groups start expanded (the accordion's value matches its
 * own id) so the user sees the collection's tracks immediately and can collapse
 * it. Grouping is derived upstream (usePlaylistGroups) from collection
 * membership — this component is presentation-only.
 */
defineProps<{
  items: readonly PlaylistRenderItem[]
}>()

const emit = defineEmits<{
  click: [trackId: string]
  delete: [trackId: string]
}>()

function itemKey(item: PlaylistRenderItem): string {
  return item.kind === "track" ? `t:${item.row.id}` : `g:${item.id}:${item.rows[0]?.id ?? ""}`
}
</script>

<style scoped>
/* The group container blends into the playlist background; the header is a
   lightweight subheader, not a heavy card, so grouped runs read as a labelled
   stretch of the same list rather than a separate widget. */
.collection-group {
  background: transparent;
}

.group-header {
  --background: var(--ion-background-color);
  --min-height: 40px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ion-color-primary);
}

.group-content {
  /* Slight indent so nested rows read as belonging to the group above. */
  padding-left: 6px;
}
</style>

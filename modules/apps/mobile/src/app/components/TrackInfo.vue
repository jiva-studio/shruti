<template>
  <h3 class="title-block">
    <span
      v-if="references[0]"
      class="reference"
    >
      {{ references[0] }}
    </span>
    <span
      v-if="references?.length > 1"
      class="reference extra"
    >
      +{{ references.length-1 }}
    </span>
    <span
      v-if="tags[0] && references?.length === 0"
      class="reference"
    >
      {{ tags[0] }}
    </span>
    <span class="title">{{ title }}</span>
  </h3>
</template>


<script setup lang="ts">
defineProps<{
  title: string
  references: string[]
  tags: string[]
}>()
</script>

<style scoped>
.title-block {
  display: flex;
  align-items: center;
  gap: 5px;
}

.title {
  text-overflow: ellipsis;
  overflow: hidden;
}

.reference {
  background-color: var(--ion-color-light-shade);
  font-weight: bold;
  color: var(--ion-color-medium);
  border-radius: 5px;
  padding: 0px 5px;
  font-size: 0.8em;
  font-stretch: condensed;
}

.reference.extra {
  color: var(--ion-color-medium);
  font-stretch: condensed;
  opacity: .5;
}
</style>
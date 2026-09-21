<script setup lang="ts">
defineProps<{
  title: string
  author: string
}>()
</script>

<template>
  <div class="card">
    <h1 v-if="title" class="title">
      {{ title }}
    </h1>
    <p v-if="author" class="author">
      {{ author }}
    </p>
  </div>
</template>

<style scoped>
.card {
  padding: 2px;
  padding-inline: 16px;
  padding-top: max(env(safe-area-inset-top), 16px);
}

.title {
  color: var(--ion-text-color);
  text-align: center;
  font-size: 1.4rem;
  margin-bottom: 0;
  padding-bottom: 0;
  line-height: 1.1;
}

.author {
  opacity: 0.8;
  color: var(--ion-text-color);
  text-align: center;
  font-size: 14px;
  margin: 12px 0px;
}
</style>

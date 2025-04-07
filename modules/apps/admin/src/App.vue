<template>
  <Menubar />
  <br />
  <RouterView />
</template>

<script setup lang="ts">
import { Menubar } from '@shruti/admin/shared'
import { RouterView } from 'vue-router'
</script>

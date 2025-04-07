<template>
  <Menubar />
  <br />
  <RouterView />
</template>

<script setup lang="ts">
import { Menubar } from '@lectorium/admin/shared'
import { RouterView } from 'vue-router'
</script>

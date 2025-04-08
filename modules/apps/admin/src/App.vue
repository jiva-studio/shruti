<template>
  <Toast />
  <MainLayout v-if="auth.isAuthenticated.value">
    <template #menu>
      <Menubar />
    </template>
    <template #main>
      <RouterView />
    </template>
  </MainLayout>
  <PlainLayout v-else>
    <RouterView />
  </PlainLayout>
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router'
import { useAuth } from '@shruti/admin/auth'
import { Toast } from 'primevue'
import { MainLayout, PlainLayout, Menubar } from '@shruti/admin/shared'

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const auth = useAuth()
</script>

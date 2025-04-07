<template>
  <Menubar :model="items">
    <template #start>
      <LectoriumLogo />
    </template>

    <!-- <template #item="{ item, props, hasSubmenu, root }">
      <a
        v-ripple
        class="flex items-center"
        v-bind="props.action"
      >
        <span :class="item.icon" />
        <span class="ml-2">{{ item.label }}</span>
        <Badge
          v-if="item.badge"
          :class="{ 'ml-auto': !root, 'ml-2': root }"
          :value="item.badge"
        />
        <span
          v-if="item.shortcut"
          class="ml-auto border border-surface rounded bg-emphasis text-muted-color text-xs p-1"
        >
          {{ item.shortcut }}
        </span>
        <i
          v-if="hasSubmenu"
          :class="['pi pi-angle-down', { 'pi-angle-down ml-2': root, 'pi-angle-right ml-auto': !root }]"
        />
      </a>
    </template> -->
  </Menubar>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import Menubar from 'primevue/menubar'
import { LectoriumLogo } from '@lectorium/admin/shared'
import { useRouter } from 'vue-router'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const router = useRouter()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const items = ref([
  {
    label: 'Inbox',
    icon: 'pi pi-inbox',
    path: 'inbox',
    command: () => router.push({ name: 'inbox' }),
  },
])
</script>

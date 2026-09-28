<!-- Known violation: a view's script block binds a driven adapter directly. -->
<script setup lang="ts">
import { useCapacitorPreferenceKeys } from "@infra/preferences/index"

const keys = useCapacitorPreferenceKeys
</script>

<template>
  <div>{{ keys }}</div>
</template>

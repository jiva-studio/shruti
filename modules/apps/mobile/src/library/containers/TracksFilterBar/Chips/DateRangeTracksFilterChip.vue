<template>
  <TracksFilterChipWithDateRange 
    v-model="modelValue"
    title="📆 Dates"
  />
</template>


<script lang="ts" setup>
import { DateRange } from '@/app'
import { TracksFilterChipWithDateRange } from '@/library'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const modelValue = defineModel<DateRange>({ required: true, default: { from: '', to: ''} })
</script>
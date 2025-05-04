<template>
  <TracksFilterChipWithDateRange 
    v-model="modelValue"
    :title="$t('search.filters.dates')"
  />
</template>


<script lang="ts" setup>
import { DateRange } from '@lectorium/mobile/app'
import { TracksFilterChipWithDateRange } from '@lectorium/mobile/search'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const modelValue = defineModel<DateRange>({ required: true, default: { from: '', to: ''} })
</script>
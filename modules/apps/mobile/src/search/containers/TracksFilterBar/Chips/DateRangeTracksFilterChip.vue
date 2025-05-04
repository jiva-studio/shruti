<template>
  <TracksFilterChipWithDateRange 
    v-model="modelValue"
    :title="$t('search.filters.dates')"
  />
</template>


<script lang="ts" setup>
import { DateRange } from '@shruti/mobile/app'
import { TracksFilterChipWithDateRange } from '@shruti/mobile/search'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const modelValue = defineModel<DateRange>({ required: true, default: { from: '', to: ''} })
</script>
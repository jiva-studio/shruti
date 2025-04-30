<template>
  <TracksFilterChipWithDateRange 
    v-model="modelValue"
    :title="$t('library.filters.dates')"
  />
</template>


<script lang="ts" setup>
import { DateRange } from '@shruti/mobile/app'
import { TracksFilterChipWithDateRange } from '@shruti/mobile/library'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const modelValue = defineModel<DateRange>({ required: true, default: { from: '', to: ''} })
</script>
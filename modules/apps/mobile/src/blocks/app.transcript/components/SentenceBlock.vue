<template>
  <span>
    <!-- Speaker Icon -->
    <span
      v-if="icon"
      data-block-id="12"
      class="icon"
    >
      {{ icon }}
    </span>

    <!-- Formated Text -->
    <span 
      v-safe-html="text + ' '"
      v-bind="$attrs"
    />

    <!-- Speaker Reference -->
    <span
      v-if="reference"
      class="reference"
    >
      {{ reference }}
    </span>
  </span>
</template>


<script lang="ts" setup>
/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  text: string,
  icon?: string
  reference?: string
}>()
</script>


<style scoped>
.icon {
  opacity: .8;
  font-size: .6rem;
  text-align: right;
  transform: translateY(-100px);
  position: relative;
  top: -2px;
}

.speaker {
  font-weight: bold;
  margin-right: .25rem;
}

.reference {
  opacity: .5;
  background-color: white;
  color: black;
  border-radius: 3px;
  font-size: .75rem;
  padding: .125rem;
  margin-right: .25rem;
  white-space: nowrap;
}
</style>

<template>
  <span class="text">
    <span
      v-if="reference"
      class="reference floating"
      :class="{
        'visible': referenceVisible,
        'hidden': !referenceVisible,
      }"
    >
      {{ reference }}
    </span>
    {{ text }}.
  </span>
</template>


<script lang="ts" setup>
/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  reference?: string
  referenceVisible: boolean
  text: string
}>()
</script>


<style scoped>
.text {
  font-style: italic;
}

.reference {
  background-color: var(--ion-color-warning);
  color: var(--ion-color-warning-contrast);
  border-radius: 3px;
  font-size: .8rem;
  padding: .25rem;
  white-space: nowrap;
  transition: all .2s ease-in-out;
  box-shadow: 0px 0px 12px rgba(0, 0, 0, .25);
  font-style: normal;
}

.floating {
  position: absolute;
  transform: translate(0%, -120%);
}

.visible {
  opacity: 1;
}

.hidden {
  opacity: 0;
}
</style>
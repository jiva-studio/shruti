<template>
  <span>
    <!-- Speaker Icon -->
    <span
      v-if="icon"
      class="icon"
    >
      {{ icon }}
    </span>

    <!-- Formated Text -->
    <span>
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
      <span
        v-bind="$attrs"
        v-html="text + ' '"
      />
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
  referenceVisible: boolean
}>()
</script>


<style scoped>
.icon {
  opacity: .8;
  font-size: .8rem;
  text-align: right;
  position: relative;
  top: -2px;
  padding-right: 2px;
}

.speaker {
  font-weight: bold;
  margin-right: .25rem;
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
  pointer-events: none;
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

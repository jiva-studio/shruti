<script lang="ts" setup>
import { computed } from "vue"
import { renderInlineMarkdown } from "@lib/ui/transcript/renderInlineMarkdown.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  text: string
  icon?: string
  newLine?: boolean
  showDash?: boolean
  reference?: string
  referenceVisible: boolean
}>()

const html = computed(() => renderInlineMarkdown(props.text) + " ")
</script>

<template>
  <span>
    <!-- Speaker Icon -->
    <span v-if="icon" class="icon">
      {{ icon }}
    </span>

    <!-- Formated Text -->
    <span>
      <span
        v-if="reference"
        class="reference floating"
        :class="{
          visible: referenceVisible,
          hidden: !referenceVisible,
        }"
      >
        {{ reference }}
      </span>

      <br v-else-if="newLine" />
      <span v-if="showDash" class="no-stretch">–&nbsp;</span>

      <span v-bind="$attrs" v-html="html" />
    </span>
  </span>
</template>

<style scoped>
.icon {
  opacity: 0.8;
  font-size: 0.8rem;
  text-align: right;
  position: relative;
  top: -2px;
  padding-right: 2px;
}

.speaker {
  font-weight: bold;
  margin-right: 0.25rem;
}

.reference {
  background-color: var(--ion-color-warning);
  color: var(--ion-color-warning-contrast);
  border-radius: 3px;
  font-size: 0.8rem;
  padding: 0.25rem;
  white-space: nowrap;
  transition: all 0.2s ease-in-out;
  box-shadow: var(--lectorium-verse-glow);
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

.no-stretch {
  text-align-last: left;
  display: inline-block;
}
</style>

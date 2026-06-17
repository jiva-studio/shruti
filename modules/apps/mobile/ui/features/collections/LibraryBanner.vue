<template>
  <button type="button" class="library-banner ion-activatable" @click="emit('click')">
    <template v-if="background">
      <picture>
        <source
          v-if="backgroundDark"
          :srcset="backgroundDark"
          media="(prefers-color-scheme: dark)"
        />
        <img class="banner-bg" :src="background" alt="" aria-hidden="true" />
      </picture>
      <span class="banner-scrim" aria-hidden="true" />
    </template>

    <span class="banner-text">
      <span class="banner-title">
        {{ title }}
        <ProBadge v-if="proBadge" :label="proBadgeLabel ?? ''" />
      </span>
      <span class="banner-desc">{{ description }}</span>
    </span>

    <IconChevronRight class="banner-chevron" :size="20" :stroke-width="2" />
    <IonRippleEffect />
  </button>
</template>

<script setup lang="ts">
import { IonRippleEffect } from "@ionic/vue"
import { IconChevronRight } from "@tabler/icons-vue"
import { ProBadge } from "@ui/primitives/index.js"

/**
 * A single-row entry banner for the Search page — a title with an optional
 * description below it and a trailing chevron. Used for the "search the whole
 * library" and "smart library" shelves that sit between the carousels. Styled
 * as a card (radius + shadow) to match the cover tiles.
 *
 * An optional decorative `background` image sits behind the row, anchored to
 * the right and dissolved into the warm card tint by a left-to-right scrim, so
 * the text on the left stays on a calm surface and remains legible.
 *
 * Presentation-only: the caller supplies the copy and decides what a tap does.
 */
defineProps<{
  title: string
  description: string
  /** Render a PRO badge after the title (gated features). */
  proBadge?: boolean
  proBadgeLabel?: string
  /** Decorative right-anchored background image URL (light theme). */
  background?: string
  /** Dark-theme variant of the background, shown under prefers-color-scheme: dark. */
  backgroundDark?: string
}>()

const emit = defineEmits<{ (e: "click"): void }>()
</script>

<style scoped>
.library-banner {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  appearance: none;
  border: none;
  text-align: left;
  /* Inset to the same 16px gutter as the carousels, styled as a card to match
     the cover tiles: same corner radius and the same soft shadow. */
  margin: 4px 16px 14px;
  padding: 14px;
  border-radius: 4px;
  --banner-bg: color-mix(in srgb, var(--ion-color-primary) 7%, var(--ion-background-color));
  background: var(--banner-bg);
  box-shadow: 0 1px 4px rgba(var(--ion-color-dark-rgb), 0.12);
  overflow: hidden;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

/* Keep the <picture> wrapper out of the flex flow so it adds no column or gap.
   `display: contents` is not enough: the in-flow <source> child would still
   count as a (zero-width) flex item and the container's gap would push the
   text right. Absolutely positioning the whole art layer removes it from flow. */
picture {
  position: absolute;
  inset: 0;
}

/* Decorative cover: fills the card, focal art kept to the right edge. */
.banner-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: right center;
}

/* Dissolve the art into the card tint from the left so the text stays on a
   calm surface; the illustration only reads on the right, behind the chevron. */
.banner-scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to right,
    var(--banner-bg) 0%,
    var(--banner-bg) 42%,
    color-mix(in srgb, var(--banner-bg) 35%, transparent) 72%,
    transparent 100%
  );
}

/* Content sits above the absolutely-positioned art + scrim. */
.banner-text,
.banner-chevron {
  position: relative;
}

.banner-text {
  flex: 1;
  min-width: 0;
}

.banner-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--ion-text-color);
}

.banner-desc {
  display: block;
  margin-top: 2px;
  font-size: 13px;
  line-height: 1.3;
  color: var(--ion-color-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.banner-chevron {
  flex: 0 0 auto;
  color: var(--ion-color-medium);
}

.library-banner:active {
  background: color-mix(in srgb, var(--ion-color-primary) 12%, var(--ion-background-color));
}
</style>

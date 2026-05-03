<template>
  <!-- No Teleport: the parent (App.vue) renders us directly inside
       <IonApp>, which is the same DOM container Ionic mounts its
       overlays into (action-sheet, alert, modal, toast, popover —
       see @ionic/core .../overlays.js: getAppRoot returns ion-app).
       Sitting in the same container means Ionic's :host z-index: 1001
       actually competes with our z-index — see .player below. -->
  <PlayerControls
    :playing="playing"
    :title="title"
    :author="author"
    :duration="duration"
    :position="position"
    :show-progress="showProgress"
    :play-button-size="playButtonSize"
    :class="{
      player: true,
      floating: !sticked,
      stick: sticked,
      hidden: hidden,
      pulsing: pulsing,
    }"
    @play="emit('playClicked')"
    @click="emit('click')"
  />
</template>

<script setup lang="ts">
import PlayerControls from "./PlayerControls.vue"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

withDefaults(
  defineProps<{
    playing: boolean
    title: string
    author: string
    hidden: boolean
    duration: number
    position: number
    showProgress: boolean
    sticked: boolean
    pulsing: boolean
    /** Forwarded to PlayerControls; default matches iOS tap-target sizing. */
    playButtonSize?: number
  }>(),
  { playButtonSize: 44 }
)

const emit = defineEmits<{
  playClicked: []
  click: []
}>()
</script>

<style scoped>
.player {
  /* Below Ionic overlays (action-sheet/alert/loading/toast/popover all
     use z-index ~1001 via :host). We're in the same DOM container
     (ion-app) as those overlays, so this comparison actually works. */
  z-index: 999;
  position: fixed;
  transition: all 0.5s ease-in-out;
}

.floating {
  bottom: calc(56px + var(--ion-safe-area-bottom, 0px));
  height: 58px;
  left: 16px;
  right: 16px;
  border-radius: 10px;
  box-shadow: 0 4px 16px rgba(var(--ion-color-primary-rgb), 0.35);
}

.stick {
  /* Minimum 12px floor so the content isn't flush to the bottom on
     web or on devices without a safe-area inset; respects the inset
     when it exceeds the floor (notched mobiles). */
  height: calc(56px + max(var(--ion-safe-area-bottom, 0px), 12px));
  padding-bottom: max(var(--ion-safe-area-bottom, 0px), 12px);

  bottom: 0;
  left: 0;
  right: 0;
  border-top-left-radius: 5px;
  border-top-right-radius: 5px;
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

.hidden {
  opacity: 0;
  bottom: 0;
  pointer-events: none;
}

/* On tablets/desktops the floating mini-player switches to a capped,
 * centred width so it sits aligned with the page content column. The
 * width is the shared --lectorium-content-max-width minus the 16px+16px
 * lateral inset the floating variant uses on phones. We override the
 * phone-mode `left: 16px; right: 16px` to `0`, then set an explicit
 * `width` and `margin-inline: auto` — the CSS spec only distributes
 * absolute auto-margins when all of left, right, and width are
 * non-auto. Centring this way avoids `transform: translateX(-50%)`,
 * which would conflict with the `.pulsing` keyframe's scale transform. */
@media (min-width: 768px) {
  .floating {
    left: 0;
    right: 0;
    width: calc(var(--lectorium-content-max-width) - 32px);
    margin-inline: auto;
  }
  .stick {
    left: 0;
    right: 0;
    width: var(--lectorium-content-max-width);
    margin-inline: auto;
  }
}

.pulsing {
  animation: inviteClick 3s ease-in-out infinite;
}

@keyframes inviteClick {
  0%,
  100% {
    transform: scale(1);
  }
  10% {
    transform: scale(0.98);
  }
  20% {
    transform: scale(1.01);
  }
  30% {
    transform: scale(0.99);
  }
  40% {
    transform: scale(1);
  }
}
</style>

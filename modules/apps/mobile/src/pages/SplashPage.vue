<template>
  <IonPage>
    <div class="splash">
      <img :src="logo">
      <IonSpinner
        name="dots"
        size="large"
      />
    </div>
  </IonPage>
</template>

<script setup lang="ts">
import { createAnimation, IonPage, IonSpinner, useIonRouter } from '@ionic/vue'
import { useEventBus } from '@lectorium/mobile/core'
import logo from '@blocks/app.ui.kit/assets/icon.png'

/* -------------------------------------------------------------------------- */
/*                                 Depenencies                                */
/* -------------------------------------------------------------------------- */

const eventBus = useEventBus()
const router = useIonRouter()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const customFadeAnimation = (baseEl: HTMLElement, opts: any) => {
  const enteringEl = opts.enteringEl
  const leavingEl = opts.leavingEl

  const entering = createAnimation()
    .addElement(enteringEl)
    .duration(400)
    .fromTo('opacity', '0', '1')

  const leaving = createAnimation()
    .addElement(leavingEl)
    .duration(400)
    .fromTo('opacity', '1', '0')

  return createAnimation()
    .addAnimation([entering, leaving])
}

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

eventBus.appReady.subscribe(async () => {
  router.push('/app/home', customFadeAnimation)
})
</script>

<style scoped>
.splash {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  max-width: 50%;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}
</style>

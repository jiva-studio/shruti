<template>
  <div class="subscription-benefit">
    <IonItem
      class="benefit"
      lines="none"
    >
      <div slot="start">
        {{ icon }}
      </div>
      <IonLabel>
        <h2>{{ title }}</h2>
        <p>{{ description }}</p>
      </IonLabel>
    </IonItem>
          
    <div
      v-if="tag"
      class="tag"
    >
      {{ tag }}
    </div>
  </div>
</template>


<script lang="ts" setup>
import { IonItem, IonLabel } from '@ionic/vue'

defineProps<{
  title: string
  description: string
  icon: string
  tag?: string
}>()
</script>


<style scoped>
.subscription-benefit {
  position: relative;
}

.benefit {
  margin-bottom: 10px;
  border-radius: 8px;
}

.tag {
  position: absolute;
  border-radius: 5px;
  padding: .3rem;
  transform: rotate(-23deg);
  top: 3px;
  right: -3px;
  background-color: var(--ion-color-primary);
  color: var(--ion-color-dark-contrast);
  font-size: .55rem;
  z-index: 1;
}
</style>
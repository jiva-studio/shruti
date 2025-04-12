<template>
  <IonItem>
    <IonLabel>
      <h3>
        <IonSkeletonText
          :animated="true"
          style="width: 80%;"
        />
      </h3>
      <p>
        <IonSkeletonText
          :animated="true"
          style="width: 60%;"
        />
      </p>
    </IonLabel>
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonSkeletonText } from '@ionic/vue'
</script>
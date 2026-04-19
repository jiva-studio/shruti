<template>
  <IonPage>
    <IonHeader>
      <IonToolbar>
        <IonTitle>Lectorium</IonTitle>
      </IonToolbar>
    </IonHeader>
    <IonContent :fullscreen="true" class="ion-padding">
      <IonList>
        <IonItem button router-link="/tabs/search" :detail="true">
          <IonLabel>Search</IonLabel>
        </IonItem>
        <IonItem button router-link="/tabs/notes" :detail="true">
          <IonLabel>Notes</IonLabel>
        </IonItem>
        <IonItem button router-link="/tabs/settings" :detail="true">
          <IonLabel>Settings</IonLabel>
        </IonItem>
      </IonList>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import {
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonPage,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
</script>

<script setup lang="ts">
import { IonItem, IonSelect, IonSelectOption } from "@ionic/vue"
import { TOP_FIELD_KEYS, type TrackMetaTopKey } from "@ui/components/tracks/list/index.js"

const value = defineModel<TrackMetaTopKey | null>({ required: true })
</script>

<template>
  <IonItem>
    <IonSelect v-model="value" :label="$t('settings.trackInfo.topField')" interface="popover">
      <IonSelectOption :value="null">{{ $t("settings.trackInfo.none") }}</IonSelectOption>
      <IonSelectOption v-for="key in TOP_FIELD_KEYS" :key="key" :value="key">
        {{ $t(`settings.trackInfo.fields.${key}`) }}
      </IonSelectOption>
    </IonSelect>
  </IonItem>
</template>

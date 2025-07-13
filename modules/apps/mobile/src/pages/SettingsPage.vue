<template>
  <Page>
    <!-- Account -->
    <IonListHeader>
      <IonLabel>{{ $t('settings.groups.auth') }}</IonLabel>
    </IonListHeader>
    <SignInSettingsItem 
      :name="config.userName.value"
      :email="config.userEmail.value"
      :avatar-url="config.userAvatarUrl.value"
      :synced-at="syncDataStore.lastSyncedAt"
    />
    <SubscriptionSettingsItem />

    <!-- App Appearance -->
    <IonListHeader>
      <IonLabel>{{ $t('settings.groups.appearance') }}</IonLabel>
    </IonListHeader>
    <AppLanguageSettingsItem
      :items="tracksSearchFilters.languages"
    />
    <ShowPlayerProgressSettingsItem />
    <ShowNotesTabSettingsItem />
    <HighlightCurrentSentenceSettingsItem />
    <OpenTranscriptAutomaticallySettingsItem />

    <!-- Social -->
    <IonListHeader>
      <IonLabel>{{ $t('settings.groups.misc') }}</IonLabel>
    </IonListHeader>
    <SocialNetworksSettingsItem />
  </Page>
</template>

<script setup lang="ts">
import { IonListHeader, IonLabel } from '@ionic/vue'
import { Page } from '@blocks/app.core'
import { SubscriptionSettingsItem } from '@blocks/app.purchases'
import { AppLanguageSettingsItem } from '@blocks/app.localization'
import { ShowPlayerProgressSettingsItem } from '@blocks/app.player.progress'
import { ShowNotesTabSettingsItem } from '@blocks/app.notes'
import { HighlightCurrentSentenceSettingsItem, OpenTranscriptAutomaticallySettingsItem } from '@blocks/app.transcript'
import { SignInSettingsItem } from '@blocks/app.auth'
import { SocialNetworksSettingsItem } from '@blocks/app.settings.contacts'
import { useConfig } from '@blocks/app.config'
import { useSyncDataStore } from '@blocks/app.sync.data'
import { useSearchFiltersDictionaryStore } from '@blocks/app.tracks.search.filters'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
const syncDataStore = useSyncDataStore()
const tracksSearchFilters = useSearchFiltersDictionaryStore()
</script>

<template>
  <ion-page>
    <ion-content :fullscreen="true">
      <SectionHeader title="Up Next" />
      <ion-list lines="none">
        <PlaylistItem 
          v-for="item in upNext"
          :key="item.trackId"
          :track-id="item.trackId"
          :title="item.title"
          :author="item.author"
          :location="item.location"
          :references="item.references"
          :status="item.status"
          :date="item.date"
        />
      </ion-list>

      <TrackSuggestionsSection />
    </ion-content>
  </ion-page>
</template>

<script setup lang="ts">
import { IonPage, IonContent, IonList } from '@ionic/vue';
import { PlaylistItem, SectionHeader, TrackSuggestionsSection } from '@/home';


const upNext = [
  {
    trackId: '1',
    title: 'Krishna is Supreme Personality of Godhead',
    author: 'ACBPS',
    location: 'India',
    references: ['BG 1.1', 'BG 1.2'],
    status: 'playing',
    date: '2023-10-01'
  },
  {
    trackId: '2',
    title: 'The Science of Self-Realization',
    author: 'ACBPS',
    location: 'USA',
    references: ['SSR 2.1', 'SSR 2.2'],
    status: 'loading',
    date: '2023-09-15'
  },
  {
    trackId: '3',
    title: 'Bhagavad Gita As It Is',
    author: 'ACBPS',
    location: 'India',
    references: ['BG 2.1', 'BG 2.2'],
    status: 'loading',
    date: '2023-08-20'
  },
  {
    trackId: '4',
    title: 'Teachings of Lord Chaitanya',
    author: 'ACBPS',
    location: 'India',
    references: ['TLC 1.1', 'TLC 1.2'],
    status: 'none',
    date: '2023-07-10'
  },
]
</script>

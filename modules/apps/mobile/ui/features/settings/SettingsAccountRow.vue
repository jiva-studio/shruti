<script setup lang="ts">
import { computed, ref } from "vue"
import { SettingsAccountItem } from "@kit/ui"
import { IconUserFilled, IconUserPlus } from "@tabler/icons-vue"
import { IconChip } from "@ui/primitives/index.js"
import { accountInitials } from "./accountInitials.js"

const props = defineProps<{
  anonymous: boolean
  email: string | null
  name: string | null
  picture: string | null
  disabled: boolean
}>()

const emit = defineEmits<{ activate: [] }>()

const pictureFailed = ref(false)

// Without any of the three, the row collapses to the friendly no-data branch:
// the RU region stores none of them by design, and so does any provider that
// declined to surface a profile.
const hasPersonalData = computed(
  () => !!(props.name?.trim() || props.email?.trim() || props.picture)
)

const initials = computed(() => accountInitials(props.name, props.email))
</script>

<template>
  <SettingsAccountItem :disabled="disabled" @activate="emit('activate')">
    <template #avatar>
      <IconChip v-if="anonymous">
        <IconUserPlus />
      </IconChip>
      <IconChip v-else-if="!hasPersonalData">
        <IconUserFilled />
      </IconChip>
      <!-- Signed-in avatar shares the square-rounded chip shape with every
           other Settings row. -->
      <div v-else class="account-avatar settings-item-icon">
        <img
          v-if="picture && !pictureFailed"
          :src="picture"
          alt=""
          referrerpolicy="no-referrer"
          class="account-avatar__img"
          @error="pictureFailed = true"
        />
        <span v-else class="account-avatar__initials">{{ initials }}</span>
      </div>
    </template>
    <template #title>
      <h2 v-if="anonymous">{{ $t("settings.account.signInCta.title") }}</h2>
      <h2 v-else-if="!hasPersonalData">{{ $t("settings.account.signedIn") }}</h2>
      <h2 v-else>{{ name || email }}</h2>
    </template>
    <template #subtitle>
      <p v-if="anonymous">{{ $t("settings.account.signInCta.description") }}</p>
      <p v-else-if="!hasPersonalData">{{ $t("settings.account.signedInNoDataSubtitle") }}</p>
      <p v-else>{{ $t("settings.account.signedIn") }}</p>
    </template>
  </SettingsAccountItem>
</template>

<style scoped>
/* Matches the neighbouring chips: they render a 24px icon inside 6px padding,
   so the portrait fills the same 36×36 square edge-to-edge. */
.account-avatar {
  width: 36px;
  height: 36px;
  padding: 0;
  overflow: hidden;
}
.account-avatar__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.account-avatar__initials {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 13px;
  font-weight: 600;
  color: var(--ion-color-medium);
}
</style>

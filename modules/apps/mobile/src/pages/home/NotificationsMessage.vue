<template>
  <div>
    <Message 
      @click="notificationTimePickerDialogOpen = true"
      @close="onCloseEnableNotificationsPlate"
    >
      {{ $t("notifications.enableDailyNotifications") }}
    </Message>
    <TimePickerDialog 
      :open="notificationTimePickerDialogOpen" 
      @select="onNotificationsEnabled"
    />
  </div>
</template>


<script setup lang="ts">
import { ref } from 'vue'
import { TimePickerDialog } from '@blocks/app.notifications'
import { useEventBus } from '@lectorium/mobile/core'
import { Message } from '@blocks/app.ui.kit'
import { useConfig } from '@blocks/app.config'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
const eventBus = useEventBus()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const notificationTimePickerDialogOpen = ref(false)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onCloseEnableNotificationsPlate() {
  config.notificationsEnabled.value = false
}

function onNotificationsEnabled(hours: number, minutes: number) {
  config.notificationsEnabled.value = true
  config.notificationsTime.value = [hours, minutes]
  eventBus.notificationsSchedule.notify({ time: [hours, minutes] })
}
</script>

<script setup lang="ts">
import { computed, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  IonModal,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonContent,
  IonInput,
  IonSpinner,
} from "@ionic/vue"
import { Header } from "@ui/primitives/index.js"
import { useEmailSignInForm } from "@lectorium/composables/useEmailSignInForm.js"

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ "update:open": [open: boolean] }>()

const { t } = useI18n()

function close(): void {
  emit("update:open", false)
}

const form = useEmailSignInForm(close)
const { step, email, code, busy, resendIn } = form
const error = computed(() => (form.errorKey.value ? t(form.errorKey.value) : ""))

// Fresh form every time the modal opens.
watch(
  () => props.open,
  (open) => (open ? form.reset() : form.stop())
)
</script>

<template>
  <IonModal :is-open="open" keep-contents-mounted class="email-signin-modal" @did-dismiss="close">
    <Header class="flat-header">
      <IonToolbar>
        <IonTitle>{{ $t("settings.account.email.title") }}</IonTitle>
        <IonButtons slot="end">
          <IonButton @click="close">{{ $t("app.cancel") }}</IonButton>
        </IonButtons>
      </IonToolbar>
    </Header>

    <IonContent class="ion-padding">
      <!-- Step 1: email -->
      <template v-if="step === 'email'">
        <p class="lead">{{ $t("settings.account.email.emailStep") }}</p>
        <IonInput
          v-model="email"
          type="email"
          inputmode="email"
          autocomplete="email"
          fill="outline"
          :label="$t('settings.account.email.emailLabel')"
          label-placement="stacked"
          :placeholder="$t('settings.account.email.emailPlaceholder')"
          :disabled="busy"
          @keyup.enter="form.sendCode"
        />
        <p v-if="error" class="error">{{ error }}</p>
        <IonButton
          expand="block"
          class="ion-margin-top submit-btn"
          style="--box-shadow: none"
          :disabled="busy || !email.trim()"
          @click="form.sendCode"
        >
          <!-- Label stays in flow (just hidden) so the button keeps its text
               height while the spinner overlays centered — no height jump. -->
          <span :class="{ 'label-hidden': busy }">{{ $t("settings.account.email.sendCode") }}</span>
          <IonSpinner v-if="busy" name="crescent" class="submit-spinner" />
        </IonButton>
      </template>

      <!-- Step 2: code -->
      <template v-else>
        <p class="lead">{{ $t("settings.account.email.codeStep", { email }) }}</p>
        <IonInput
          v-model="code"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          :maxlength="6"
          fill="outline"
          :label="$t('settings.account.email.codeLabel')"
          label-placement="stacked"
          :placeholder="$t('settings.account.email.codePlaceholder')"
          :disabled="busy"
          @keyup.enter="form.verify"
        />
        <p v-if="error" class="error">{{ error }}</p>
        <IonButton
          expand="block"
          class="ion-margin-top submit-btn"
          style="--box-shadow: none"
          :disabled="busy || code.trim().length < 6"
          @click="form.verify"
        >
          <span :class="{ 'label-hidden': busy }">{{ $t("settings.account.email.verify") }}</span>
          <IonSpinner v-if="busy" name="crescent" class="submit-spinner" />
        </IonButton>

        <div class="actions">
          <IonButton fill="clear" size="small" :disabled="busy" @click="form.backToEmail">
            {{ $t("settings.account.email.changeEmail") }}
          </IonButton>
          <IonButton
            fill="clear"
            size="small"
            :disabled="busy || resendIn > 0"
            @click="form.resend"
          >
            {{
              resendIn > 0
                ? $t("settings.account.email.resendIn", { seconds: resendIn })
                : $t("settings.account.email.resend")
            }}
          </IonButton>
        </div>
      </template>
    </IonContent>
  </IonModal>
</template>

<style scoped>
/* ion-button keeps a default 2px host margin-inline even with expand="block"
   (that flag only zeros the inner .button-native), so the block button renders
   4px narrower than the full-width outline IonInput above it. Zero the inline
   margin so the submit button matches the field width exactly. Vertical margin
   (.ion-margin-top) is untouched. */
ion-button[expand="block"] {
  margin-inline: 0;
}

/* Busy state must not resize the submit button. The label stays in flow
   (hidden) to hold the button's text height, and the spinner is overlaid
   dead-center over it. ::part(native) is `position: relative` in Ionic, so
   the absolutely-positioned spinner centers within the button. */
.submit-btn .label-hidden {
  visibility: hidden;
}
.submit-btn .submit-spinner {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 1.25rem;
  height: 1.25rem;
}

.lead {
  margin: 0 0 16px;
  color: var(--ion-color-medium);
}
.error {
  margin: 12px 4px 0;
  color: var(--ion-color-danger);
  font-size: 0.85rem;
}
.actions {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
}
</style>

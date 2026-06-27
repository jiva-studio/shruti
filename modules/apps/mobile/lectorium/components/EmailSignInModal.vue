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
          @keyup.enter="onSendCode"
        />
        <p v-if="error" class="error">{{ error }}</p>
        <IonButton
          expand="block"
          class="ion-margin-top"
          style="--box-shadow: none"
          :disabled="busy || !email.trim()"
          @click="onSendCode"
        >
          <IonSpinner v-if="busy" name="crescent" />
          <span v-else>{{ $t("settings.account.email.sendCode") }}</span>
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
          @keyup.enter="onVerify"
        />
        <p v-if="error" class="error">{{ error }}</p>
        <IonButton
          expand="block"
          class="ion-margin-top"
          style="--box-shadow: none"
          :disabled="busy || code.trim().length < 6"
          @click="onVerify"
        >
          <IonSpinner v-if="busy" name="crescent" />
          <span v-else>{{ $t("settings.account.email.verify") }}</span>
        </IonButton>

        <div class="actions">
          <IonButton fill="clear" size="small" :disabled="busy" @click="backToEmail">
            {{ $t("settings.account.email.changeEmail") }}
          </IonButton>
          <IonButton fill="clear" size="small" :disabled="busy || resendIn > 0" @click="onResend">
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

<script setup lang="ts">
import { ref, watch, onUnmounted } from "vue"
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
import { useAuthStore } from "@lectorium/stores/useAuthStore.js"
import { EmailOtpError } from "@ports/app/auth.js"

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ "update:open": [open: boolean] }>()

const { t } = useI18n()
const auth = useAuthStore()

const RESEND_COOLDOWN_S = 60

const step = ref<"email" | "code">("email")
const email = ref("")
const code = ref("")
const busy = ref(false)
const error = ref("")
const resendIn = ref(0)
let resendTimer: ReturnType<typeof setInterval> | undefined
// Bumped on every reset (open). The modal is mounted once at the app root and
// never unmounts, so an in-flight request from a previous open could resolve
// after the form was reset and stomp the fresh state; handlers capture the
// epoch and bail if it changed.
let formGen = 0

function clearResendTimer(): void {
  if (resendTimer) {
    clearInterval(resendTimer)
    resendTimer = undefined
  }
}

function startResendCooldown(seconds = RESEND_COOLDOWN_S): void {
  resendIn.value = seconds
  clearResendTimer()
  resendTimer = setInterval(() => {
    resendIn.value -= 1
    if (resendIn.value <= 0) clearResendTimer()
  }, 1000)
}

function reset(): void {
  formGen++
  step.value = "email"
  email.value = ""
  code.value = ""
  error.value = ""
  busy.value = false
  resendIn.value = 0
  clearResendTimer()
}

// Fresh form every time the modal opens.
watch(
  () => props.open,
  (open) => {
    if (open) reset()
    else clearResendTimer()
  }
)

function messageFor(e: unknown): string {
  if (e instanceof EmailOtpError) {
    switch (e.kind) {
      case "invalid-email":
        return t("settings.account.email.errors.invalidEmail")
      case "invalid-code":
        return t("settings.account.email.errors.invalidCode")
      case "throttled":
        return t("settings.account.email.errors.throttled")
      case "disabled":
        return t("settings.account.email.errors.disabled")
      case "network":
        return t("settings.account.email.errors.network")
      default:
        return t("settings.account.email.errors.generic")
    }
  }
  return t("settings.account.email.errors.generic")
}

async function onSendCode(): Promise<void> {
  if (busy.value || !email.value.trim()) return
  const g = formGen
  busy.value = true
  error.value = ""
  try {
    await auth.requestEmailCode(email.value.trim())
    if (g !== formGen) return // modal was reset/reopened mid-request
    step.value = "code"
    startResendCooldown()
  } catch (e) {
    if (g !== formGen) return
    error.value = messageFor(e)
  } finally {
    if (g === formGen) busy.value = false
  }
}

async function onResend(): Promise<void> {
  if (busy.value || resendIn.value > 0) return
  const g = formGen
  busy.value = true
  error.value = ""
  try {
    await auth.requestEmailCode(email.value.trim())
    if (g !== formGen) return
    startResendCooldown()
  } catch (e) {
    if (g !== formGen) return
    error.value = messageFor(e)
  } finally {
    if (g === formGen) busy.value = false
  }
}

async function onVerify(): Promise<void> {
  if (busy.value || code.value.trim().length < 6) return
  const g = formGen
  busy.value = true
  error.value = ""
  try {
    const ok = await auth.signInEmail(email.value.trim(), code.value.trim())
    if (g !== formGen) return
    if (ok) close()
  } catch (e) {
    if (g !== formGen) return
    error.value = messageFor(e)
  } finally {
    if (g === formGen) busy.value = false
  }
}

function backToEmail(): void {
  step.value = "email"
  code.value = ""
  error.value = ""
}

function close(): void {
  emit("update:open", false)
}

onUnmounted(clearResendTimer)
</script>

<style scoped>
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

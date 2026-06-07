<template>
  <IonModal
    :is-open="open"
    :initial-breakpoint="0.55"
    :breakpoints="[0, 0.55, 0.9]"
    class="feedback-sheet"
    @did-dismiss="onCancel"
  >
    <IonContent class="ion-padding">
      <h2 class="title">{{ t("chat.feedback.sheet.title") }}</h2>
      <p class="hint">{{ t("chat.feedback.sheet.hint") }}</p>

      <IonItem class="category-item" lines="full">
        <IonSelect
          v-model="category"
          :placeholder="t('chat.feedback.sheet.categoryPlaceholder')"
          :label="t('chat.feedback.sheet.categoryLabel')"
          label-placement="stacked"
          interface="action-sheet"
        >
          <IonSelectOption v-for="opt in CATEGORY_OPTIONS" :key="opt" :value="opt">
            {{ t(`chat.feedback.categories.${opt}`) }}
          </IonSelectOption>
        </IonSelect>
      </IonItem>

      <IonItem class="comment-item" lines="full">
        <IonTextarea
          v-model="comment"
          :label="t('chat.feedback.sheet.commentLabel')"
          label-placement="stacked"
          :placeholder="t('chat.feedback.sheet.commentPlaceholder')"
          :counter="true"
          :maxlength="500"
          :auto-grow="true"
          :rows="3"
        />
      </IonItem>

      <div class="actions">
        <IonButton fill="clear" @click="onCancel">
          {{ t("app.cancel") }}
        </IonButton>
        <IonButton :disabled="submitting" @click="onSubmit">
          {{ t("chat.feedback.sheet.submit") }}
        </IonButton>
      </div>
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  IonButton,
  IonContent,
  IonItem,
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTextarea,
} from "@ionic/vue"
import type { FeedbackCategory } from "@lib/contracts"

/** Categories surfaced in the sheet. Wire format mirrors the server's
 *  `FeedbackCategory` enum; i18n keys at `chat.feedback.categories.<value>`
 *  carry the user-visible labels. Keep this list in sync with the
 *  Pydantic enum on the backend. */
const CATEGORY_OPTIONS: readonly FeedbackCategory[] = [
  "off_topic",
  "no_results",
  "bad_citations",
  "wrong_language",
  "factually_wrong",
  "other",
]

const props = defineProps<{
  open: boolean
  submitting?: boolean
}>()

const emit = defineEmits<{
  /** User tapped Submit. Either field may be empty — the parent
   *  decides what to send. */
  submit: [args: { category?: FeedbackCategory; comment?: string }]
  /** Either explicit Cancel or backdrop dismiss. State is NOT reset
   *  here so re-opening shows what the user previously typed. */
  cancel: []
}>()

const { t } = useI18n()

const category = ref<FeedbackCategory | undefined>(undefined)
const comment = ref<string>("")

// Reset the form whenever the sheet is freshly opened so a previous
// session's entries don't ghost the next one.
watch(
  () => props.open,
  (next, prev) => {
    if (next && !prev) {
      category.value = undefined
      comment.value = ""
    }
  }
)

function onSubmit(): void {
  emit("submit", {
    category: category.value,
    comment: comment.value.trim() || undefined,
  })
}

function onCancel(): void {
  emit("cancel")
}
</script>

<style scoped>
.feedback-sheet {
  --height: auto;
}

.title {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
}

.hint {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--ion-color-medium, #777);
}

.category-item,
.comment-item {
  --background: transparent;
  --padding-start: 0;
  --inner-padding-end: 0;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 12px;
}
</style>

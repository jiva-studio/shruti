<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { ChatSession } from "@lectorium/stores/useChatStore.js"

const props = withDefaults(
  defineProps<{
    sessions: readonly ChatSession[]
    /** Session ids that received an agent-initiated message and haven't
     *  been opened yet — driven by `chatStore.unseenProactiveSessionIds`.
     *  The session row shows a small dot before the title so the user can see
     *  which one is the new proactive nudge without opening every entry. */
    unreadIds?: ReadonlySet<string>
    limit?: number
  }>(),
  { limit: 4 }
)

defineEmits<{ (e: "pick", sessionId: string): void }>()

const { t } = useI18n()

const visible = computed(() => props.sessions.slice(0, props.limit))

/**
 * Compact "5м / 2ч / вчера / 3д / 1нед" form — `Intl.RelativeTimeFormat`
 * even with `style: "narrow"` still produces "5 м назад" / "5m ago"
 * (~9 chars), which crowds the title against the timestamp column on
 * a 360dp phone. Unit suffixes are sourced from i18n keys so new
 * locales drop in via the chat.timeUnit* set instead of editing this
 * file.
 */
function relativeTime(epochMs: number): string {
  const abs = Math.max(0, Math.round((Date.now() - epochMs) / 1000))
  const min = Math.round(abs / 60)
  const hr = Math.round(abs / 3600)
  const day = Math.round(abs / 86_400)
  const wk = Math.round(abs / 604_800)
  const mo = Math.round(abs / 2_592_000)
  const yr = Math.round(abs / 31_536_000)
  if (abs < 60) return t("chat.timeJustNow")
  if (min < 60) return `${min}${t("chat.timeUnitMinute")}`
  if (hr < 24) return `${hr}${t("chat.timeUnitHour")}`
  if (day === 1) return t("chat.timeYesterday")
  if (day < 7) return `${day}${t("chat.timeUnitDay")}`
  if (wk < 5) return `${wk}${t("chat.timeUnitWeek")}`
  if (mo < 12) return `${mo}${t("chat.timeUnitMonth")}`
  return `${yr}${t("chat.timeUnitYear")}`
}
</script>

<template>
  <div v-if="visible.length" class="recents">
    <div class="recents-label">{{ $t("chat.recentSessionsLabel") }}</div>
    <button
      v-for="s in visible"
      :key="s.id"
      type="button"
      class="recent"
      @click="$emit('pick', s.id)"
    >
      <span class="title">
        <span v-if="unreadIds?.has(s.id)" class="unread-dot" aria-hidden="true" />
        {{ s.title || $t("chat.untitledSession") }}
      </span>
      <span class="when">{{ relativeTime(s.updatedAt) }}</span>
    </button>
  </div>
</template>

<style scoped>
.recents {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  max-width: 420px;
  margin-top: 28px;
  padding: 0 16px;
}

.recents-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.5;
  padding: 0 4px 6px;
}

.recent {
  appearance: none;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 6px 10px;
  background: rgba(var(--ion-color-primary-rgb), 0.05);
  border: 0;
  border-radius: 8px;
  color: var(--ion-text-color);
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background 120ms ease;
}

.recent:active {
  background: rgba(var(--ion-color-primary-rgb), 0.13);
}

.title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.unread-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ion-color-primary, #3880ff);
}

.when {
  flex: 0 0 auto;
  font-size: 11px;
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
}
</style>

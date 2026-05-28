<template>
  <ChatFocusCard
    v-if="message.focus"
    :data-message-id="message.id"
    :message-id="message.id"
    :focus="message.focus"
    :suggestions="focusSuggestions"
    :suggestions-loading="focusLoading"
    @send-suggestion="$emit('send-suggestion', $event)"
  />
  <div v-else :class="['bubble-row', message.role]" :data-message-id="message.id">
    <div :class="['bubble', message.role, { streaming: message.streaming }]">
      <template v-if="message.role === 'user'">
        <span class="user-text">{{ message.content }}</span>
      </template>
      <template v-else-if="failedKind">
        <InlineNotice
          :kind="noticeKind"
          :title="noticeTitle || undefined"
          :body="noticeBody"
          :cta="noticeCta"
        />
      </template>
      <template v-else>
        <StatusPill
          v-if="message.streaming && message.content.length === 0"
          :status-key="message.statusKey"
          :params="message.statusParams"
          :research-questions="message.researchQuestions"
          :research-sources="message.researchSources"
        />
        <template v-else>
          <template v-for="(token, idx) in tokens" :key="idx">
            <!--
              v-html XSS note: `token.html` is the output of marked.parseInline
              run on `message.content` inside `chatMarkers.parseChatMarkers`.
              `marked` HTML-escapes raw text by default (it doesn't run an
              HTML sanitizer, but it never passes through arbitrary tags from
              source unless explicitly enabled). The content itself comes from
              the LLM (assistant role) — not user-typed — and the chat agent
              prompt forbids emitting raw HTML. If we ever start letting users
              author markdown that flows through this same code path, swap
              `marked.parseInline` for a DOMPurify pass first.
            -->
            <span v-if="token.kind === 'text'" v-html="token.html" />
            <CitationChip
              v-else-if="token.kind === 'cite'"
              :track-id="token.trackId"
              :start-ms="token.startMs"
              :end-ms="token.endMs"
              :caption="token.caption"
            />
            <TrackList v-else-if="token.kind === 'cards'" :track-ids="token.trackIds" />
            <OutlineCard
              v-else-if="token.kind === 'outline'"
              :track-id="token.trackId"
              :items="message.outlines?.[token.trackId]?.items ?? []"
              @pick-chapter="$emit('pick-chapter', $event)"
            />
            <ActionCardSharePdf
              v-else-if="token.kind === 'action' && token.actionKind === 'share_pdf'"
              :action-id="token.actionId"
              :payload="sharePdfPayload(token.actionId)"
              :state="actionState(token.actionId)"
              @confirm="onConfirmAction"
            />
            <ActionCardEnableReminder
              v-else-if="token.kind === 'action' && token.actionKind === 'enable_daily_reminder'"
              :action-id="token.actionId"
              :payload="enableReminderPayload(token.actionId)"
              :state="actionState(token.actionId)"
              @confirm="onConfirmAction"
            />
            <ActionCardConfigureSmartLibrary
              v-else-if="token.kind === 'action' && token.actionKind === 'configure_smart_library'"
              :action-id="token.actionId"
              :payload="configureSmartLibraryPayload(token.actionId)"
              :state="actionState(token.actionId)"
              @confirm="onConfirmAction"
            />
            <ActionCardUpgradeToPro
              v-else-if="token.kind === 'action' && token.actionKind === 'upgrade_to_pro'"
              :action-id="token.actionId"
              :payload="upgradeToProPayload(token.actionId)"
              :state="actionState(token.actionId)"
              @confirm="onConfirmAction"
            />
            <ActionCardQueueNextTrack
              v-else-if="token.kind === 'action' && token.actionKind === 'queue_next_track'"
              :action-id="token.actionId"
              :payload="queueNextTrackPayload(token.actionId)"
              :state="actionState(token.actionId)"
              @confirm="onConfirmAction"
            />
            <VerseCard
              v-else-if="token.kind === 'verse'"
              :source-id="token.sourceId"
              :tokens="token.tokens"
              :caption="token.caption"
            />
            <!--
              Markdown blockquote (library document citation). bodyHtml and
              attributionHtml are output of marked.parseInline on a vetted
              text snippet, same v-html note as for token.kind === 'text'.
            -->
            <blockquote v-else-if="token.kind === 'quote'" class="chat-quote">
              <span v-html="token.bodyHtml" />
              <span
                v-if="token.attributionHtml"
                class="chat-quote-attribution"
                v-html="token.attributionHtml"
              />
            </blockquote>
          </template>
          <span v-if="errorSuffix && !message.streaming" class="truncated-suffix">{{
            errorSuffix
          }}</span>
        </template>
      </template>
    </div>
    <ChatMessageActions
      v-if="showActions"
      :markdown="exportMarkdown"
      :retry-visible="truncatedRetryVisible"
      :retry-disabled="!canRetry"
      :message-id="message.id"
      :feedback-state="message.feedbackState"
      @retry="onRetry"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import router from "@shruti/router/index.js"
import { messageToMarkdown, parseChatMarkers } from "@shruti/composables/chatMarkers.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useAuthStore } from "@shruti/stores/useAuthStore.js"
import { useChatStore, type ActionState, type ChatMessage } from "@shruti/stores/useChatStore.js"
import { useVerseBodyStore } from "@shruti/stores/useVerseBodyStore.js"
import type { ChatActionPayload, QuotaTier } from "@lib/domain/chatMessage.js"
import CitationChip from "./CitationChip.vue"
import ChatMessageActions from "./ChatMessageActions.vue"
import TrackList from "./TrackList.vue"
import OutlineCard from "./OutlineCard.vue"
import VerseCard from "./VerseCard.vue"
import ActionCardSharePdf from "./ActionCardSharePdf.vue"
import ActionCardEnableReminder from "./ActionCardEnableReminder.vue"
import ActionCardConfigureSmartLibrary from "./ActionCardConfigureSmartLibrary.vue"
import ActionCardUpgradeToPro from "./ActionCardUpgradeToPro.vue"
import ActionCardQueueNextTrack from "./ActionCardQueueNextTrack.vue"
import StatusPill from "./StatusPill.vue"
import InlineNotice from "@ui/shared/InlineNotice.vue"
import { useAnonymousSignInFlow } from "@shruti/composables/useAnonymousSignInFlow.js"
import { usePaywallStore } from "@shruti/stores/usePaywallStore.js"
import ChatFocusCard from "./ChatFocusCard.vue"

const props = withDefaults(
  defineProps<{
    message: ChatMessage
    /** Whether this bubble is the last item in the conversation. Only
     *  the trailing failed/truncated message gets a Retry button —
     *  earlier ones are frozen history. */
    isLast?: boolean
    /** Persisted Ask-Sadhu chips for this focus message (lives on
     *  `meta.followups`). `null` means "fetch hasn't resolved yet" —
     *  the card falls back to the static i18n list in that case so
     *  the affordance is always visible. */
    focusSuggestions?: readonly string[] | null
    /** True while the focus message's `/questions` round-trip is in
     *  flight — card renders a loading pill instead of chips. */
    focusLoading?: boolean
  }>(),
  { isLast: false }
)
const emit = defineEmits<{
  /** Forwarded from the inline OutlineCard. The view-level controller
   *  owns prompt assembly + chat.sendMessage. */
  "pick-chapter": [
    args: {
      trackId: string
      item: { startMs: number; title: string }
      nextItem: { startMs: number; title: string } | null
    },
  ]
  /** User tapped Retry on a failed/truncated assistant bubble. */
  retry: [messageId: string]
  /** Forwarded up from ChatFocusCard's suggestion chip taps. The
   *  parent dispatches it directly to `onSend` (focus chips are
   *  fire-and-send, no input-bar detour). */
  "send-suggestion": [text: string]
}>()
const chat = useChatStore()
const verseBody = useVerseBodyStore()
const appLanguage = useAppLanguage()
// Singleton import — see NotesView.controller for the why.
const { t } = useI18n()

const tokens = computed(() => {
  if (props.message.role !== "assistant") return []
  return parseChatMarkers(props.message.content)
})

/* -------------------------------------------------------------------- */
/*  Copy / Share — plain-Markdown rendering of the assistant message     */
/* -------------------------------------------------------------------- */

const exportMarkdown = computed<string>(() => {
  if (props.message.role !== "assistant") return ""
  if (props.message.streaming) return ""
  if (props.message.error?.kind === "failed") return ""
  const lang: "ru" | "en" = appLanguage.value.startsWith("en") ? "en" : "ru"
  return messageToMarkdown(props.message.content, {
    lang,
    verseLookup: (sourceId, tokens) => verseBody.get(sourceId, tokens),
  })
})

const showActions = computed<boolean>(
  // Retry now lives in the actions row — keep the row visible whenever
  // the truncated-retry predicate fires, even if the bubble has no
  // exportable markdown yet (edge case: empty truncated stream).
  () => exportMarkdown.value.trim().length > 0 || truncatedRetryVisible.value
)

const errorSuffix = computed(() => {
  const e = props.message.error
  if (!e) return ""
  // Pattern-match on discriminator. Unknown kinds fall through to "" so
  // older clients reading newer rows don't render a confusing label.
  if (e.kind === "truncated") {
    return e.reason === "turns" ? t("chat.errTruncatedTurns") : t("chat.errTruncatedStream")
  }
  if (e.kind === "stopped") {
    return t("chat.errStopped")
  }
  return ""
})

/* -------------------------------------------------------------------- */
/*  Failure rendering: dedicated bubble for `failed` + retry button     */
/* -------------------------------------------------------------------- */

/** Tick once per second while a `rate_limited` countdown is on the
 *  screen. Used to recompute `failedText` (counts down "in N s") and
 *  `failedRetryEnabled` (flips at the deadline). */
const now = ref(Date.now())
let tickHandle: ReturnType<typeof setInterval> | null = null

function stopTick(): void {
  if (tickHandle !== null) {
    clearInterval(tickHandle)
    tickHandle = null
  }
}

// Drive the tick off `error.retryAfterAt`. Watching (not onMounted) so
// a bubble that transitions from streaming → failed AFTER mount — e.g.
// the in-flight placeholder converted to a `rate_limited` failure by
// `applyTurnEvent('error')` in the store — still gets a live countdown.
watch(
  () => {
    const e = props.message.error
    return e?.kind === "failed" && typeof e.retryAfterAt === "number" ? e.retryAfterAt : null
  },
  (retryAfterAt) => {
    stopTick()
    if (retryAfterAt === null) return
    now.value = Date.now()
    tickHandle = setInterval(() => {
      now.value = Date.now()
      // Stop ticking once the deadline passes — the button becomes
      // enabled and the wording stops referring to time.
      if (now.value >= retryAfterAt) stopTick()
    }, 1000)
  },
  { immediate: true }
)

onBeforeUnmount(stopTick)

/* -------------------------------------------------------------------- */
/*  Offline vs server-error differentiation (Plan 3.7)                  */
/* -------------------------------------------------------------------- */

/** Cached `navigator.onLine`. Kept reactive so the bubble can flip from
 *  the "No internet — will retry when you're back online" copy to a
 *  manual-retry state as soon as the OS reports the connection is
 *  back. We don't import a shared composable for this — only this
 *  bubble cares, and adding a singleton just for one consumer is more
 *  code than the watcher pair below. */
const isOffline = ref<boolean>(typeof navigator !== "undefined" && navigator.onLine === false)

function onOnline(): void {
  isOffline.value = false
  // Auto-retry exactly when:
  //   - this is the last bubble (earlier failures are frozen history),
  //   - the failure was diagnosed as `network` (we infer offline from
  //     the same code path),
  //   - the chat store is idle (no in-flight turn from another path).
  // Anything else we leave for the user to drive — auto-retrying a
  // 401 or rate_limited on reconnect would surprise them.
  if (!props.isLast) return
  const e = props.message.error
  if (!e || e.kind !== "failed") return
  if (e.code !== "network") return
  if (!canRetry.value) return
  emit("retry", props.message.id)
}

function onOffline(): void {
  isOffline.value = true
}

onMounted(() => {
  if (typeof window === "undefined") return
  window.addEventListener("online", onOnline)
  window.addEventListener("offline", onOffline)
})

onBeforeUnmount(() => {
  if (typeof window === "undefined") return
  window.removeEventListener("online", onOnline)
  window.removeEventListener("offline", onOffline)
})

/** True iff THIS bubble's failure should render as the offline variant.
 *  We can't tell offline-at-send from server-unreachable purely from the
 *  error code — the network layer reports both as `"network"` — so we
 *  combine the code with the current `navigator.onLine` state at render
 *  time. If the device is online but the server is down, we fall
 *  through to the http_5xx-style copy below. */
const isOfflineFailure = computed<boolean>(() => {
  const e = props.message.error
  if (!e || e.kind !== "failed") return false
  if (e.code !== "network") return false
  return isOffline.value
})

const failedKind = computed<boolean>(() => {
  const e = props.message.error
  return !!(e && e.kind === "failed" && !props.message.streaming)
})

/** Codes where Retry would not help (auth needs restart, protocol
 *  mismatch needs an update). We still show the message — just no
 *  button under it. */
const failedRetryAllowed = computed<boolean>(() => {
  const e = props.message.error
  if (!e || e.kind !== "failed") return false
  return e.code !== "http_401" && e.code !== "http_403" && e.code !== "protocol_version_required"
})

const failedRetryEnabled = computed<boolean>(() => {
  const e = props.message.error
  if (!e || e.kind !== "failed") return false
  if (typeof e.retryAfterAt === "number") return now.value >= e.retryAfterAt
  return true
})

const truncatedRetryVisible = computed<boolean>(() => {
  const e = props.message.error
  return !!(e && e.kind === "truncated" && !props.message.streaming && props.isLast)
})

/** True iff the store is idle and this bubble is the last one. Earlier
 *  failed bubbles in scrolled-back history stay decorative. */
const canRetry = computed<boolean>(() => props.isLast && !chat.sending)

const failedText = computed<string>(() => {
  const e = props.message.error
  if (!e || e.kind !== "failed") return ""
  if (e.code === "rate_limited") {
    if (typeof e.retryAfterAt === "number") {
      const remainingMs = e.retryAfterAt - now.value
      if (remainingMs > 0) {
        return t("chat.errRateAfter", { when: formatRetryWhen(remainingMs, e.retryAfterAt) })
      }
    }
    return t("chat.errRate")
  }
  if (e.code === "max_turns_exceeded") return t("chat.errMaxTurns")
  if (e.code === "agent_error") return t("chat.errAgent")
  if (e.code === "http_401" || e.code === "http_403") return t("chat.errAuth")
  if (e.code === "protocol_version_required") return t("chat.errProtocol")
  if (e.code.startsWith("http_5")) return t("chat.errServiceNotReady")
  if (e.code === "network") return t("chat.errNetwork")
  if (e.code === "stream") return t("chat.errStreamDropped")
  return t("chat.errUnknown")
})

const failedRetryLabel = computed<string>(() => t("chat.actionRetry"))

/* -------------------------------------------------------------------------- */
/*                        InlineNotice (quota + errors)                       */
/* -------------------------------------------------------------------------- */

const paywall = usePaywallStore()
const auth = useAuthStore()
const { triggerSignIn } = useAnonymousSignInFlow()

const failedError = computed(() => {
  const e = props.message.error
  return e && e.kind === "failed" ? e : null
})

/** Tier we render copy against. Defaults to the server's echo in the
 *  429 body, but overrides `"free"` → `"pro"` when the local JWT
 *  already knows the user is Pro. The server can transiently echo
 *  `free` after a Pro purchase: its 429 is computed from the JWT's
 *  `tier_expires_at` claim, which lags webhook landings until the next
 *  token rotation (~15 min) — and Apple/Google receipt webhooks
 *  occasionally drop, leaving the claim stale longer than that. Issue
 *  #718: showing "buy Pro" copy to an actual Pro user. The
 *  `anonymous` echo is intentionally NOT overridden — that means the
 *  request itself ran under an anonymous token (signin flip mid-
 *  request, separate device), and the "sign in to use your Pro quota"
 *  CTA is the right path home. */
const effectiveQuotaTier = computed<QuotaTier | undefined>(() => {
  const tier = failedError.value?.tier
  if (auth.isPro && tier === "free") return "pro"
  return tier
})

/** Set of recognised quota tiers — keep in sync with the `QuotaTier`
 *  union in `@lib/domain/chatMessage`. Used so a server tier we don't
 *  know about (`enterprise`, future addition, schema drift) drops into
 *  the unknown-tier fallback below instead of rendering as an empty
 *  title + generic body. */
const KNOWN_TIERS = new Set(["anonymous", "free", "pro"])

/** True iff the server returned `rate_limited` with a tier value this
 *  client release doesn't recognise (Plan 3.12). Renders as a neutral
 *  warning notice so the user gets a usable explanation rather than the
 *  cosmetic half-state of empty title + raw error body. */
const isUnknownQuotaTier = computed<boolean>(() => {
  const e = failedError.value
  if (!e || e.code !== "rate_limited") return false
  if (typeof e.tier !== "string") return false
  return !KNOWN_TIERS.has(e.tier)
})

// Side-effecting watcher: log once per bubble when we hit the
// unknown-tier path. Useful in dev / via remote logging so we notice
// schema drift instead of silently swallowing it.
watch(
  isUnknownQuotaTier,
  (unknown) => {
    if (!unknown) return
    const tier = failedError.value?.tier

    console.warn("[InlineNotice] unknown tier:", tier)
  },
  { immediate: true }
)

/** Quota errors render as an upsell card; offline gets the neutral info
 *  tint; everything else is a plain red-tinted error. Pro-at-cap is a
 *  warning — nothing for them to do but wait, no CTA. Unknown-tier is
 *  also "warning" so it doesn't shout "error" for a state we can't
 *  fully explain. */
const noticeKind = computed<"error" | "warning" | "upsell" | "info">(() => {
  const e = failedError.value
  if (!e) return "error"
  if (isOfflineFailure.value) return "info"
  if (e.code !== "rate_limited") return "error"
  if (isUnknownQuotaTier.value) return "warning"
  if (effectiveQuotaTier.value === "pro") return "warning"
  return "upsell"
})

const noticeTitle = computed<string>(() => {
  const e = failedError.value
  if (!e) return ""
  if (isOfflineFailure.value) return t("chat.errOffline.title")
  // Server unreachable (5xx) gets its own dedicated copy now — split out
  // from the previous "errServiceNotReady" so we can iterate the
  // "warming up" wording without affecting the plain 5xx case.
  if (e.code.startsWith("http_5")) return t("chat.errServer.title")
  if (e.code !== "rate_limited") return ""
  if (isUnknownQuotaTier.value) return t("chat.errQuotaUnknownTitle")
  const tier = effectiveQuotaTier.value
  if (tier === "anonymous") return t("chat.errQuotaAnonTitle")
  if (tier === "pro") return t("chat.errQuotaProTitle")
  if (tier === "free") return t("chat.errQuotaFreeTitle")
  return ""
})

const noticeBody = computed<string>(() => {
  const e = failedError.value
  if (!e) return ""
  if (isOfflineFailure.value) return t("chat.errOffline.body")
  if (e.code.startsWith("http_5")) return t("chat.errServer.body")
  if (e.code === "rate_limited") {
    if (isUnknownQuotaTier.value) return t("chat.errQuotaUnknownBody")
    const tier = effectiveQuotaTier.value
    if (tier) {
      const when = formatResetWhen(e.retryAfterAt)
      if (tier === "anonymous") return t("chat.errQuotaAnonBody", { when })
      if (tier === "free") return t("chat.errQuotaFreeBody", { when })
      if (tier === "pro") return t("chat.errQuotaProBody", { when })
    }
  }
  // Pre-Phase-4 server, or non-quota error — fall through to the legacy
  // failedText computation so the user still gets something readable.
  return failedText.value
})

const noticeCta = computed(() => {
  const e = failedError.value
  if (!e) return undefined
  if (isOfflineFailure.value) {
    // Auto-retry on `online` is handled by the window listener above;
    // the CTA is informational ("Retry (auto)") and disabled so the
    // user can't double-tap their way into a duplicate turn while we
    // wait for the network to come back. canRetry stays in the gating
    // expression so the label flips to enabled once we're online +
    // idle, which gives the user a manual escape hatch if the OS
    // event was missed.
    return {
      label: t("chat.errOffline.cta"),
      action: onRetry,
      disabled: !canRetry.value || isOffline.value,
    }
  }
  if (e.code === "rate_limited") {
    if (isUnknownQuotaTier.value) return undefined
    const tier = effectiveQuotaTier.value
    if (tier === "anonymous") {
      return {
        label: t("chat.signInForMoreCta"),
        // Inline provider flow: iOS opens the Apple+Google sheet,
        // Android/web triggers Google directly. Same composable as the
        // Settings account row — no Settings detour.
        action: () => {
          void triggerSignIn()
        },
      }
    }
    if (tier === "free") {
      return {
        label: t("chat.upgradeToProCta"),
        action: () => paywall.requestOpen("chat"),
      }
    }
    return undefined // pro tier → no CTA, just wait
  }
  // Plain errors keep the existing Retry button, gated by the same
  // disabled-while-counting-down / canRetry logic as before.
  if (!failedRetryAllowed.value) return undefined
  return {
    label: failedRetryLabel.value,
    action: onRetry,
    disabled: !failedRetryEnabled.value || !canRetry.value,
  }
})

/** Reset-time helper for the quota body strings. Same three-bucket
 *  output as `formatRetryWhen` (seconds / minutes / time), but reads
 *  the reactive `now` so the body re-renders every second while the
 *  countdown is visible. */
function formatResetWhen(retryAfterAt: number | undefined): string {
  if (typeof retryAfterAt !== "number") return ""
  const remainingMs = retryAfterAt - now.value
  if (remainingMs <= 0) return t("chat.retryNow")
  return formatRetryWhen(remainingMs, retryAfterAt)
}

/**
 * Format a "{when}" fragment for `errRateAfter`:
 *  - <  60s → "in N s" (countdown, ticks every second)
 *  - <  1h  → "in N min" (still ticks but in coarser units)
 *  - else   → "at HH:MM" / "tomorrow at HH:MM" — no countdown (would be
 *             noisy at hours), but disambiguate against the user's local
 *             day so "at 5:00" doesn't look like 2 hours away when it's
 *             actually 14 (UTC-midnight reset for an eastern user).
 *
 * Server's `Retry-After` for our /chat endpoint is seconds-until-midnight-UTC
 * (see backend rate_limiter.py), which can easily land in the hours range
 * when the user blows through quota early in the day.
 */
function formatRetryWhen(remainingMs: number, deadlineMs: number): string {
  const seconds = Math.ceil(remainingMs / 1000)
  if (seconds < 60) return t("chat.retryInSeconds", { n: seconds })
  if (seconds < 60 * 60) {
    const minutes = Math.ceil(seconds / 60)
    return t("chat.retryInMinutes", { n: minutes })
  }
  const d = new Date(deadlineMs)
  const hh = d.getHours().toString().padStart(2, "0")
  const mm = d.getMinutes().toString().padStart(2, "0")
  const time = `${hh}:${mm}`
  const nowD = new Date(now.value)
  const sameLocalDay =
    d.getFullYear() === nowD.getFullYear() &&
    d.getMonth() === nowD.getMonth() &&
    d.getDate() === nowD.getDate()
  return sameLocalDay ? t("chat.retryAtTime", { time }) : t("chat.retryAtTimeTomorrow", { time })
}

function onRetry(): void {
  if (!canRetry.value) return
  emit("retry", props.message.id)
}

function actionState(actionId: string): ActionState {
  const raw = props.message.actionStates?.[actionId]
  // Only surface the four states the UI actually renders. Anything else
  // (legacy "dismissed" from earlier sessions, missing key, garbage)
  // collapses to "pending" so the Create button is always reachable.
  if (raw === "executing" || raw === "done" || raw === "error") return raw
  return "pending"
}

function sharePdfPayload(
  actionId: string
): Extract<ChatActionPayload, { kind: "share_pdf" }> | undefined {
  const a = props.message.actions?.[actionId]
  return a && a.kind === "share_pdf" ? a : undefined
}

function enableReminderPayload(
  actionId: string
): Extract<ChatActionPayload, { kind: "enable_daily_reminder" }> | undefined {
  const a = props.message.actions?.[actionId]
  return a && a.kind === "enable_daily_reminder" ? a : undefined
}

function configureSmartLibraryPayload(
  actionId: string
): Extract<ChatActionPayload, { kind: "configure_smart_library" }> | undefined {
  const a = props.message.actions?.[actionId]
  return a && a.kind === "configure_smart_library" ? a : undefined
}

function upgradeToProPayload(
  actionId: string
): Extract<ChatActionPayload, { kind: "upgrade_to_pro" }> | undefined {
  const a = props.message.actions?.[actionId]
  return a && a.kind === "upgrade_to_pro" ? a : undefined
}

function queueNextTrackPayload(
  actionId: string
): Extract<ChatActionPayload, { kind: "queue_next_track" }> | undefined {
  const a = props.message.actions?.[actionId]
  return a && a.kind === "queue_next_track" ? a : undefined
}

async function onConfirmAction(actionId: string, override?: { time?: string }): Promise<void> {
  // Snapshot the kind BEFORE executeAction — the store may mutate
  // actionStates and the action payload reference can disappear from
  // an aborted/replaced message later.
  const kind = props.message.actions?.[actionId]?.kind
  await chat.executeAction(props.message.id, actionId, override)
  // Smart Library: the chat-side handler set the auto-download filters
  // we received, but the user has no UI feedback in the chat surface.
  // Land them on the Settings tab where the Smart Library section
  // reflects whatever was just applied (empty payload from the LLM →
  // they see the regular Settings card and can configure manually).
  if (kind === "configure_smart_library") {
    void router.push("/tabs/settings")
  }
}
</script>

<style scoped>
/* Library document citation — styled blockquote rendered between text
 * tokens. Body inherits inline-md spans (em/strong/code); attribution
 * sits on a separate line, smaller and italic.
 */
.chat-quote {
  display: block;
  margin: 8px 0;
  padding: 6px 12px;
  border-left: 3px solid var(--ion-color-primary, #5a3e8e);
  background: rgba(90, 62, 142, 0.06);
  border-radius: 4px;
  font-style: italic;
  color: var(--ion-color-medium-shade, #4d4d4d);
  line-height: 1.4;
}
.chat-quote-attribution {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  font-style: italic;
  color: var(--ion-color-medium, #777);
}

.bubble-row {
  display: flex;
  margin: 6px 0;
  padding: 0 12px;
  /* `scrollIntoView({ block: "start" })` aligns the row's top edge with
   * viewport y = scroll-margin-top (IonContent is fullscreen so the
   * scroll-port top sits at viewport y=0). Land the row right below
   * the 52px action row: safe-area + 4 (top pad) + 44 (buttons) + 4
   * (bottom pad). The fade gradient extends another 28px past this,
   * softly masking the bubble's top edge — that's the designed look
   * (content "emerges" from under the header) rather than parking the
   * bubble below the fade with visible empty space. */
  scroll-margin-top: calc(var(--ion-safe-area-top, 0px) + 56px);
}

.bubble-row.user {
  justify-content: flex-end;
}

.bubble-row.assistant {
  /* Stack the assistant's full-width prose on top of the inline action
   * row (`ChatMessageActions`). A flex-row layout would shove the
   * actions next to the bubble, and since `.bubble.assistant` is
   * width: 100%, the actions would steal space from the text and end
   * up parked at the top-right of the first paragraph instead of
   * under the whole message. */
  flex-direction: column;
  align-items: flex-start;
}

.bubble {
  font-size: 15px;
  line-height: 1.45;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}

/* Only the user side renders as a chat bubble — the assistant answer is
 * full-width prose (Claude pattern). Keeps the page wider for reading
 * long replies, cards, and citation chips without an enclosing pill. */
.bubble.user {
  max-width: 86%;
  padding: 10px 14px;
  border-radius: 18px;
  border-bottom-right-radius: 6px;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
}

.bubble.assistant {
  color: var(--ion-text-color);
  width: 100%;
}

.user-text {
  white-space: pre-wrap;
}

.thinking {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 4px 0;
}

.thinking .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ion-color-step-500, #9a9a9a);
  animation: thinking-pulse 1.2s ease-in-out infinite;
}

.thinking .dot:nth-child(2) {
  animation-delay: 0.15s;
}

.thinking .dot:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes thinking-pulse {
  0%,
  60%,
  100% {
    opacity: 0.4;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

/* Inline markdown styles (marked.parseInline output): keep them
 * scoped-safe by allowing :deep into the v-html span tree. */
.bubble.assistant :deep(strong) {
  font-weight: 600;
}

.bubble.assistant :deep(em) {
  font-style: italic;
}

.bubble.assistant :deep(code) {
  font-family: ui-monospace, SFMono-Regular, monospace;
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 0.9em;
}

.bubble.assistant :deep(a) {
  color: var(--ion-color-primary);
  text-decoration: underline;
}

/* Trailing "(прервано)" / "(cut off)" suffix on a message that ended
 * without a clean `done`. Inline, lower-key colour, so it reads as a
 * note rather than competing with the bubble text. */
.bubble.assistant .truncated-suffix {
  color: var(--ion-color-medium);
  font-style: italic;
  font-size: 0.85em;
  white-space: pre;
}

.bubble.assistant .btn.primary.retry {
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  border: 0;
  border-radius: 10px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.bubble.assistant .btn.primary.retry:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>

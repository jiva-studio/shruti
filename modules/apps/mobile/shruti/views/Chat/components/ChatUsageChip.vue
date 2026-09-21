<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useAuthStore } from "@shruti/stores/useAuthStore.js"
import { usePaywallStore } from "@shruti/stores/usePaywallStore.js"

const props = defineProps<{
  /** Per-day chat usage snapshot from the server's SSE `usage` event
   *  (or 429 body on key_type='user'). `null` keeps the chip hidden
   *  unless `quotaLocked`. */
  chatUsage?: { current: number; limit: number; resetsAtEpoch: number } | null
  /** True while the rate-limit window is open — keeps the chip visible
   *  as the only surface carrying the reset detail. */
  quotaLocked?: boolean
}>()

const { t, locale } = useI18n()
const authStore = useAuthStore()
const isPro = computed(() => authStore.isPro)

const usageRatio = computed<number | null>(() => {
  const u = props.chatUsage
  if (!u || u.limit <= 0) return null
  return Math.min(1, u.current / u.limit)
})

const visible = computed<boolean>(() => {
  // Lockout always shows the chip: it's now the only surface carrying the
  // "resets {date} at {time}" detail (the placeholder went static). This
  // also covers the locked-but-no-snapshot case — see `label`.
  if (props.quotaLocked) return true
  const r = usageRatio.value
  if (r === null) return false
  return r >= 0.5
})

const warning = computed<boolean>(() => (usageRatio.value ?? 0) >= 0.95)

// Tap target only matters when there's an upgrade path. Pro users get
// the same chip but as a static info badge — opening the paywall for
// someone already paying is pointless. RC handles a stale-tier case
// ("already subscribed") if a Free-marked client opens the paywall
// after a webhook race, so no second guard here.
const tappable = computed<boolean>(() => !isPro.value)

/** Local-TZ reset boundary as `{ date, time }`. The server's
 *  `resets_at_epoch` is next UTC midnight, so for users east of UTC it
 *  routinely lands on the local next day — showing the date (not just
 *  HH:MM) is what disambiguates it. Date is localized via Intl using the
 *  active i18n locale ("30 мая" / "30 May"). */
function localResetParts(epochS: number): { date: string; time: string } {
  const d = new Date(epochS * 1000)
  const hh = d.getHours().toString().padStart(2, "0")
  const mm = d.getMinutes().toString().padStart(2, "0")
  const date = new Intl.DateTimeFormat(locale.value, {
    day: "numeric",
    month: "long",
  }).format(d)
  return { date, time: `${hh}:${mm}` }
}

const label = computed<string>(() => {
  const u = props.chatUsage
  if (!u) {
    // Locked without a usage snapshot (IP-bucket 429, or a 429 body
    // lacking current/limit). The textarea is disabled but the chip is
    // the only thing on screen, so fall back to the generic lock copy
    // rather than rendering an empty pill that explains nothing.
    return props.quotaLocked ? t("chat.composeLimitedPlaceholderNoTime") : ""
  }
  const { date, time } = localResetParts(u.resetsAtEpoch)
  const p = Math.round((usageRatio.value ?? 0) * 100)
  return t("chat.usage.chip", { p, date, time })
})

function onTap(): void {
  // Free / anonymous tap → paywall directly. No intermediate modal —
  // the subscription page already explains the offer.
  usePaywallStore().requestOpen()
}
</script>

<template>
  <!-- Per-day chat usage chip. Shows once ≥50 % of the daily allowance
       is consumed; the lower number for everyone gives Free users an
       earlier nudge and Pro users earlier awareness. Also stays visible
       once the quota lockout kicks in — the composer placeholder is a
       plain static prompt, so the chip is the single place that carries
       "resets {date} at {time}".
       Tap → opens the subscription page directly for non-Pro users (RC
       modal handles "already subscribed" if state goes stale). Pro users
       see the chip as a static info badge — no tap target, no modal. -->
  <component
    :is="tappable ? 'button' : 'span'"
    v-if="visible"
    :type="tappable ? 'button' : undefined"
    class="usage-chip"
    :class="{ 'is-warning': warning, 'is-tappable': tappable }"
    :aria-label="label"
    @click="tappable ? onTap() : null"
  >
    {{ label }}
  </component>
</template>

<style scoped>
/* Per-day usage chip sitting just above the composer capsule. Small,
 * muted, rounded — same pill shape across tiers. Warning tone kicks in
 * at ≥95%. Tappable for non-Pro (opens paywall); a static info badge for
 * Pro (`is-tappable` toggles the cursor + resets default button styling
 * that would have made the static span look like a button). */
.usage-chip {
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  line-height: 1.2;
  padding: 4px 12px;
  margin-bottom: 4px;
  border: 1px solid var(--shruti-input-border);
  border-radius: 999px;
  background: var(--shruti-input-surface);
  color: var(--ion-color-step-650, #5c5c5c);
  pointer-events: auto;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
  -webkit-tap-highlight-color: transparent;
}

.usage-chip.is-tappable {
  cursor: pointer;
}

.usage-chip.is-warning {
  color: var(--ion-color-warning-shade, #b76e00);
  border-color: var(--ion-color-warning-tint, #ffca6b);
}

.usage-chip.is-tappable:active {
  opacity: 0.75;
}
</style>

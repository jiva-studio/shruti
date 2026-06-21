# Onboarding

First launch shows a value-building onboarding carousel instead of a loading
screen. The content database ships bundled with the app, so the bootstrap runs
**headlessly** at startup (behind the OS-native splash) — the old "connecting /
checking / downloading" Welcome screen is gone. A first-time user lands on the
onboarding carousel; every later launch opens straight on Home. The flow
captures the user's topic interests, offers a daily-wisdom toggle, shows a value
moment, and ends on a skippable soft paywall.

## Flow

```mermaid
flowchart TD
  start(["app start — main.ts"]) --> boot["headless bootstrap — open content + user DB"]
  boot --> done{"already onboarded?"}
  done -- "completed flag set, or has prior listening history" --> home["tabs/home"]
  done -- otherwise --> ob["onboarding"]
  ob --> s1["1 Welcome — logo + Shruti + punch"]
  s1 --> s2["2 Topics — curated multi-select"]
  s2 --> s3["3 Daily wisdom — toggle + time"]
  s3 --> s4["4 Value moment — matched lectures"]
  s4 --> s5["5 Soft paywall — screenshots + SubscriptionPlans"]
  s5 -- "subscribe / Later / Skip" --> mark["onboarding.completed = true"]
  mark --> home
```

- **Component**: a purpose-built carousel `ui/features/onboarding/OnboardingCarousel.vue`
  (swipe + progress dots + one primary CTA + a top-right Skip — no Back/Next
  pair). The low-level swipe hook is the shared `@ui/components/useHorizontalCarousel`.
- **Screens** live in `shruti/views/Onboarding/screens/`. Orchestration +
  state in `OnboardingView.controller.ts` (the `useOnboardingViewController`
  composable); the `.vue` is template-only.
- **Persisted flag**: `onboarding.completed` (Capacitor Preferences) via
  `useOnboardingStore`. Set only at the end, so an interrupted run replays.
- **Skip gate**: onboarding shows only when the flag is unset **and** the user
  has no prior listening history (`listeningSessions.hasAny()`). An established
  user upgrading into this build skips it; the flag is stamped once that's
  inferred, so the history probe runs at most once.
- **Routing**: `main.ts` runs `runStartupBootstrap()` before mount, evaluates
  the skip gate, and routes a genuinely-new user → `/onboarding`, everyone else
  → `/tabs/home`. The `/welcome` route and `WelcomeView` were deleted.

## Curated topics (config registry)

The topic picker shows an **editorial** subset of topics, not all ~140 (which
contain near-duplicates and organizational topics). The curated, ordered list is
stored as data in the catalog DB:

- **Storage**: a general-purpose `settings` table in `current.db`, key
  `onboarding.topics` = JSON array of topic ids. Chosen over `config.json`
  because the DB is bundled/offline, so the list is always available.
- **Authoring (MCP)**: an extensible **config registry**
  (`internal/application/config/registry`) where each key registers a
  `{schema, validator, description}`. `config.describe` exposes the schemas;
  `config.set` validates (the `onboarding.topics` validator rejects unknown
  topic ids) before writing; ships via `catalog.publish`.
- **Mobile read**: `loadOnboardingTopics` reads the key via the `settings` repo
  and resolves topics with `topics.getByIds` (order-preserving). Falls back to
  popularity (`topicIdsWithTracksIn`) when the key is unset, so the screen is
  never empty.

Topic picks are saved to the search-filter store (`setTopics`) for immediate
personalization. They are **not** used by daily wisdom — that draws a random
fragment from the whole corpus (see below).

## Daily wisdom

A new proactive rule `daily_wisdom` (see [Proactive messages](proactive-messages.md))
delivers one short, playable lecture excerpt per day into chat:

- **Corpus**: a `daily_wisdom` table in `current.db` (`track_id`, `start_ms`,
  `end_ms`, `text`, `topic_id`, `language`), authored via the MCP `wisdom.*`
  tools.
- **Rule**: gated only on the daily-engagement toggle (`settings.notificationsEnabled`).
  `detect` picks a **random** fragment from the whole corpus, filtered to the
  user's **library languages** (lecture content language — never delivers an
  excerpt the user can't read; skips the day if none match). It is deliberately
  **not** scoped to the user's topics — a few topics would drain the small
  per-topic pool — so there is no daily-wisdom topic setting. `buildContent`
  emits a `[cite:track@start-end|text]` marker that the existing `CitationCard`
  renders as a playable excerpt. Silent (no extra OS push — the daily reminder
  handles the nudge); dedup by fragment id, 24 h cooldown.

## Paywall (hybrid)

The final screen reuses the purchase machinery and replaces the visuals. The
purchase footer was decomposed into small parts (`SubscriptionPlans`,
`SubscriptionDisclaimer`, `SubscriptionLinks`) so each host composes only what
it needs — no `variant`/`hide-*` flags:

- **Reused**: `SubscriptionPlans` (plan selection, CTA, trial/intro price) +
  `useSubscriptionBinding`, the same purchase core the Settings footer composes.
  Onboarding renders its Restore/legal links inline in `PaywallScreen` (a
  one-line row) and omits the trial disclaimer; Settings composes the full
  footer (`SubscriptionFooter` = plans + disclaimer + stacked links).
- **New**: a value hero (title, subtitle, bullets, an app-screenshot strip that
  hides missing assets). The generated badge carousel from the subscription
  feature is **not** used here.
- Finishing: a successful purchase or the Skip ("Later") both complete onboarding.

## Bundled database

The first launch is instant + offline because a seed `current.db` ships as an
app asset and is copied into place when no cached DB exists; `scheduleBackgroundRefresh`
then fetches a newer catalog for the next launch. The seed DB must be at the
scheme version the binary expects, and carries the `key_value` + `daily_wisdom`
tables so onboarding works offline out of the box.

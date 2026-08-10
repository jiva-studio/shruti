# Mobile i18n locales

One directory per locale. Each `.ts` file inside it is one translation
surface (chat, library, settings, …) and keys are nested objects.

## Bundles and lazy loading

A locale's namespaces are assembled into a single default export by
`../bundles/<locale>.ts`. That indirection is what makes the split
possible: the build emits one chunk per bundle file, so the entry chunk
carries only `en` (statically imported as the fallback) and every other
locale is fetched on demand by `loadLocaleMessages` in
`../index.ts` — at boot for the device language, and on switch from
Settings.

Two consequences for edits here:

- A **new locale** needs its own `bundles/<code>.ts` plus an entry in
  `SUPPORTED_LOCALES` and `AUTONYMS`.
- A **new namespace** (a new `.ts` file in every locale directory) has to
  be added to all 14 bundle files, not just to one loader.

## Conventions

- Mirror the structure: every key that exists in `en/<file>.ts` MUST
  exist in `ru/<file>.ts` and vice-versa. Missing keys fall back to the
  raw key string, which the user sees verbatim.
- Plain strings only — no JSX, no inlined HTML. Use `vue-i18n`
  named-parameter interpolation (`"{when}"`, `"{n}"`) for dynamic bits.
- One-line paragraphs in store / marketing copy: the textareas in the
  Play Console don't strip manual line wraps (see memory
  `feedback_no_manual_linewraps`).
- Russian wording should read as native Russian — no English calques
  (see memory `feedback_no_english_calques_in_russian`). When in doubt,
  ask before substituting machine-translated jargon.

## Generated locale: `sr-Cyrl/`

`sr-Cyrl/` is **not** hand-authored. It is a pure function of `sr-Latn/`
plus `modules/tools/sr-transliterate/`, which maps Serbian gajica to
Cyrillic and keeps a do-not-transliterate list of brand tokens
(`Shruti`, `Ask Sadhu`, `Pro`, `PRO`, `PDF`, `Google`, …) in
Latin, the way `ru/` writes them. Edit `sr-Latn/`, then:

```
cd modules/apps/mobile && npm run locales:sr-cyrl
```

and commit both bundles. Editing `sr-Cyrl/` directly is silently
reverted by the next regeneration; the `Mobile / sr-Cyrl locale` workflow
fails the PR when the two drift apart.

## Hardcoded-count rule

Strings under `chat.errQuota*` (anonymous / free / pro daily-message
limit copy) **must not contain numeric daily limits**. Examples of what
NOT to write:

```
errQuotaAnonBody: "Sign in for 10 messages per day."   // BAD
errQuotaFreeBody: "Free tier gives 25 messages/day."   // BAD
```

The actual numbers live on the server in
`modules/services/chat/agent/config.py` and are tuned independently of
the mobile release cycle. If we bake a number into the i18n string and
the server limit moves, the user reads a lie until the next app store
roll-out.

Instead, refer to the reset boundary with the `{when}` placeholder
(formatted to "in N s" / "in N min" / "at HH:MM" by the bubble) and
let the CTA carry the upgrade story:

```
errQuotaAnonBody: "Sign in to get more chat messages per day. Resets {when}."   // OK
errQuotaFreeBody: "Shruti Pro lifts the daily message limit. Resets {when}."   // OK
```

This rule is policy-only — there is no `no-restricted-syntax`
infrastructure in `modules/apps/mobile/eslint.config.js` for vue-i18n
literals. If we ever add one, the rule body should match any of:

- `\b\d+\s*(?:in\s+day|per\s+day|/day|message[s]?/day)\b` (English)
- `\b\d+\s*(?:в\s+день|сообщен[а-я]+\s+в\s+день)\b` (Russian)

Reference: plan section 3.6 in
`/home/akd/.claude/plans/eager-dreaming-starlight.md` (subscription tier
feature improvement plan).

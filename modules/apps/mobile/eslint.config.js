import js from "@eslint/js"
import pluginVue from "eslint-plugin-vue"
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript"
import prettierPlugin from "eslint-plugin-prettier"
import prettierConfig from "eslint-config-prettier"
import globals from "globals"
import tseslint from "typescript-eslint"

const isProd = process.env.NODE_ENV === "production"

export default defineConfigWithVueTs(
  {
    ignores: ["dist/**", "android/**", "ios/**", "node_modules/**", "coverage/**", "*.d.ts"],
  },
  js.configs.recommended,
  pluginVue.configs["flat/essential"],
  vueTsConfigs.recommended,

  // Type-aware lint. These three need the type checker, and they are the ones
  // that catch a defect rather than a style: a promise nobody waits for, a
  // promise handed where a void was expected, an await on a value that was
  // never thenable. In an app whose downloads, sync and player are all async, a
  // floating promise is a silent failure.
  {
    files: ["**/*.ts", "**/*.vue"],
    languageOptions: {
      parserOptions: {
        // The files the build's tsconfig does not name.
        projectService: {
          allowDefaultProject: ["vite.config.ts", "vitest.config.ts", "capacitor.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".vue"],
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { prettier: prettierPlugin },
    rules: {
      ...prettierConfig.rules,
      "prettier/prettier": "error",
      "no-console": isProd ? "warn" : "off",
      "no-debugger": isProd ? "warn" : "off",
      semi: ["error", "never"],
      "vue/component-name-in-template-casing": [
        "error",
        "PascalCase",
        { registeredComponentsOnly: false },
      ],
      // Ionic uses DOM slot="…" attributes that the Vue rule misreads.
      "vue/no-deprecated-slot-attribute": "off",
      // Vue 3 doesn't have filters at all — the rule false-positives on TS
      // union types (`x as A | B`) inside attribute bindings.
      "vue/no-deprecated-filter": "off",
      // Allow these specific single-word names — they're internal UI primitives
      // where the bare noun is the meaningful name.
      "vue/multi-word-component-names": [
        "error",
        { ignores: ["Header", "Message", "Timestamp", "Waveform"] },
      ],
    },
  },

  /* ---- Style isolation ---- */

  // An unscoped <style> in a screen or a shared component is global CSS: its
  // selectors match every element in the app, and generic class names ("badge",
  // "card") silently override unrelated components (#1481). Screens and
  // components must keep their CSS scoped; the allowlist below carves out the
  // handful of blocks that have to be global.
  {
    files: ["shruti/views/**/*.vue", "shruti/components/**/*.vue"],
    rules: {
      "vue/enforce-style-attribute": ["error", { allow: ["scoped", "module"] }],
    },
  },
  // Allowlist: both files own an <ion-modal> that Ionic teleports to the app
  // root, where the scope attribute never follows, so their host-level
  // overrides have to be global. That is the only accepted reason — a routed
  // page keeps its markup in its own template and gets no exemption.
  //
  // The exemption is per FILE, not per rule, so it certifies nothing about the
  // contents. Anchoring every selector to the component's own modal class is
  // the bar for staying here: both files clear it today (TrackSheet's bare
  // `ion-footer` rule, which leaked app-wide, was anchored in #1534). A file
  // whose plain block stops needing global reach comes off the list entirely.
  {
    files: [
      "shruti/components/TrackSheet.vue",
      "shruti/views/Chat/components/ChatSessionList.vue",
    ],
    rules: {
      "vue/enforce-style-attribute": ["error", { allow: ["scoped", "module", "plain"] }],
    },
  },

  /* ---- Layer boundary rules ---- */

  // Contracts (shared kernel / published language): pure wire types,
  // zero dependencies — not even the domain. Importable by every layer.
  {
    files: ["submodules/contracts/**/*.ts", "../../libs/contracts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@lib/domain", "@lib/domain/*", "@usecases", "@usecases/**"],
              message: "Contracts must not import domain/application — keep them dependency-free",
            },
            { group: ["@ports/*"], message: "Contracts must not import technical ports" },
            { group: ["@infra/*"], message: "Contracts must not import infrastructure" },
            { group: ["@ui/*"], message: "Contracts must not import UI" },
            { group: ["@shruti/*"], message: "Contracts must not import composition root" },
            { group: ["@kit/*"], message: "Contracts must not import the shared toolkit" },
            {
              group: ["vue", "vue-router", "@ionic/*"],
              message: "Contracts must not import framework code",
            },
          ],
        },
      ],
    },
  },

  // Domain: pure, imports nothing external
  {
    files: ["submodules/domain/**/*.ts", "../../libs/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@usecases", "@usecases/**"],
              message: "Domain must not import application layer",
            },
            { group: ["@ports/*"], message: "Domain must not import technical ports" },
            { group: ["@infra/*"], message: "Domain must not import infrastructure" },
            { group: ["@ui/*"], message: "Domain must not import UI" },
            { group: ["@shruti/*"], message: "Domain must not import composition root" },
            {
              group: ["vue", "vue-router", "@ionic/*"],
              message: "Domain must not import framework code",
            },
          ],
        },
      ],
    },
  },

  // Application: depends on domain only
  {
    files: ["usecases/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@ports/*"], message: "Application must not import technical ports" },
            { group: ["@infra/*"], message: "Application must not import infrastructure" },
            { group: ["@ui/*"], message: "Application must not import UI" },
            { group: ["@shruti/*"], message: "Application must not import composition root" },
            {
              group: ["@lib/persistence/*"],
              message: "Application must not import persistence row types",
            },
            {
              group: ["vue", "vue-router", "@ionic/*"],
              message: "Application must not import framework code",
            },
          ],
        },
      ],
    },
  },

  // Only the composition root binds an adapter. Type-only imports are fine.
  {
    files: [
      "shruti/stores/**/*.ts",
      "shruti/composables/**/*.ts",
      "shruti/services/**/*.ts",
      "shruti/proactive/**/*.ts",
    ],
    // bootstrap.ts is startup wiring — composition root in all but location.
    ignores: ["**/__tests__/**", "**/*.test.ts", "shruti/services/bootstrap.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@infra/*", "@kit/infra"],
              allowTypeImports: true,
              message:
                "only the composition root binds an adapter — take the port, or import the type alone",
            },
          ],
        },
      ],
    },
  },

  // Technical ports: zero imports
  {
    files: ["ports/**/*.ts"],
    rules: {
      // The typescript-eslint variant of the rule: same options, plus
      // `allowTypeImports` / `allowImportNames`, which is what lets the
      // @kit/* entries below ban implementations without banning the port
      // types kit owns. The base rule is off so the two cannot disagree.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@infra/*"], message: "Ports must not import infrastructure" },
            { group: ["@lib/*"], message: "Ports must not import domain/application" },
            { group: ["@ui/*"], message: "Ports must not import UI" },
            { group: ["@shruti/*"], message: "Ports must not import composition root" },
            {
              // "Zero imports" has to mean the shared toolkit too. `@kit/infra`
              // is where the Capacitor adapters live, so a value import from it
              // makes a port depend on an implementation — the exact inversion
              // this block exists to prevent (#1742).
              //
              // Two carve-outs, both narrow and both named:
              //  - type-only imports: kit OWNS these port interfaces
              //    (`IPreferences`, `IShareService`, …) and the files here are
              //    re-export shims for them. A type erases at compile time.
              //  - `NotificationsDisabledError`: a plain Error subclass declared
              //    in kit's port module next to `INotificationScheduler`, not in
              //    an adapter. `notificationPlanner` needs `instanceof`, which a
              //    type-only export cannot give it. Nothing else may be a value.
              group: ["@kit/*"],
              allowTypeImports: true,
              allowImportNames: ["NotificationsDisabledError"],
              message: "Ports must not import the shared toolkit's implementations",
            },
          ],
        },
      ],
    },
  },

  // Persistence (row types): pure type declarations, no imports allowed.
  // These describe raw SQL row shapes consumed only by @infra/repositories/sql.
  // Symlinked under submodules/persistence-{main,user}; matched via both paths
  // so eslint catches the violation regardless of which path it traverses.
  {
    files: ["submodules/persistence-*/**/*.ts", "../../libs/persistence/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@infra/*"],
              message: "Persistence row types must not import infrastructure",
            },
            {
              group: ["@ports/*"],
              message: "Persistence row types must not import technical ports",
            },
            {
              group: ["@lib/domain/*", "@lib/domain", "@usecases", "@usecases/**"],
              message:
                "Persistence row types must not import domain or application — they are pure row shapes",
            },
            { group: ["@ui/*"], message: "Persistence row types must not import UI" },
            {
              group: ["@shruti/*"],
              message: "Persistence row types must not import composition root",
            },
            {
              group: ["@capacitor/*"],
              message: "Persistence row types must not import platform SDKs",
            },
            {
              group: ["vue", "vue-router", "@ionic/*"],
              message: "Persistence row types must not import framework code",
            },
          ],
        },
      ],
    },
  },

  // Infra: may import @ports, @lib/domain, @lib/persistence and the two
  // shared infra-root utilities (@infra/idbKv, @infra/watchDownload) only.
  // Sibling-infra imports are forbidden — siblings compose only through the
  // composition root. In-house Capacitor plugins from `modules/plugins/` are
  // published under the same `@shruti` npm scope as the composition root,
  // distinguished by the `plugin-` prefix; those are carved out from the ban.
  {
    files: ["infra/**/*.ts"],
    ignores: ["infra/**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@ui/*"], message: "Infrastructure must not import UI" },
            {
              group: ["@shruti/*", "!@shruti/plugin-*"],
              message: "Infrastructure must not import composition root",
            },
            {
              group: ["@usecases", "@usecases/**"],
              message: "Infrastructure must not import application layer",
            },
            {
              // Allow only @infra/idbKv and the media-downloader watchdog;
              // every other sibling is forbidden. The watchdog is not an
              // adapter but the shared event plumbing of ONE plugin bridge —
              // "await these two events, and give up when neither comes" is a
              // single rule the adapters over that bridge must apply
              // identically, and a composition root cannot hand it to them
              // without inventing a port for a `setTimeout`. The negated
              // patterns must come after the broad one.
              group: ["@infra/*", "!@infra/idbKv", "!@infra/watchDownload.js"],
              message: "Infra siblings must not import each other — wire via composition root",
            },
          ],
        },
      ],
    },
  },
  // Tests inside infra may reach outward freely (helpers, app shims).
  {
    files: ["infra/**/__tests__/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },

  // UI (base rule): no imports from domain/application/ports/infra/composition root
  {
    files: ["ui/**/*.{ts,vue}"],
    rules: {
      // The typescript-eslint variant of the rule: same options, plus
      // `allowTypeImports` / `allowImportNames`, which is what lets the
      // @kit/* entries below ban implementations without banning the port
      // types kit owns. The base rule is off so the two cannot disagree.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@ports/*"], message: "UI must not import technical ports" },
            { group: ["@infra/*"], message: "UI must not import infrastructure" },
            {
              group: ["@lib/domain/*", "@lib/domain"],
              message: "UI must not import domain — use mirror types",
            },
            {
              // @lib/ui is the one shared library the UI is built from. A
              // sibling carries domain, wire and parsing code into a view:
              // HelpMarkdown reached @lib/chat and lint stayed green (#1952).
              group: ["@lib/*", "@lib/*/**", "!@lib/ui", "!@lib/ui/**"],
              allowTypeImports: true,
              message: "UI may import @lib/ui only — take the type, or move the code into @lib/ui",
            },
            {
              group: ["@usecases", "@usecases/**"],
              message: "UI must not import application layer",
            },
            { group: ["@shruti/*"], message: "UI must not import composition root" },
            {
              group: ["@capacitor/*"],
              message: "UI must not import Capacitor SDKs — use a @ports/app port instead",
            },
            {
              // `@kit/infra` IS infrastructure — it is where the Capacitor
              // adapters live (`useCapacitorShareService`, the local-notification
              // scheduler, the IndexedDB blob store). The entry above only bans
              // the SDK import; without this one, `@kit/infra` walks the same
              // code straight into a view and lints clean (#1742). Type-only
              // imports stay allowed: a port interface erases at compile time
              // and brings no adapter with it.
              group: ["@kit/infra", "@kit/infra/*"],
              allowTypeImports: true,
              message: "UI must not import infrastructure — use a @ports/app port instead",
            },
          ],
        },
      ],
    },
  },

  // UI primitives: shared no-dep building blocks. Cannot import any other UI layer.
  {
    files: ["ui/primitives/**/*.{ts,vue}"],
    rules: {
      // The typescript-eslint variant of the rule: same options, plus
      // `allowTypeImports` / `allowImportNames`, which is what lets the
      // @kit/* entries below ban implementations without banning the port
      // types kit owns. The base rule is off so the two cannot disagree.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@ports/*"], message: "UI must not import technical ports" },
            { group: ["@infra/*"], message: "UI must not import infrastructure" },
            {
              group: ["@lib/domain/*", "@lib/domain"],
              message: "UI must not import domain — use mirror types",
            },
            {
              // @lib/ui is the one shared library the UI is built from. A
              // sibling carries domain, wire and parsing code into a view:
              // HelpMarkdown reached @lib/chat and lint stayed green (#1952).
              group: ["@lib/*", "@lib/*/**", "!@lib/ui", "!@lib/ui/**"],
              allowTypeImports: true,
              message: "UI may import @lib/ui only — take the type, or move the code into @lib/ui",
            },
            {
              group: ["@usecases", "@usecases/**"],
              message: "UI must not import application layer",
            },
            { group: ["@shruti/*"], message: "UI must not import composition root" },
            {
              group: ["@capacitor/*"],
              message: "UI must not import Capacitor SDKs — use a @ports/app port instead",
            },
            {
              // `@kit/infra` IS infrastructure — it is where the Capacitor
              // adapters live (`useCapacitorShareService`, the local-notification
              // scheduler, the IndexedDB blob store). The entry above only bans
              // the SDK import; without this one, `@kit/infra` walks the same
              // code straight into a view and lints clean (#1742). Type-only
              // imports stay allowed: a port interface erases at compile time
              // and brings no adapter with it.
              group: ["@kit/infra", "@kit/infra/*"],
              allowTypeImports: true,
              message: "UI must not import infrastructure — use a @ports/app port instead",
            },
            { group: ["@ui/components/*"], message: "Primitives must not import components" },
            { group: ["@ui/features/*"], message: "Primitives must not import features" },
            { group: ["@ui/icons/*"], message: "Primitives must not import icons" },
          ],
        },
      ],
    },
  },

  // UI icons: pure SVG sprites, zero deps. Cannot import any other UI layer.
  {
    files: ["ui/icons/**/*.{ts,vue}"],
    rules: {
      // The typescript-eslint variant of the rule: same options, plus
      // `allowTypeImports` / `allowImportNames`, which is what lets the
      // @kit/* entries below ban implementations without banning the port
      // types kit owns. The base rule is off so the two cannot disagree.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@ports/*"], message: "UI must not import technical ports" },
            { group: ["@infra/*"], message: "UI must not import infrastructure" },
            {
              group: ["@lib/domain/*", "@lib/domain"],
              message: "UI must not import domain — use mirror types",
            },
            {
              // @lib/ui is the one shared library the UI is built from. A
              // sibling carries domain, wire and parsing code into a view:
              // HelpMarkdown reached @lib/chat and lint stayed green (#1952).
              group: ["@lib/*", "@lib/*/**", "!@lib/ui", "!@lib/ui/**"],
              allowTypeImports: true,
              message: "UI may import @lib/ui only — take the type, or move the code into @lib/ui",
            },
            {
              group: ["@usecases", "@usecases/**"],
              message: "UI must not import application layer",
            },
            { group: ["@shruti/*"], message: "UI must not import composition root" },
            {
              group: ["@capacitor/*"],
              message: "UI must not import Capacitor SDKs — use a @ports/app port instead",
            },
            {
              // `@kit/infra` IS infrastructure — it is where the Capacitor
              // adapters live (`useCapacitorShareService`, the local-notification
              // scheduler, the IndexedDB blob store). The entry above only bans
              // the SDK import; without this one, `@kit/infra` walks the same
              // code straight into a view and lints clean (#1742). Type-only
              // imports stay allowed: a port interface erases at compile time
              // and brings no adapter with it.
              group: ["@kit/infra", "@kit/infra/*"],
              allowTypeImports: true,
              message: "UI must not import infrastructure — use a @ports/app port instead",
            },
            { group: ["@ui/primitives/*"], message: "Icons must not import primitives" },
            { group: ["@ui/components/*"], message: "Icons must not import components" },
            { group: ["@ui/features/*"], message: "Icons must not import features" },
          ],
        },
      ],
    },
  },

  // UI components: generic widgets. May import primitives, icons, or sibling
  // components (same layer). Must not reach into features.
  {
    files: ["ui/components/**/*.{ts,vue}"],
    rules: {
      // The typescript-eslint variant of the rule: same options, plus
      // `allowTypeImports` / `allowImportNames`, which is what lets the
      // @kit/* entries below ban implementations without banning the port
      // types kit owns. The base rule is off so the two cannot disagree.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@ports/*"], message: "UI must not import technical ports" },
            { group: ["@infra/*"], message: "UI must not import infrastructure" },
            {
              group: ["@lib/domain/*", "@lib/domain"],
              message: "UI must not import domain — use mirror types",
            },
            {
              // @lib/ui is the one shared library the UI is built from. A
              // sibling carries domain, wire and parsing code into a view:
              // HelpMarkdown reached @lib/chat and lint stayed green (#1952).
              group: ["@lib/*", "@lib/*/**", "!@lib/ui", "!@lib/ui/**"],
              allowTypeImports: true,
              message: "UI may import @lib/ui only — take the type, or move the code into @lib/ui",
            },
            {
              group: ["@usecases", "@usecases/**"],
              message: "UI must not import application layer",
            },
            { group: ["@shruti/*"], message: "UI must not import composition root" },
            {
              group: ["@capacitor/*"],
              message: "UI must not import Capacitor SDKs — use a @ports/app port instead",
            },
            {
              // `@kit/infra` IS infrastructure — it is where the Capacitor
              // adapters live (`useCapacitorShareService`, the local-notification
              // scheduler, the IndexedDB blob store). The entry above only bans
              // the SDK import; without this one, `@kit/infra` walks the same
              // code straight into a view and lints clean (#1742). Type-only
              // imports stay allowed: a port interface erases at compile time
              // and brings no adapter with it.
              group: ["@kit/infra", "@kit/infra/*"],
              allowTypeImports: true,
              message: "UI must not import infrastructure — use a @ports/app port instead",
            },
            {
              group: ["@ui/features/*"],
              message:
                "Components must not import features — features depend on components, not the other way around",
            },
          ],
        },
      ],
    },
  },

  // UI features: may import primitives, icons, and components. Cross-feature
  // imports are forbidden — if two features need a shared widget, promote it
  // to @ui/components/.
  {
    files: ["ui/features/**/*.{ts,vue}"],
    rules: {
      // The typescript-eslint variant of the rule: same options, plus
      // `allowTypeImports` / `allowImportNames`, which is what lets the
      // @kit/* entries below ban implementations without banning the port
      // types kit owns. The base rule is off so the two cannot disagree.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@ports/*"], message: "UI must not import technical ports" },
            { group: ["@infra/*"], message: "UI must not import infrastructure" },
            {
              group: ["@lib/domain/*", "@lib/domain"],
              message: "UI must not import domain — use mirror types",
            },
            {
              // @lib/ui is the one shared library the UI is built from. A
              // sibling carries domain, wire and parsing code into a view:
              // HelpMarkdown reached @lib/chat and lint stayed green (#1952).
              group: ["@lib/*", "@lib/*/**", "!@lib/ui", "!@lib/ui/**"],
              allowTypeImports: true,
              message: "UI may import @lib/ui only — take the type, or move the code into @lib/ui",
            },
            {
              group: ["@usecases", "@usecases/**"],
              message: "UI must not import application layer",
            },
            { group: ["@shruti/*"], message: "UI must not import composition root" },
            {
              group: ["@capacitor/*"],
              message: "UI must not import Capacitor SDKs — use a @ports/app port instead",
            },
            {
              // `@kit/infra` IS infrastructure — it is where the Capacitor
              // adapters live (`useCapacitorShareService`, the local-notification
              // scheduler, the IndexedDB blob store). The entry above only bans
              // the SDK import; without this one, `@kit/infra` walks the same
              // code straight into a view and lints clean (#1742). Type-only
              // imports stay allowed: a port interface erases at compile time
              // and brings no adapter with it.
              group: ["@kit/infra", "@kit/infra/*"],
              allowTypeImports: true,
              message: "UI must not import infrastructure — use a @ports/app port instead",
            },
            {
              group: ["@ui/features/*"],
              message:
                "Cross-feature imports are forbidden — promote the shared widget to @ui/components/",
            },
          ],
        },
      ],
    },
  },

  // @lib/ui: the cross-app UI library, consumed by this app AND the Astro web
  // app. Symlinked under submodules/ui; matched via both paths so eslint
  // catches the violation regardless of which path it traverses. Same bar as
  // the in-repo ui/** layers, plus two extras that follow from being shared:
  // no app-local @ui/* (that layer sits above @lib/ui and imports it, never the
  // reverse) and no Ionic, because the web host does not ship Ionic at all.
  //
  // `eslint .` walks the tree itself and does NOT descend through a symlinked
  // directory, so a block keyed on submodules/** only ever runs when the path
  // is named explicitly — which is why the `lint` script lists every symlinked
  // root under submodules/ as an extra target. Adding a block for a new
  // symlinked package means adding that package to the script too, or the
  // block is dead on arrival (#1551).
  {
    files: ["submodules/ui/**/*.{ts,vue}", "../../libs/ui/**/*.{ts,vue}"],
    rules: {
      // The typescript-eslint variant of the rule: same options, plus
      // `allowTypeImports` / `allowImportNames`, which is what lets the
      // @kit/* entries below ban implementations without banning the port
      // types kit owns. The base rule is off so the two cannot disagree.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@ports/*"], message: "UI must not import technical ports" },
            { group: ["@infra/*"], message: "UI must not import infrastructure" },
            {
              group: ["@lib/domain/*", "@lib/domain"],
              message: "UI must not import domain — use mirror types",
            },
            {
              group: ["@lib/persistence/*"],
              message: "UI must not import persistence row types",
            },
            {
              group: ["@usecases", "@usecases/**"],
              message: "UI must not import application layer",
            },
            { group: ["@shruti/*"], message: "UI must not import composition root" },
            {
              group: ["@capacitor/*"],
              message: "UI must not import Capacitor SDKs — use a @ports/app port instead",
            },
            {
              // `@kit/infra` IS infrastructure — it is where the Capacitor
              // adapters live (`useCapacitorShareService`, the local-notification
              // scheduler, the IndexedDB blob store). The entry above only bans
              // the SDK import; without this one, `@kit/infra` walks the same
              // code straight into a view and lints clean (#1742). Type-only
              // imports stay allowed: a port interface erases at compile time
              // and brings no adapter with it.
              group: ["@kit/infra", "@kit/infra/*"],
              allowTypeImports: true,
              message: "UI must not import infrastructure — use a @ports/app port instead",
            },
            {
              // architecture.md: a library is built from what is below it,
              // never from a sibling. Pure UI must never know domain/catalog types.
              group: [
                "@lib/chat",
                "@lib/chat/*",
                "@lib/catalog",
                "@lib/catalog/*",
                "@lib/contracts",
                "@lib/contracts/*",
              ],
              allowTypeImports: false,
              message:
                "@lib/ui must not import sibling libraries (@lib/catalog, @lib/chat, @lib/contracts) — use mirror types or pass generic props",
            },
            {
              group: ["@ui/*"],
              message: "@lib/ui must not import the app-local UI layer — it is shared across apps",
            },
            {
              group: ["@ionic/*"],
              message: "@lib/ui must not import Ionic — the web app renders these components too",
            },
          ],
        },
      ],
    },
  },

  // @lib/chat: headless chat composables (marker parsing, excerpt audio) built
  // on plain Vue. Same bar as @lib/ui — it sits below the app layers and must
  // stay renderer-agnostic, so no Ionic and no app-local @ui/*.
  {
    files: ["submodules/chat/**/*.ts", "../../libs/chat/**/*.ts"],
    rules: {
      // The typescript-eslint variant of the rule: same options, plus
      // `allowTypeImports` / `allowImportNames`, which is what lets the
      // @kit/* entries below ban implementations without banning the port
      // types kit owns. The base rule is off so the two cannot disagree.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@ports/*"], message: "@lib/chat must not import technical ports" },
            { group: ["@infra/*"], message: "@lib/chat must not import infrastructure" },
            {
              group: ["@lib/domain/*", "@lib/domain"],
              message: "@lib/chat must not import domain — use mirror types",
            },
            {
              group: ["@lib/persistence/*"],
              message: "@lib/chat must not import persistence row types",
            },
            {
              group: ["@usecases", "@usecases/**"],
              message: "@lib/chat must not import application layer",
            },
            { group: ["@shruti/*"], message: "@lib/chat must not import composition root" },
            {
              group: ["@capacitor/*"],
              message: "@lib/chat must not import Capacitor SDKs — use a @ports/app port instead",
            },
            {
              // See the @lib/ui block: @kit/infra is the shared toolkit's
              // Capacitor-backed adapter layer, so banning @capacitor/* alone
              // leaves it reachable one alias over.
              group: ["@kit/infra", "@kit/infra/*"],
              allowTypeImports: true,
              message: "@lib/chat must not import infrastructure — use a @ports/app port instead",
            },
            {
              group: [
                "@lib/ui",
                "@lib/ui/*",
                "@lib/catalog",
                "@lib/catalog/*",
                "@lib/contracts",
                "@lib/contracts/*",
              ],
              allowTypeImports: true,
              message:
                "@lib/chat must not import a sibling library — take the type only, or move the code below both",
            },
            {
              group: ["@ui/*"],
              message: "@lib/chat must not import the app-local UI layer — it sits below it",
            },
            {
              group: ["@ionic/*"],
              message: "@lib/chat must not import Ionic — it stays renderer-agnostic",
            },
          ],
        },
      ],
    },
  },

  // ── Ported from the sibling repositories' configs ───────────────────────
  // A single-file component is read by the Vue parser, which hands the script
  // on; without this the type-aware rules have no types for a .vue.
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".vue"],
      },
    },
  },

  // A component's props are a contract with another module.
  {
    files: ["**/*.vue"],
    rules: {
      "vue/define-props-declaration": ["error", "type-based"],
      "vue/require-explicit-emits": "error",
      "vue/no-undef-components": "error",
      "vue/attribute-hyphenation": ["error", "always"],
      "vue/custom-event-name-casing": ["error", "kebab-case"],
    },
  },

  // A component draws one thing, and its size is where that is checked. A
  // template past a hundred lines or four elements deep holds a second
  // component nobody has named; a script past three hundred holds work that
  // belongs in a `.ts` beside it, where a test reaches it without mounting
  // anything.
  {
    files: ["**/*.vue"],
    rules: {
      "vue/max-lines-per-block": ["error", { template: 100, script: 300, skipBlankLines: true }],
      "vue/max-template-depth": ["error", { maxDepth: 5 }],
      "vue/block-order": ["error", { order: ["script", "template", "style"] }],
      "vue/define-macros-order": [
        "error",
        { order: ["defineProps", "defineModel", "defineEmits", "defineSlots"] },
      ],

      // A template says what is drawn. Every decision behind it is made in a
      // computed or in a named handler, which a test can call.
      "vue/no-restricted-syntax": [
        "error",
        {
          selector: "VElement ConditionalExpression ConditionalExpression",
          message: "a choice between three things is a computed",
        },
        {
          selector: "VOnExpression LogicalExpression",
          message: "a handler is a named function, and the guard goes inside it",
        },
        {
          selector:
            'VAttribute[directive=true][key.name.name="bind"][key.argument.name="style"] ObjectExpression',
          message:
            "an inline style object is a computed in <script>, not an object literal in the template",
        },
      ],

      // A computed is a projection of what the component was given.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'CallExpression[callee.name="computed"] :matches(ForStatement, ForOfStatement, ForInStatement, WhileStatement)',
          message: "a loop over the domain is a pure function in a .ts, with a test of its own",
        },
      ],
    },
  },

  // A component finding its own children takes a template ref.
  {
    files: ["**/*.vue"],
    rules: {
      "no-restricted-properties": [
        "error",
        ...["querySelector", "querySelectorAll", "getElementById"].map((property) => ({
          object: "document",
          property,
          message: "a component finding its own children takes a template ref",
        })),
      ],
    },
  },

  // Anything with a lifetime a test must hold still is a port. The pure layers
  // compute what is drawn from what they are given, so they may not ask the
  // machine what time it is, what the window measures, or what comes next.
  //
  // Scoped to the layers that must be deterministic. The views and the adapters
  // are the half that talks to the browser, and a player legitimately needs a
  // clock and a frame.
  {
    files: ["usecases/**/*.ts", "ports/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...[
          ["requestAnimationFrame", "the schedule a Clock carries"],
          ["cancelAnimationFrame", "the cancel a Clock carries"],
          ["matchMedia", "a prop, or CSS where the browser already knows"],
        ].map(([name, port]) => ({
          name,
          message: `${name} has a lifetime a test must hold still — take ${port}`,
        })),
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: 'MemberExpression[object.name="Date"][property.name="now"]',
          message: "the clock is a port — take the now a Clock carries",
        },
        {
          selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
          message: "the clock is a port — take the now a Clock carries",
        },
        {
          selector: 'MemberExpression[object.name="Math"][property.name="random"]',
          message: "the same input gives the same numbers on any machine on any day",
        },
        {
          selector: 'MemberExpression[property.name="getBoundingClientRect"]',
          message: "what the window measures is a port — take it as a value",
        },
      ],
    },
  },

  // Two hundred and fifty lines in a handwritten file, and a function whose
  // branches a reader cannot hold at once is two functions. A test is shaped by
  // what it is describing and is not held to either.
  {
    files: [
      "shruti/**/*.{ts,vue}",
      "ui/**/*.{ts,vue}",
      "usecases/**/*.ts",
      "ports/**/*.ts",
      "infra/**/*.ts",
    ],
    // A locale table is one key per line; a line count says nothing about it.
    ignores: ["**/*.test.ts", "**/__tests__/**", "shruti/i18n/**"],
    rules: {
      "max-lines": ["error", { max: 250, skipBlankLines: false, skipComments: false }],
      complexity: ["error", 10],
      "max-depth": ["error", 3],
    },
  },

  // A test is code that ships to nobody, and it reaches for the browser and for
  // the machine it runs on by design.
  {
    files: ["**/*.test.ts", "**/__tests__/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-restricted-properties": "off",
      "no-restricted-syntax": "off",
      "no-restricted-globals": "off",
    },
  }
)

import js from "@eslint/js"
import pluginVue from "eslint-plugin-vue"
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript"
import prettierPlugin from "eslint-plugin-prettier"
import prettierConfig from "eslint-config-prettier"
import globals from "globals"

const isProd = process.env.NODE_ENV === "production"

export default defineConfigWithVueTs(
  {
    ignores: ["dist/**", "android/**", "ios/**", "node_modules/**", "coverage/**", "*.d.ts"],
  },
  js.configs.recommended,
  pluginVue.configs["flat/essential"],
  vueTsConfigs.recommended,
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
    files: ["lectorium/views/**/*.vue", "lectorium/components/**/*.vue"],
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
      "lectorium/components/TrackSheet.vue",
      "lectorium/views/Chat/components/ChatSessionList.vue",
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
            { group: ["@lectorium/*"], message: "Contracts must not import composition root" },
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
    files: ["submodules/domain/**/*.ts"],
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
            { group: ["@lectorium/*"], message: "Domain must not import composition root" },
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
            { group: ["@lectorium/*"], message: "Application must not import composition root" },
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

  // Technical ports: zero imports
  {
    files: ["ports/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@infra/*"], message: "Ports must not import infrastructure" },
            { group: ["@lib/*"], message: "Ports must not import domain/application" },
            { group: ["@ui/*"], message: "Ports must not import UI" },
            { group: ["@lectorium/*"], message: "Ports must not import composition root" },
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
              group: ["@lectorium/*"],
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

  // Infra: may import @ports, @lib/domain, @lib/persistence, @infra/idbKv only.
  // Sibling-infra imports are forbidden — siblings compose only through the
  // composition root. In-house Capacitor plugins from `modules/plugins/` are
  // published under the same `@lectorium` npm scope as the composition root,
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
              group: ["@lectorium/*", "!@lectorium/plugin-*"],
              message: "Infrastructure must not import composition root",
            },
            {
              group: ["@usecases", "@usecases/**"],
              message: "Infrastructure must not import application layer",
            },
            {
              // Allow only @infra/idbKv; every other sibling is forbidden.
              // The negated pattern must come after the broad one.
              group: ["@infra/*", "!@infra/idbKv"],
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
      "no-restricted-imports": [
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
              group: ["@usecases", "@usecases/**"],
              message: "UI must not import application layer",
            },
            { group: ["@lectorium/*"], message: "UI must not import composition root" },
            {
              group: ["@capacitor/*"],
              message: "UI must not import Capacitor SDKs — use a @ports/app port instead",
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
      "no-restricted-imports": [
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
              group: ["@usecases", "@usecases/**"],
              message: "UI must not import application layer",
            },
            { group: ["@lectorium/*"], message: "UI must not import composition root" },
            {
              group: ["@capacitor/*"],
              message: "UI must not import Capacitor SDKs — use a @ports/app port instead",
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
      "no-restricted-imports": [
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
              group: ["@usecases", "@usecases/**"],
              message: "UI must not import application layer",
            },
            { group: ["@lectorium/*"], message: "UI must not import composition root" },
            {
              group: ["@capacitor/*"],
              message: "UI must not import Capacitor SDKs — use a @ports/app port instead",
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
      "no-restricted-imports": [
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
              group: ["@usecases", "@usecases/**"],
              message: "UI must not import application layer",
            },
            { group: ["@lectorium/*"], message: "UI must not import composition root" },
            {
              group: ["@capacitor/*"],
              message: "UI must not import Capacitor SDKs — use a @ports/app port instead",
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
      "no-restricted-imports": [
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
              group: ["@usecases", "@usecases/**"],
              message: "UI must not import application layer",
            },
            { group: ["@lectorium/*"], message: "UI must not import composition root" },
            {
              group: ["@capacitor/*"],
              message: "UI must not import Capacitor SDKs — use a @ports/app port instead",
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
  // is named explicitly — which is why the `lint` script passes `submodules/ui`
  // as a second target. The sibling blocks above (contracts, domain,
  // persistence) are still unenforced for that reason.
  {
    files: ["submodules/ui/**/*.{ts,vue}", "../../libs/ui/**/*.{ts,vue}"],
    rules: {
      "no-restricted-imports": [
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
            { group: ["@lectorium/*"], message: "UI must not import composition root" },
            {
              group: ["@capacitor/*"],
              message: "UI must not import Capacitor SDKs — use a @ports/app port instead",
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
  }
)

import js from "@eslint/js"
import pluginVue from "eslint-plugin-vue"
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript"
import prettierPlugin from "eslint-plugin-prettier"
import prettierConfig from "eslint-config-prettier"
import globals from "globals"

const isProd = process.env.NODE_ENV === "production"

export default defineConfigWithVueTs(
  {
    ignores: [
      "dist/**",
      "android/**",
      "ios/**",
      "node_modules/**",
      "submodules/persistence-*/**",
      "coverage/**",
      "*.d.ts",
    ],
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
      "vue/multi-word-component-names": ["error", { ignores: ["Header", "Message", "Timestamp"] }],
    },
  },

  /* ---- Layer boundary rules ---- */

  // Domain: pure, imports nothing external
  {
    files: ["submodules/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@lib/application/*"], message: "Domain must not import application layer" },
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
    files: ["submodules/application/**/*.ts"],
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
              group: ["@lib/application/*"],
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
            { group: ["@lib/application/*"], message: "UI must not import application layer" },
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
            { group: ["@lib/application/*"], message: "UI must not import application layer" },
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
            { group: ["@lib/application/*"], message: "UI must not import application layer" },
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
            { group: ["@lib/application/*"], message: "UI must not import application layer" },
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
            { group: ["@lib/application/*"], message: "UI must not import application layer" },
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
  }
)

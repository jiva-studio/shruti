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
      "submodules/dal/**",
      "submodules/protocol/**",
      "src/**",
      "patches/**",
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
    files: ["submodules/application/**/*.ts"],
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
            { group: ["@shruti/*"], message: "Ports must not import composition root" },
          ],
        },
      ],
    },
  },

  // Infra: may import @ports, @lib/domain, @lib/persistence, @infra/idb.kv only
  {
    files: ["infra/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@ui/*"], message: "Infrastructure must not import UI" },
            { group: ["@shruti/*"], message: "Infrastructure must not import composition root" },
            {
              group: ["@lib/application/*"],
              message: "Infrastructure must not import application layer",
            },
          ],
        },
      ],
    },
  },

  // UI: no imports from domain/application/ports/infra/composition root
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
            { group: ["@shruti/*"], message: "UI must not import composition root" },
          ],
        },
      ],
    },
  }
)

import js from "@eslint/js"
import pluginVue from "eslint-plugin-vue"
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript"
import prettierPlugin from "eslint-plugin-prettier"
import prettierConfig from "eslint-config-prettier"
import globals from "globals"

const isProd = process.env.NODE_ENV === "production"

export default defineConfigWithVueTs(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "*.d.ts"],
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
      "vue/no-deprecated-slot-attribute": "off",
      "vue/no-deprecated-filter": "off",
      "vue/multi-word-component-names": [
        "error",
        { ignores: ["Header", "Message", "Heatmap", "Badge"] },
      ],
    },
  },

  /* ---- kit layer boundaries ---- */

  // core: pure, framework-agnostic primitives. No framework, no UI, no app code.
  {
    files: ["src/core/**/*.ts"],
    ignores: ["src/core/**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["vue", "vue-router", "@ionic/*", "@capacitor/*", "pinia"],
              message: "kit/core must stay framework-agnostic — no framework/platform imports",
            },
            { group: ["@kit/ui/*", "@kit/infra/*"], message: "core must not import ui/infra" },
          ],
        },
      ],
    },
  },

  // ui: components depend only on props/slots — never i18n, router, or app domain.
  {
    files: ["src/ui/**/*.{ts,vue}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["vue-i18n", "fluent-vue", "@fluent/*", "vue-router"],
              message:
                "kit UI is framework-agnostic: pass text via props/slots, navigation via events — no i18n/router imports",
            },
            { group: ["@kit/infra/*"], message: "kit UI must not import infra" },
          ],
        },
      ],
    },
  },

  // tests may reach anywhere
  {
    files: ["**/__tests__/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  }
)

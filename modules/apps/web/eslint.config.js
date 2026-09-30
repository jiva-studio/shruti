import js from "@eslint/js"
import pluginVue from "eslint-plugin-vue"
import pluginAstro from "eslint-plugin-astro"
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript"
import prettierPlugin from "eslint-plugin-prettier"
import prettierConfig from "eslint-config-prettier"
import globals from "globals"

const swallowedCatch = "handle the error or say in a comment why dropping it is safe"

export default defineConfigWithVueTs(
  {
    ignores: ["dist/**", "node_modules/**", ".astro/**", "src/data/**", "public/data/**", "*.d.ts"],
  },
  js.configs.recommended,
  pluginVue.configs["flat/essential"],
  vueTsConfigs.recommended,
  pluginAstro.configs["flat/recommended"],
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[params.length=0][body.type='BlockStatement'][body.body.length=0]",
          message: swallowedCatch,
        },
        {
          selector:
            "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='Identifier'][body.name='undefined']",
          message: swallowedCatch,
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,ts,vue}"],
    ignores: ["**/__tests__/**"],
    plugins: { prettier: prettierPlugin },
    rules: {
      ...prettierConfig.rules,
      "prettier/prettier": "error",
    },
  }
)

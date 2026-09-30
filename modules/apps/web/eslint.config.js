import js from "@eslint/js"
import pluginVue from "eslint-plugin-vue"
import pluginAstro from "eslint-plugin-astro"
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript"
import prettierPlugin from "eslint-plugin-prettier"
import prettierConfig from "eslint-config-prettier"
import globals from "globals"

const swallowedCatch =
  "handle the error, or disable the rule on that line with the reason dropping it is safe"
const swallowingHandler =
  ":matches(:matches(ArrowFunctionExpression, FunctionExpression)[body.type='BlockStatement'][body.body.length=0], ArrowFunctionExpression[body.type='Literal'], ArrowFunctionExpression[body.type='Identifier'][body.name='undefined'], ArrowFunctionExpression[body.operator='void'][body.argument.type='Literal'])"

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
          selector: `CallExpression[callee.property.name='catch'] > ${swallowingHandler}:nth-child(1)`,
          message: swallowedCatch,
        },
        {
          selector: `CallExpression[callee.property.name='then'] > ${swallowingHandler}:nth-child(2)`,
          message: swallowedCatch,
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,ts,vue}"],
    ignores: ["**/__tests__/**", "**/*.astro/**"],
    plugins: { prettier: prettierPlugin },
    rules: {
      ...prettierConfig.rules,
      "prettier/prettier": "error",
    },
  }
)

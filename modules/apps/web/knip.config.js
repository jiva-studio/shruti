const IGNORED_FILES = {
  "scripts/gen-cta-bg.mjs": "asset generator run by hand when the CTA background changes",
  "scripts/gen-pro-bg.mjs": "asset generator run by hand when the Pro background changes",
  "scripts/gen-sr-cyrl.mjs": "locale generator run by hand, see its header",
}

const IGNORED_DEPENDENCIES = {
  wrangler: "deploy CLI for Cloudflare Pages",
  sharp: "installed by astro; scripts/gen-screenshot-bg.mjs runs inside astro build",
}

const EXCLUDED_ISSUE_TYPES = {
  types: "exported types are component and composable contracts; they erase at build time",
}

export default {
  entry: ["src/vue-app.ts", "scripts/gen-screenshot-bg.mjs", "src/**/__tests__/**/*.test.ts"],
  project: ["src/**/*.{ts,vue,astro,mjs,css}", "scripts/**/*.mjs"],
  paths: { "@lib/*": ["../../libs/*"] },
  ignore: Object.keys(IGNORED_FILES),
  ignoreDependencies: Object.keys(IGNORED_DEPENDENCIES),
  exclude: Object.keys(EXCLUDED_ISSUE_TYPES),
}

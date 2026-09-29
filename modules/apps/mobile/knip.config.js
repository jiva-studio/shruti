const IGNORED_DEPENDENCIES = {
  "@capacitor/status-bar":
    "native plugin, linked by android/capacitor.settings.gradle and the iOS project",
  "capacitor-plugin-safe-area":
    "native plugin, linked by android/capacitor.settings.gradle and the iOS project",
  marked: "imported by modules/libs/ui/markdown, which resolves packages from this app",
  "@babel/core": "pinned toolchain version for @sentry/vite-plugin",
  "@stryker-mutator/core": "run as `npx stryker run` by .github/workflows/quality-metrics.yml",
  "@stryker-mutator/command-runner":
    "bundled with @stryker-mutator/core, named in stryker.config.json",
  "@vue/language-server": "editor tooling for .vue files",
  "typescript-eslint": "installed by @vue/eslint-config-typescript, whose flat config it builds",
  "@ionic/core": "installed by @ionic/vue, whose components it types",
  ionicons: "installed by @ionic/core, whose icon set the app imports",
}

const EXCLUDED_ISSUE_TYPES = {
  types: "exported types are the port and use-case contracts; they erase at build time",
}

export default {
  project: [
    "ports/**/*.{ts,vue}",
    "infra/**/*.{ts,vue}",
    "ui/**/*.{ts,vue}",
    "usecases/**/*.{ts,vue}",
    "shruti/**/*.{ts,vue}",
  ],
  ignoreDependencies: Object.keys(IGNORED_DEPENDENCIES),
  exclude: Object.keys(EXCLUDED_ISSUE_TYPES),
}

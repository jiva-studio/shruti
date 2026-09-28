const TESTS = "(^|/)(__tests__|__mocks__)/|\\.(test|spec)\\.ts$"
const COMPOSITION_ROOT = {
  "shruti/main.ts": "app entry point, constructs every platform adapter",
  "shruti/shruti.ts": "application singleton, owns the adapter instances it hands to stores",
  "shruti/repositories.ts": "AppRepositories factory, binds SQL and HTTP repositories to IDatabase",
  "shruti/services/bootstrap.ts": "startup wiring, runs user-DB migrations before the app mounts",
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const COMPOSITION_ROOT_PATH = `^(${Object.keys(COMPOSITION_ROOT).map(escape).join("|")})$`

module.exports = {
  forbidden: [
    {
      name: "domain-pure",
      severity: "error",
      comment: "@lib/domain depends only on itself, @kit/core and @kit/servers",
      from: { path: "^\\.\\./\\.\\./libs/domain/", pathNot: TESTS },
      to: { pathNot: "^(\\.\\./\\.\\./libs/domain/|\\.\\./\\.\\./kit/src/(core|servers)/)" },
    },
    {
      name: "usecases-pure",
      severity: "error",
      comment:
        "@usecases must not import vue, @ports, @infra, @ui, @shruti, @capacitor or @lib/persistence",
      from: { path: "^usecases/", pathNot: TESTS },
      to: {
        path: [
          "^(ports|infra|ui|shruti)/",
          "^\\.\\./\\.\\./libs/persistence/",
          "(^|/)node_modules/(vue|@vue|vue-router|pinia|@ionic|@capacitor)/",
        ],
      },
    },
    {
      name: "ui-no-domain-or-infra",
      severity: "error",
      comment:
        "ui and @lib/ui must not import domain, contracts, catalog, chat, infra, ports, usecases or Capacitor",
      from: { path: "^(ui|\\.\\./\\.\\./libs/ui)/", pathNot: TESTS },
      to: {
        path: [
          "^\\.\\./\\.\\./libs/(domain|contracts|catalog|chat)/",
          "^(infra|ports|usecases)/",
          "(^|/)node_modules/@capacitor/",
        ],
      },
    },
    {
      name: "protocol-libs-pure",
      severity: "error",
      comment:
        "@lib/chat/stream and @lib/sync run in the app and the site: they import the domain, the wire contracts and each other, nothing else",
      from: { path: "^\\.\\./\\.\\./libs/(chat/stream|sync)/", pathNot: TESTS },
      to: { pathNot: "^\\.\\./\\.\\./libs/(chat/stream|sync|contracts|domain)/" },
    },
    {
      name: "libs-no-apps",
      severity: "error",
      comment: "a library never imports an app",
      from: { path: "^\\.\\./\\.\\./libs/" },
      to: { path: ["^(ports|infra|ui|usecases|shruti)/", "(^|/)apps/", "^\\.\\./(web|mobile)/"] },
    },
    {
      name: "mobile-no-web",
      severity: "error",
      comment: "the app shares code with the site through modules/libs, never by importing it",
      from: { pathNot: ["(^|/)apps/web/", "^\\.\\./web/"] },
      to: { path: ["(^|/)apps/web/", "^\\.\\./web/"] },
    },
    {
      name: "ui-no-composition-root",
      severity: "error",
      comment:
        "ui and @lib/ui are driven by props and events; they never reach the composition root",
      from: { path: "^(ui|\\.\\./\\.\\./libs/ui)/", pathNot: TESTS },
      to: { path: "^shruti/" },
    },
    {
      name: "lib-ui-no-app-ui-or-ionic",
      severity: "error",
      comment: "@lib/ui is rendered by the web app too: no @ui, no @lib/persistence, no Ionic",
      from: { path: "^\\.\\./\\.\\./libs/ui/", pathNot: TESTS },
      to: {
        path: ["^ui/", "^\\.\\./\\.\\./libs/persistence/", "(^|/)node_modules/@ionic/"],
      },
    },
    {
      name: "ui-sublayers-point-down",
      severity: "error",
      comment:
        "primitives, icons and shared import no other UI sub-layer; components import no feature",
      from: { path: "^ui/(primitives|icons|shared|components)/", pathNot: TESTS },
      to: { path: "^ui/features/" },
    },
    {
      name: "ui-leaf-sublayers",
      severity: "error",
      comment: "primitives, icons and shared are leaves of the UI stack",
      from: { path: "^ui/(primitives|icons|shared)/", pathNot: TESTS },
      to: { path: "^ui/(primitives|icons|shared|components)/", pathNot: "^ui/$1/" },
    },
    {
      name: "ui-features-no-siblings",
      severity: "error",
      comment: "a feature does not import another feature; promote the shared widget to components",
      from: { path: "^ui/features/([^/]+)/", pathNot: TESTS },
      to: { path: "^ui/features/[^/]+/", pathNot: "^ui/features/$1/" },
    },
    {
      name: "ports-only-kernel",
      severity: "error",
      comment: "@ports/app imports the shared kernel only",
      from: { path: "^ports/", pathNot: TESTS },
      to: {
        pathNot: ["^ports/", "^\\.\\./\\.\\./kit/src/"],
      },
    },
    {
      name: "infra-no-upward",
      severity: "error",
      comment:
        "an adapter implements a port; it never imports ui, use cases or the composition root",
      from: { path: "^infra/", pathNot: TESTS },
      to: { path: ["^(ui|usecases|shruti)/", "^\\.\\./\\.\\./libs/ui/"] },
    },
    {
      name: "contracts-and-rows-are-leaves",
      severity: "error",
      comment: "@lib/contracts and @lib/persistence import nothing but themselves",
      from: { path: "^\\.\\./\\.\\./libs/(contracts|persistence)/", pathNot: TESTS },
      to: { pathNot: "^\\.\\./\\.\\./libs/$1/" },
    },
    {
      name: "infra-no-siblings",
      severity: "error",
      comment: "an infra adapter must not import another infra adapter",
      from: { path: "^infra/([^/]+)/", pathNot: TESTS },
      to: { path: "^infra/[^/]+/", pathNot: "^infra/$1/" },
    },
    {
      name: "driving-no-infra",
      severity: "error",
      comment: "only the composition root binds an adapter; type-only imports are allowed",
      from: { path: "^shruti/", pathNot: [TESTS, COMPOSITION_ROOT_PATH] },
      to: { path: "^(infra/|\\.\\./\\.\\./kit/src/infra/)", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "state-and-views-no-repositories",
      severity: "error",
      comment: "stores and views call use cases bound in shruti/wiring, not the repository bundle",
      from: { path: "^shruti/(stores|views)/", pathNot: TESTS },
      to: { path: ["^shruti/repositories\\.ts$", "^infra/repositories/"] },
    },
    {
      name: "state-and-views-no-platform-sdk",
      severity: "error",
      comment: "stores and views reach the platform through a port the composition root binds",
      from: { path: "^shruti/(stores|views)/", pathNot: TESTS },
      to: {
        path: "(^|/)node_modules/(@capacitor|@capacitor-community|@capgo|@revenuecat|@shruti)/",
      },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      comment:
        "every relative or aliased import resolves, so no layer rule passes on a path it could not see",
      from: {},
      to: { couldNotResolve: true, path: "^(\\.|@(lib|kit|ports|infra|ui|usecases|shruti)/)" },
    },
  ],
  options: {
    doNotFollow: { path: "(^|/)node_modules/" },
    exclude: { path: "^(dist|android|ios|coverage|\\.stryker-tmp)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".vue", ".js", ".mjs", ".cjs", ".json", ".d.ts"],
    },
    moduleSystems: ["es6", "cjs"],
  },
}

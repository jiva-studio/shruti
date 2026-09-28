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
    exclude: { path: "^(dist|android|ios|coverage)/" },
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

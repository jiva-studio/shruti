module.exports = {
  forbidden: [
    {
      name: "web-no-mobile",
      severity: "error",
      comment: "the web app shares code through modules/libs, never through mobile app internals",
      from: { path: "^(src|scripts)/" },
      to: { path: "(^|/)apps/mobile/|^\\.\\./mobile/" },
    },
    {
      name: "libs-no-apps",
      severity: "error",
      comment: "a shared library reached from the site never imports an app, the site included",
      from: { path: "(^|/)libs/" },
      to: { path: "(^|/)apps/|^(src|scripts)/" },
    },
    {
      name: "web-no-unresolvable",
      severity: "error",
      comment: "every relative or aliased import resolves, except src/data which scripts/sync-catalog.mjs generates",
      from: { path: "^(src|scripts)/" },
      to: { couldNotResolve: true, path: "^(\\.|@lib/|@kit/)", pathNot: "(^|/)data/[^/]+\\.json$" },
    },
  ],
  options: {
    doNotFollow: { path: "(^|/)node_modules/" },
    exclude: { path: "^(dist|\\.astro)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.depcruise.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".vue", ".js", ".mjs", ".cjs", ".json", ".d.ts"],
    },
    moduleSystems: ["es6", "cjs"],
  },
}

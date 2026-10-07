// Bundles the extension host (Node/CommonJS) and the webview (browser/IIFE) with esbuild.
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = !watch;

const targets = [
  {
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
  },
  {
    entryPoints: ["src/webview/main.ts"],
    outfile: "dist/webview.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
  },
];

for (const options of targets) {
  const ctx = await esbuild.context({
    ...options,
    sourcemap: !production,
    minify: production,
    logLevel: "info",
    legalComments: "none",
  });
  if (watch) await ctx.watch();
  else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const cleanOnly = args.includes("--clean-only");
const outDir = "dist";

const sharedOptions = {
  outdir: outDir,
  bundle: true,
  target: "chrome116",
  platform: "browser",
  sourcemap: true,
  logLevel: "info",
};

// Paginas da extensao (popup/offscreen/service worker) carregam como modulos
// ES; o content script e injetado como script classico pelo manifest V3
// (content_scripts nao usa "type": "module"), entao precisa de formato IIFE.
const esmBuildOptions = {
  ...sharedOptions,
  format: "esm",
  entryPoints: [
    { in: "src/background.ts", out: "background" },
    { in: "src/popup/popup.ts", out: "popup" },
    { in: "src/offscreen/offscreen.ts", out: "offscreen" },
    // Worker do @ffmpeg/ffmpeg rebundlado localmente: a CSP de extension_pages
    // no manifest V3 nao permite carregar codigo de fora da extensao.
    { in: "node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js", out: "ffmpeg-worker" },
  ],
};

const contentScriptBuildOptions = {
  ...sharedOptions,
  format: "iife",
  entryPoints: [{ in: "src/content/content.ts", out: "content" }],
};

async function cleanOutDir() {
  if (existsSync(outDir)) await rm(outDir, { recursive: true, force: true });
  await mkdir(`${outDir}/ffmpeg`, { recursive: true });
}

async function copyStaticFiles() {
  await cp("manifest.json", `${outDir}/manifest.json`);
  await cp("src/popup/popup.html", `${outDir}/popup.html`);
  await cp("src/offscreen/offscreen.html", `${outDir}/offscreen.html`);
  await cp("node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js", `${outDir}/ffmpeg/ffmpeg-core.js`);
  await cp("node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm", `${outDir}/ffmpeg/ffmpeg-core.wasm`);
}

async function run() {
  await cleanOutDir();
  if (cleanOnly) {
    console.log(`${outDir}/ limpo.`);
    return;
  }

  await copyStaticFiles();

  if (watch) {
    const contexts = await Promise.all([context(esmBuildOptions), context(contentScriptBuildOptions)]);
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log(`Observando alteracoes (saida: ${outDir}/)...`);
    return;
  }

  await Promise.all([build(esmBuildOptions), build(contentScriptBuildOptions)]);
  console.log(`Build concluido em ./${outDir}`);
}

run().catch((error) => {
  console.error("Falha no build:", error);
  process.exitCode = 1;
});

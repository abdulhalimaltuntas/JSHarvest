#!/usr/bin/env node
// build.mjs
// Tek kaynaktan iki paket uretir: dist/chrome ve dist/firefox.
//
// Tek fark manifest'tir:
//   Chrome  -> background.service_worker (Firefox desteklemiyor)
//   Firefox -> background.scripts + browser_specific_settings (Chrome reddediyor)
//
// Derleme, paketleme, bagimlilik yok — yalnizca kopyalama ve manifest secimi.
// Kullanim: node build.mjs

import { cp, mkdir, rm, copyFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

/** Her iki pakete de giren dosya ve dizinler. */
const SHARED = ['background', 'content', 'lib', 'popup', 'panel', 'options', 'styles', 'icons'];

const TARGETS = [
  { name: 'chrome', manifest: 'manifest.json' },
  { name: 'firefox', manifest: 'manifest.firefox.json' }
];

async function assertValidJson(path) {
  const text = await readFile(path, 'utf8');
  JSON.parse(text); // gecersizse burada patlar
}

async function buildTarget({ name, manifest }) {
  const outDir = join(dist, name);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const entry of SHARED) {
    await cp(join(root, entry), join(outDir, entry), { recursive: true });
  }

  const manifestPath = join(root, manifest);
  await assertValidJson(manifestPath);
  await copyFile(manifestPath, join(outDir, 'manifest.json'));

  console.log(`  dist/${name}  <-  ${manifest}`);
}

async function main() {
  console.log('JSHarvest build');
  for (const target of TARGETS) {
    await buildTarget(target);
  }
  console.log('\nChrome : chrome://extensions -> Load unpacked -> dist/chrome');
  console.log('         (proje kokunu dogrudan yuklemek de calisir)');
  console.log('Firefox: about:debugging#/runtime/this-firefox -> Load Temporary Add-on');
  console.log('         -> dist/firefox/manifest.json');
  console.log('         Ardindan about:addons -> JSHarvest -> Permissions ->');
  console.log('         "Access your data for all websites" izni verilmeli.');
}

main().catch((err) => {
  console.error('build failed:', err);
  process.exit(1);
});

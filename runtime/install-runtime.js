#!/usr/bin/env node
/*
 * Runtime patcher installer.
 *
 *   node runtime/install-runtime.js --dir "D:\Program Files\ZCode" [--poc]
 *
 * Layout after install:
 *   resources/app/                  extracted asar (bundles stay pristine)
 *   resources/app.asar.pristine     original asar, kept for restore
 *   resources/app/package.json      main -> ./out/.zcode-runtime/bootstrap.mjs
 *   resources/app/out/.zcode-runtime/  bootstrap + shims + specs + runtime.log
 *
 * ESM bundles (main/host/scheduler) and renderer assets are transformed at
 * load time. Preload bundles and resources/glm/zcode.cjs cannot be intercepted
 * at load time (preloads bypass the protocol stack; glm is a spawned CLI
 * bundle), so they are flat-patched here at install time.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const core = require('../patch-core.cjs');

const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
if (dirIdx < 0 || !args[dirIdx + 1]) {
  console.error('usage: node runtime/install-runtime.js --dir <ZCode install> [--poc]');
  process.exit(1);
}
const INSTALL = path.resolve(args[dirIdx + 1]);
const POC = args.includes('--poc');
const REPO = path.resolve(__dirname, '..');

const fail = message => { console.error(`install-runtime: ${message}`); process.exit(1); };

const resources = path.join(INSTALL, 'resources');
const appDir = path.join(resources, 'app');
const asarPath = path.join(resources, 'app.asar');

// --restore: remove the extracted app dir, bring back the pristine asar, and
// restore the glm CLI bundle. Run with ZCode closed.
if (args.includes('--restore')) {
  const pristine = `${asarPath}.pristine`;
  if (!fs.existsSync(pristine)) fail(`no ${pristine} — runtime mode is not installed here`);
  if (fs.existsSync(appDir)) {
    fs.rmSync(appDir, { recursive: true, force: true });
    console.log('removed resources/app');
  }
  fs.renameSync(pristine, asarPath);
  console.log('app.asar.pristine -> app.asar');
  const glmRt = path.join(resources, 'glm', 'zcode.cjs.rt-pristine');
  if (fs.existsSync(glmRt)) {
    fs.copyFileSync(glmRt, path.join(resources, 'glm', 'zcode.cjs'));
    fs.rmSync(glmRt);
    console.log('restored resources/glm/zcode.cjs');
  }
  console.log('runtime patcher removed');
  process.exit(0);
}

if (!fs.existsSync(appDir)) {
  if (!fs.existsSync(asarPath)) fail(`no resources/app or resources/app.asar under ${INSTALL}`);
  console.log('extracting app.asar -> resources/app ...');
  asar.extractAll(asarPath, appDir);
}
if (fs.existsSync(asarPath)) {
  fs.renameSync(asarPath, `${asarPath}.pristine`);
  console.log('app.asar -> app.asar.pristine');
}

const pkgPath = path.join(appDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
if (!version) fail('resources/app/package.json has no version');

const profileDir = path.join(REPO, 'profiles', version);
const profilePath = path.join(profileDir, 'profile.json');
if (!fs.existsSync(profilePath)) fail(`no verified profile for ZCode ${version}`);
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
profile.appSpec = JSON.parse(fs.readFileSync(path.join(profileDir, 'patch-spec.json'), 'utf8'));
profile.glmSpec = JSON.parse(fs.readFileSync(path.join(profileDir, 'glm-spec.json'), 'utf8'));
const registry = JSON.parse(fs.readFileSync(path.join(REPO, 'transforms', 'registry.json'), 'utf8'));
const instancesBySpan = core.buildTransformInstances(profile, registry);

const findByMarker = (directory, marker) => {
  const dir = path.join(appDir, directory);
  const matches = fs.readdirSync(dir).filter(f => f.endsWith('.js'))
    .map(f => path.join(dir, f))
    .filter(f => fs.readFileSync(f, 'utf8').includes(marker));
  if (matches.length !== 1) fail(`marker "${marker}" matched ${matches.length} files in ${directory}`);
  return matches[0];
};

const esmTargets = {};
const rendererTargets = [];
const preloadTargets = [];
for (const target of profile.targets) {
  const filePath = target.path
    ? path.join(appDir, target.path)
    : findByMarker(target.resolver.directory, target.resolver.marker);
  if (!fs.existsSync(filePath)) fail(`target ${target.id} not found: ${filePath}`);
  const rel = path.relative(appDir, filePath);
  const entry = { specKey: target.specKey, targetId: target.id, postconditions: target.postconditions || [] };
  if (rel.startsWith(`out${path.sep}preload${path.sep}`)) {
    preloadTargets.push({ rel, filePath, ...entry });
  } else if (rel.startsWith(`out${path.sep}renderer${path.sep}`)) {
    rendererTargets.push({ marker: target.resolver.marker, ...entry });
  } else {
    esmTargets[rel.split(path.sep).join('/')] = entry;
  }
}

// Flat-patch preload bundles and the glm CLI bundle (strict at install time).
const flatPatch = (filePath, spans, targetKey, postconditions, label) => {
  const text = fs.readFileSync(filePath, 'utf8');
  let result;
  try {
    result = core.applySpansText(text, spans, instancesBySpan, targetKey, { strict: true, label });
  } catch (error) {
    if (postconditions.every(v => text.includes(v))) {
      console.log(`  already patched, skipped: ${label}`);
      return;
    }
    throw error;
  }
  const missing = postconditions.filter(v => !result.text.includes(v));
  if (missing.length) fail(`${label} missing postconditions after patch: ${missing.join(', ')}`);
  if (!fs.existsSync(`${filePath}.rt-pristine`)) fs.writeFileSync(`${filePath}.rt-pristine`, text);
  fs.writeFileSync(filePath, result.text);
  console.log(`  flat-patched: ${label}`);
};

console.log('flat-patching preload bundles...');
for (const target of preloadTargets) {
  flatPatch(target.filePath, profile.appSpec[target.specKey], target.targetId,
    target.postconditions, target.targetId);
}
const glmPath = path.join(INSTALL, profile.glm.path);
if (!fs.existsSync(glmPath)) fail(`glm bundle not found: ${glmPath}`);
flatPatch(glmPath, profile.glmSpec.spans, 'glm',
  [profile.glm.marker, ...profile.glm.postconditions], 'glm');

const rtDir = path.join(appDir, 'out', '.zcode-runtime');
fs.mkdirSync(rtDir, { recursive: true });
for (const file of ['bootstrap.mjs', 'utility-shim.mjs', 'loader-hooks.mjs']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(rtDir, file));
}
fs.copyFileSync(path.join(REPO, 'patch-core.cjs'), path.join(rtDir, 'patch-core.cjs'));
fs.writeFileSync(path.join(rtDir, 'runtime-profile.json'), JSON.stringify(profile));
fs.writeFileSync(path.join(rtDir, 'registry.json'), JSON.stringify(registry));

const utilityEntries = ['host.main', 'scheduler.models']
  .map(id => profile.targets.find(t => t.id === id))
  .filter(Boolean)
  .map(t => t.path);
const originalMain = typeof pkg.main === 'string' && !pkg.main.includes('.zcode-runtime')
  ? pkg.main.replace(/^\.\//, '') : 'out/main/index.js';
fs.writeFileSync(path.join(rtDir, 'config.json'), JSON.stringify({
  version, profileId: profile.id, poc: POC,
  appRoot: appDir,
  logPath: path.join(rtDir, 'runtime.log'),
  profilePath: path.join(rtDir, 'runtime-profile.json'),
  registryPath: path.join(rtDir, 'registry.json'),
  originalMain,
  utilityEntries,
  esmTargets,
  rendererTargets,
}, null, 2));

pkg.main = './out/.zcode-runtime/bootstrap.mjs';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

console.log(`runtime patcher installed for ZCode ${version} (profile ${profile.id})`);
console.log(`  esm targets: ${Object.keys(esmTargets).length}, renderer targets: ${rendererTargets.length}, ` +
  `flat-patched: ${preloadTargets.length} preload + glm`);
console.log(`  log: ${path.join(rtDir, 'runtime.log')}`);

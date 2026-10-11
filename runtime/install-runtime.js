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
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
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
const pristineAsar = `${asarPath}.pristine`;

function targetZCodeRunning() {
  if (process.platform !== 'win32' || POC) return false;
  const exe = path.join(INSTALL, 'ZCode.exe').replace(/'/g, "''");
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$target=[IO.Path]::GetFullPath('${exe}').ToLowerInvariant();` +
    `(Get-CimInstance Win32_Process | Where-Object {` +
    ` $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq $target } | Measure-Object).Count`],
  { encoding: 'utf8', windowsHide: true });
  return result.status === 0 && Number.parseInt(result.stdout.trim(), 10) > 0;
}

if (targetZCodeRunning()) {
  fail('the target ZCode installation is still running. Exit it from the tray, then rerun this command.');
}

// --restore: remove the extracted app dir, bring back the pristine asar, and
// restore the glm CLI bundle. Run with ZCode closed.
if (args.includes('--restore')) {
  if (!fs.existsSync(pristineAsar)) fail(`no ${pristineAsar} — runtime mode is not installed here`);
  if (fs.existsSync(appDir)) {
    fs.rmSync(appDir, { recursive: true, force: true });
    console.log('removed resources/app');
  }
  fs.renameSync(pristineAsar, asarPath);
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

const extractAsar = (archive, dest) => {
  // Extract beside the target and rename, so a failed extraction never leaves
  // a partial resources/app that a later rerun would mistake for complete.
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    asar.extractAll(archive, tmp);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
};

// An official update drops a new app.asar next to the previously extracted
// resources/app. That extraction is stale at that point (and wins over the
// asar at Electron launch), so rebuild it from the new asar — but only after
// confirming the new version has a profile, leaving the install untouched
// otherwise.
if (fs.existsSync(appDir) && fs.existsSync(asarPath)) {
  const updatedVersion = JSON.parse(asar.extractFile(asarPath, 'package.json').toString()).version;
  if (!fs.existsSync(path.join(REPO, 'profiles', updatedVersion || '', 'profile.json'))) {
    fail(`no verified profile for ZCode ${updatedVersion} — the official update was left untouched; rerun after this repo supports it`);
  }
  console.log(`official update detected: re-extracting ZCode ${updatedVersion} (stale ${JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version} extraction removed)`);
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.rmSync(pristineAsar, { force: true });
}
if (!fs.existsSync(appDir)) {
  if (!fs.existsSync(asarPath)) fail(`no resources/app or resources/app.asar under ${INSTALL}`);
  console.log('extracting app.asar -> resources/app ...');
  extractAsar(asarPath, appDir);
}
if (fs.existsSync(asarPath)) {
  fs.rmSync(pristineAsar, { force: true });
  fs.renameSync(asarPath, pristineAsar);
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
  const backupPath = `${filePath}.rt-pristine`;
  const current = fs.readFileSync(filePath, 'utf8');
  // Reinstalls must rebuild from pristine so a newer profile can add or change
  // spans without being blocked by the previous profile's replacements.
  const text = fs.existsSync(backupPath) ? fs.readFileSync(backupPath, 'utf8') : current;
  let result;
  try {
    result = core.applySpansText(text, spans, instancesBySpan, targetKey, { strict: true, label });
  } catch (error) {
    if (!fs.existsSync(backupPath) && postconditions.every(v => current.includes(v))) {
      console.log(`  already patched without runtime backup, skipped: ${label}`);
      return;
    }
    throw error;
  }
  const missing = postconditions.filter(v => !result.text.includes(v));
  if (missing.length) fail(`${label} missing postconditions after patch: ${missing.join(', ')}`);
  if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, text);
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
const glmRt = `${glmPath}.rt-pristine`;
if (fs.existsSync(glmRt) && !fs.readFileSync(glmPath, 'utf8').includes(profile.glm.marker)) {
  // The official updater replaced the glm bundle, so the saved pristine belongs
  // to the previous version. Rebase it on the new official file before patching.
  fs.copyFileSync(glmPath, glmRt);
  console.log('  refreshed glm pristine from the updated official bundle');
}
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
const generation = `${Date.now()}-${randomUUID()}`;
fs.writeFileSync(path.join(rtDir, 'config.json'), JSON.stringify({
  version, profileId: profile.id, generation, poc: POC,
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
console.log(`  generation: ${generation}`);
console.log(`  log: ${path.join(rtDir, 'runtime.log')}`);
console.log('  restart ZCode before running verify-runtime.js');

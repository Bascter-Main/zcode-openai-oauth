#!/usr/bin/env node
/*
 * ZCode OpenAI OAuth patcher
 *
 * One command: adds a built-in OpenAI provider family (ChatGPT subscription
 * OAuth login) to the ZCode desktop app.
 *
 *   node patch.js               patch, deploy, restart ZCode
 *   node patch.js --dry-run     verify all anchors match; write nothing
 *   node patch.js --dir <path>  use a custom ZCode install directory
 *   node patch.js --restore     restore the pristine backup and restart
 *
 * Upgrade resilience: every patch is a content anchor (no hardcoded bundle
 * hashes or byte offsets). Hashed bundle names (styles-*.js etc.) are resolved
 * by scanning for stable content markers. After a ZCode upgrade, just run the
 * patcher again; if some anchor no longer matches, the run aborts with a list
 * of failed anchors and leaves the installation untouched.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const asar = require('@electron/asar');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const NO_DEPLOY = args.includes('--no-deploy');
const RESTORE = args.includes('--restore');
const dirIdx = args.indexOf('--dir');
const INSTALL = dirIdx >= 0 ? args[dirIdx + 1] : findInstall();
const ASAR = path.join(INSTALL, 'resources', 'app.asar');
const BACKUP = path.join(INSTALL, 'resources', 'app.asar.bak-pristine');
const GLM = path.join(INSTALL, 'resources', 'glm', 'zcode.cjs');
const GLM_BAK = path.join(INSTALL, 'resources', 'glm', 'zcode.cjs.bak-pristine');
const BACKUP_META = path.join(INSTALL, 'resources', 'app.asar.bak-pristine.json');

function findInstall() {
  const cands = [
    'D:\\Program Files\\ZCode',
    'C:\\Program Files\\ZCode',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode'),
  ];
  for (const c of cands) if (fs.existsSync(path.join(c, 'resources', 'app.asar'))) return c;
  throw new Error('ZCode install not found; pass --dir <path>');
}

function fail(msg) {
  console.error('\n[FAIL] ' + msg);
  process.exit(1);
}

function packageVersion(asarPath) {
  try {
    return JSON.parse(asar.extractFile(asarPath, 'package.json').toString()).version || '';
  } catch {
    return '';
  }
}

function readBackupVersion() {
  try {
    return JSON.parse(fs.readFileSync(BACKUP_META, 'utf8')).version || '';
  } catch {
    return '';
  }
}

function usableBackup(version) {
  return fs.existsSync(BACKUP) && readBackupVersion() === version;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function zcodeRunning() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe'], { encoding: 'utf8' });
  return !!(r.stdout && r.stdout.includes('ZCode.exe'));
}

function killZCode() {
  if (process.platform !== 'win32') return;
  spawnSync('taskkill', ['/F', '/IM', 'ZCode.exe'], { stdio: 'ignore' });
  for (let i = 0; i < 20 && zcodeRunning(); i++) sleepMs(500);
}

function startZCode() {
  const exe = path.join(INSTALL, 'ZCode.exe');
  if (!fs.existsSync(exe)) return;
  const { spawn } = require('child_process');
  const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
  child.unref();
}

function restore() {
  let ok = false;
  killZCode();
  const version = packageVersion(ASAR);
  if (usableBackup(version)) { fs.copyFileSync(BACKUP, ASAR); ok = true; }
  if (fs.existsSync(GLM_BAK)) { fs.copyFileSync(GLM_BAK, GLM); ok = true; }
  if (!ok) fail('no version-matching backups found (nothing was ever patched for this ZCode version?)');
  console.log('[OK] restored pristine app.asar and glm/zcode.cjs');
  startZCode();
}

function applySpans(filePath, spans, label) {
  let s = fs.readFileSync(filePath, 'utf8');
  const bad = [];
  for (let i = 0; i < spans.length; i++) {
    const n = s.split(spans[i].find).length - 1;
    if (n !== 1) { bad.push({ span: i, matches: n }); continue; }
    s = s.split(spans[i].find).join(spans[i].replace);
  }
  if (bad.length) {
    fail(label + ': ' + bad.length + '/' + spans.length +
      ' anchors failed to match uniquely (this ZCode version changed the patched code). ' +
      'Nothing was written. Please open an issue with your ZCode version.');
  }
  fs.writeFileSync(filePath, s);
}

function syntaxCheck(filePath) {
  const r = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  if (r.status !== 0) fail('syntax check failed after patching: ' + filePath + '\n' + r.stderr);
}

// Hashed bundle names change every release; find each logical bundle by a
// stable content marker. Keep the prefix as a sanity check, but never depend
// on the exact hash or on short minified function names.
function findByMarker(dir, prefix, marker) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith(prefix)) continue;
    const p = path.join(dir, f);
    if (fs.readFileSync(p, 'utf8').includes(marker)) return p;
  }
  fail('no bundle matching ' + prefix + '* containing marker "' + marker + '" in ' + dir);
}

function findJsByMarker(dir, marker) {
  const matches = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const p = path.join(dir, f);
    if (fs.readFileSync(p, 'utf8').includes(marker)) matches.push(p);
  }
  if (matches.length === 1) return matches[0];
  fail('expected exactly one bundle containing marker "' + marker + '" in ' + dir + ', found ' + matches.length);
}

async function main() {
  if (RESTORE) return restore();
  console.log('ZCode install:', INSTALL);
  if (!fs.existsSync(ASAR)) fail('app.asar not found at ' + ASAR);
  if (!fs.existsSync(GLM)) fail('resources/glm/zcode.cjs not found');

  // idempotent: if a previous patched build is present, restore the matching pristine backup first
  const appVersion = packageVersion(ASAR);
  if (!DRY && usableBackup(appVersion)) {
    const cur = fs.readFileSync(ASAR);
    if (cur.includes('OpenAiOAuthAdapter')) {
      console.log('previous patched build detected; restoring version-matching pristine backup first...');
      killZCode();
      fs.copyFileSync(BACKUP, ASAR);
    }
  }
  if (!DRY && fs.existsSync(GLM_BAK)) {
    if (fs.readFileSync(GLM, 'utf8').includes('chatgpt.com')) {
      fs.copyFileSync(GLM_BAK, GLM);
    }
  }

  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'patch-spec.json'), 'utf8'));
  const glmSpec = JSON.parse(fs.readFileSync(path.join(__dirname, 'glm-spec.json'), 'utf8'));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-openai-'));
  console.log('extracting app.asar ->', work);
  asar.extractAll(ASAR, work);

  const assets = path.join(work, 'out', 'renderer', 'assets');
  const resolve = {
    'out/renderer/assets/styles-C2WGZ-SY.js': () =>
      findJsByMarker(assets, 'function SLt({selectedNavItem:e'),
    'out/renderer/assets/src-C3so_Fno.js': () =>
      findJsByMarker(assets, 'rootDomain:`z.ai`'),
    'out/host/chunk-EGJBTUMC.js': () =>
      findJsByMarker(path.join(work, 'out', 'host'), 'convertModelProviderConfigToZCodeProviderInput'),
  };

  for (const [rel, spans] of Object.entries(spec)) {
    const target = resolve[rel] ? resolve[rel]() : path.join(work, rel);
    if (!fs.existsSync(target)) fail('missing expected file: ' + rel);
    if (DRY) {
      const s = fs.readFileSync(target, 'utf8');
      const bad = spans.filter(sp => s.split(sp.find).length - 1 !== 1);
      if (bad.length) fail(rel + ': ' + bad.length + '/' + spans.length + ' anchors do not match this ZCode version');
      console.log('[ok] ' + rel + ': ' + spans.length + ' anchors');
    } else {
      applySpans(target, spans, rel);
      syntaxCheck(target);
      console.log('[patched] ' + rel + ': ' + spans.length + ' spans');
    }
  }

  if (DRY) {
    const s = fs.readFileSync(GLM, 'utf8');
    const bad = glmSpec.spans.filter(sp => s.split(sp.find).length - 1 !== 1);
    if (bad.length) fail('glm/zcode.cjs: ' + bad.length + '/' + glmSpec.spans.length + ' anchors do not match');
    console.log('[ok] resources/glm/zcode.cjs: ' + glmSpec.spans.length + ' anchors');
    console.log('\ndry-run: all anchors match.');
    fs.rmSync(work, { recursive: true, force: true });
    return;
  }

  if (!fs.existsSync(GLM_BAK)) fs.copyFileSync(GLM, GLM_BAK);
  applySpans(GLM, glmSpec.spans, 'zcode.cjs');
  syntaxCheck(GLM);
  console.log('[patched] resources/glm/zcode.cjs: ' + glmSpec.spans.length + ' spans');

  console.log('packing app.asar...');
  const out = ASAR + '.patched';
  await asar.createPackageWithOptions(work, out, { unpackDir: '**/{node-pty,ssh2}/**' });
  fs.rmSync(work, { recursive: true, force: true });

  if (NO_DEPLOY) {
    console.log('[packed] ' + out + ' (deploy skipped)');
    return;
  }

  console.log('closing ZCode...');
  killZCode();
  if (!usableBackup(appVersion)) {
    fs.copyFileSync(ASAR, BACKUP);
    fs.writeFileSync(BACKUP_META, JSON.stringify({ version: appVersion, savedAt: new Date().toISOString() }, null, 2) + '\n');
  }
  fs.copyFileSync(out, ASAR);
  // verify the swap landed byte-for-byte before restarting
  const a = fs.readFileSync(ASAR), b = fs.readFileSync(out);
  if (a.length !== b.length || !a.equals(b)) fail('deploy verification failed (app.asar differs from packed output). Re-run patch.bat.');
  fs.rmSync(out, { force: true });
  console.log('[deployed] app.asar (pristine backup kept as app.asar.bak-pristine)');
  startZCode();
  console.log('\nDone. ZCode restarted. Open Settings -> Model Providers -> OpenAI -> Connect.');
}

main().catch(e => fail(e && e.stack || String(e)));

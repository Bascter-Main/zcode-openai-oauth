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

const asar = require(path.join(__dirname, 'tools', 'node_modules', '@electron', 'asar'));

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
  if (fs.existsSync(exe)) {
    const child = spawnSync('cmd', ['/c', 'start', 'ZCode', exe], { stdio: 'ignore' });
    child && child.unref && child.unref();
  }
}

function restore() {
  let ok = false;
  killZCode();
  if (fs.existsSync(BACKUP)) { fs.copyFileSync(BACKUP, ASAR); ok = true; }
  if (fs.existsSync(GLM_BAK)) { fs.copyFileSync(GLM_BAK, GLM); ok = true; }
  if (!ok) fail('no backups found (nothing was ever patched?)');
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

// hashed bundle names change every release; find by a stable content marker
function findByMarker(dir, prefix, marker) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith(prefix)) continue;
    const p = path.join(dir, f);
    if (fs.readFileSync(p, 'utf8').includes(marker)) return p;
  }
  fail('no bundle matching ' + prefix + '* containing marker "' + marker + '" in ' + dir);
}

async function main() {
  if (RESTORE) return restore();
  console.log('ZCode install:', INSTALL);
  if (!fs.existsSync(ASAR)) fail('app.asar not found at ' + ASAR);
  if (!fs.existsSync(GLM)) fail('resources/glm/zcode.cjs not found');

  // idempotent: if a previous patched build is present, restore pristine first
  if (!DRY && fs.existsSync(BACKUP)) {
    const cur = fs.readFileSync(ASAR);
    if (cur.includes('OpenAiOAuthAdapter')) {
      console.log('previous patched build detected; restoring pristine backup first...');
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

  const resolve = {
    'out/renderer/assets/styles-C2WGZ-SY.js': () =>
      findByMarker(path.join(work, 'out', 'renderer', 'assets'), 'styles-', 'function Sz({providers:'),
    'out/renderer/assets/src-C3so_Fno.js': () =>
      findByMarker(path.join(work, 'out', 'renderer', 'assets'), 'src-', 'rootDomain:`z.ai`'),
    'out/host/chunk-EGJBTUMC.js': () =>
      findByMarker(path.join(work, 'out', 'host'), 'chunk-', 'convertModelProviderConfigToZCodeProviderInput'),
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
  if (!fs.existsSync(BACKUP)) fs.copyFileSync(ASAR, BACKUP);
  fs.copyFileSync(out, ASAR);
  fs.rmSync(out, { force: true });
  console.log('[deployed] app.asar (pristine backup kept as app.asar.bak-pristine)');
  startZCode();
  console.log('\nDone. ZCode restarted. Open Settings -> Model Providers -> OpenAI -> Connect.');
}

main().catch(e => fail(e && e.stack || String(e)));

// Runtime patcher bootstrap, installed as resources/app package.json main.
// Intercepts the three version-stable surfaces (utilityProcess.fork, module
// loader hooks, the file protocol) and hands off to the real entry. Every
// patch is fail-soft: on any deviation the pristine code runs instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, register } from 'node:module';
import { createHash } from 'node:crypto';
import { app, utilityProcess, protocol } from 'electron';

const RT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(RT_DIR, '..', '..');

const require = createRequire(import.meta.url);
const core = require('./patch-core.cjs');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

const norm = p => {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
};

let config = null;
try {
  config = JSON.parse(fs.readFileSync(path.join(RT_DIR, 'config.json'), 'utf8'));
} catch {}

const log = entry => {
  if (!config) return;
  try { fs.appendFileSync(config.logPath, JSON.stringify(entry) + '\n'); } catch {}
};

async function handoff() {
  const main = config && config.originalMain ? config.originalMain : 'out/main/index.js';
  await import(pathToFileURL(path.join(APP_ROOT, main)).href);
}

if (!config) {
  await handoff();
} else {
  log({ event: 'bootstrap', pid: process.pid, version: config.version });

  // PoC only: survive the single-instance forward while a second ZCode runs.
  if (config.poc) {
    app.quit = () => log({ event: 'quit-swallowed', pid: process.pid });
  }

  // host/scheduler: swap the forked entry for the shim
  const shimPath = path.join(RT_DIR, 'utility-shim.mjs');
  const configPath = path.join(RT_DIR, 'config.json');
  const utilityEntries = new Set(config.utilityEntries.map(rel => norm(path.join(APP_ROOT, rel))));
  const origFork = utilityProcess.fork.bind(utilityProcess);
  utilityProcess.fork = function (mod, args, opts) {
    if (utilityEntries.has(norm(String(mod)))) {
      opts = Object.assign({}, opts);
      opts.env = Object.assign({}, opts.env, {
        ZCODE_RT_CONFIG: configPath,
        ZCODE_RT_REAL: String(mod),
      });
      log({ event: 'utility-entry-swap', mod: path.basename(String(mod)) });
      return origFork(shimPath, args, opts);
    }
    return origFork(mod, args, opts);
  };

  // main process ESM transforms
  try {
    register(new URL('./loader-hooks.mjs', import.meta.url), {
      parentURL: import.meta.url,
      data: { configPath },
    });
  } catch (error) {
    log({ event: 'register-error', error: String(error) });
  }

  // renderer: rewrite bundle responses on the file protocol
  const profile = JSON.parse(fs.readFileSync(config.profilePath, 'utf8'));
  const registry = JSON.parse(fs.readFileSync(config.registryPath, 'utf8'));
  const instancesBySpan = core.buildTransformInstances(profile, registry);
  const rendererCache = new Map();

  const transformRenderer = (filePath, text) => {
    if (rendererCache.has(filePath)) return rendererCache.get(filePath);
    let out = null;
    for (const target of config.rendererTargets) {
      if (!text.includes(target.marker)) continue;
      const spans = profile.appSpec[target.specKey];
      const result = core.applySpansText(text, spans, instancesBySpan, target.targetId,
        { strict: false, label: target.targetId });
      const invariant = result.failures.length === 0
        ? core.criticalTargetSemanticIssue(target.targetId, result.text) : 'span failures';
      const entry = {
        event: 'renderer-target', targetId: target.targetId, file: path.basename(filePath),
        spans: spans.length,
        applied: result.levels.filter(level => level.level !== 'failed').length,
        failures: result.failures,
        missingPostconditions: (target.postconditions || []).filter(v => !result.text.includes(v)),
        invariant,
        sha256: createHash('sha256').update(result.text).digest('hex'),
      };
      if (result.failures.length === 0 && !invariant) {
        entry.delivered = 'patched';
        out = result.text;
      } else {
        entry.delivered = 'pristine';
      }
      log(entry);
      break;
    }
    rendererCache.set(filePath, out);
    return out;
  };

  app.whenReady().then(() => {
    try {
      protocol.handle('file', req => {
        let filePath;
        try { filePath = fileURLToPath(new URL(req.url)); } catch {
          return new Response('bad request', { status: 400 });
        }
        let body;
        try { body = fs.readFileSync(filePath); } catch {
          return new Response('not found', { status: 404 });
        }
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.js' && norm(filePath).includes(norm(`${path.sep}out${path.sep}renderer${path.sep}`))) {
          const transformed = transformRenderer(filePath, body.toString('utf8'));
          if (transformed !== null) body = Buffer.from(transformed, 'utf8');
        }
        return new Response(body, { headers: { 'content-type': MIME[ext] || 'application/octet-stream' } });
      });
      log({ event: 'protocol-registered' });
    } catch (error) {
      log({ event: 'protocol-error', error: String(error) });
    }
  });

  await handoff();
}

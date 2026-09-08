// Runtime loader hooks (module.register). Runs in Node's loader thread of the
// main process and of each shimmed utility process. Fail-soft: any deviation
// (span mismatch, failed invariant) delivers the pristine module instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const core = require('./patch-core.cjs');

let targets = null;
let logPath = null;

const norm = p => {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
};

function log(entry) {
  try { fs.appendFileSync(logPath, JSON.stringify(entry) + '\n'); } catch {}
}

export async function initialize(data) {
  const config = JSON.parse(fs.readFileSync(data.configPath, 'utf8'));
  logPath = config.logPath;
  const profile = JSON.parse(fs.readFileSync(config.profilePath, 'utf8'));
  const registry = JSON.parse(fs.readFileSync(config.registryPath, 'utf8'));
  const instancesBySpan = core.buildTransformInstances(profile, registry);
  targets = new Map();
  for (const [rel, target] of Object.entries(config.esmTargets)) {
    targets.set(norm(path.join(config.appRoot, rel)), {
      targetId: target.targetId,
      spans: profile.appSpec[target.specKey],
      postconditions: target.postconditions || [],
      instancesBySpan,
    });
  }
  log({ event: 'hooks-init', pid: process.pid, targets: targets.size });
}

export async function load(url, context, nextLoad) {
  if (targets && url.startsWith('file:')) {
    let filePath;
    try { filePath = fileURLToPath(url); } catch { return nextLoad(url, context); }
    const target = targets.get(norm(filePath));
    if (target) {
      try {
        const source = fs.readFileSync(filePath, 'utf8');
        const result = core.applySpansText(source, target.spans, target.instancesBySpan,
          target.targetId, { strict: false, label: target.targetId });
        const invariant = result.failures.length === 0
          ? core.criticalTargetSemanticIssue(target.targetId, result.text)
          : 'span failures';
        const entry = {
          event: 'esm-target', targetId: target.targetId, file: path.basename(filePath),
          pid: process.pid, spans: target.spans.length,
          applied: result.levels.filter(level => level.level !== 'failed').length,
          failures: result.failures,
          missingPostconditions: target.postconditions.filter(v => !result.text.includes(v)),
          invariant,
          sha256: createHash('sha256').update(result.text).digest('hex'),
        };
        if (result.failures.length === 0 && !invariant) {
          entry.delivered = 'patched';
          log(entry);
          return { format: 'module', source: result.text, shortCircuit: true };
        }
        entry.delivered = 'pristine';
        log(entry);
      } catch (error) {
        log({ event: 'esm-target-error', targetId: target.targetId, error: String(error) });
      }
    }
  }
  return nextLoad(url, context);
}

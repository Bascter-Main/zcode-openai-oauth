#!/usr/bin/env node
/*
 * Runtime delivery verifier.
 *
 *   node runtime/verify-runtime.js --dir <ZCode install>
 *
 * Computes the expected transform output for every runtime target (strict
 * mode over the pristine on-disk bundles) and compares it with what the
 * running app actually delivered, as recorded in runtime.log. Exit code is
 * non-zero on any mismatch, missing delivery, span failure, or broken
 * invariant.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const core = require('../patch-core.cjs');

const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
if (dirIdx < 0 || !args[dirIdx + 1]) {
  console.error('usage: node runtime/verify-runtime.js --dir <ZCode install>');
  process.exit(1);
}
const INSTALL = path.resolve(args[dirIdx + 1]);
const rtDir = path.join(INSTALL, 'resources', 'app', 'out', '.zcode-runtime');

const fail = message => { console.error(`verify-runtime: ${message}`); process.exit(1); };
if (!fs.existsSync(path.join(rtDir, 'config.json'))) fail('runtime patcher is not installed here');

const config = JSON.parse(fs.readFileSync(path.join(rtDir, 'config.json'), 'utf8'));
const profile = JSON.parse(fs.readFileSync(config.profilePath, 'utf8'));
const registry = JSON.parse(fs.readFileSync(config.registryPath, 'utf8'));
const instancesBySpan = core.buildTransformInstances(profile, registry);

const sha = text => createHash('sha256').update(text).digest('hex');

// expected output per target, computed strictly from pristine on-disk bundles
const expected = new Map();
const flatDelivered = new Map();
for (const [rel, target] of Object.entries(config.esmTargets)) {
  const text = fs.readFileSync(path.join(config.appRoot, rel), 'utf8');
  const result = core.applySpansText(text, profile.appSpec[target.specKey], instancesBySpan,
    target.targetId, { strict: true, label: target.targetId });
  expected.set(target.targetId, { sha256: sha(result.text), file: path.basename(rel) });
}
for (const target of config.rendererTargets) {
  const assetsDir = path.join(config.appRoot, 'out', 'renderer', 'assets');
  const file = fs.readdirSync(assetsDir).filter(f => f.endsWith('.js'))
    .map(f => path.join(assetsDir, f))
    .find(f => fs.readFileSync(f, 'utf8').includes(target.marker));
  if (!file) fail(`renderer marker "${target.marker}" not found in ${assetsDir}`);
  const text = fs.readFileSync(file, 'utf8');
  const result = core.applySpansText(text, profile.appSpec[target.specKey], instancesBySpan,
    target.targetId, { strict: true, label: target.targetId });
  expected.set(target.targetId, { sha256: sha(result.text), file: path.basename(file) });
}

// Preload bundles and the GLM CLI are flat-patched. Verify their on-disk bytes
// against a fresh strict transform of the .rt-pristine backup as well.
const addFlatTarget = (targetId, file, spans, postconditions) => {
  const backup = `${file}.rt-pristine`;
  if (!fs.existsSync(backup)) fail(`${targetId} has no runtime pristine backup: ${backup}`);
  const source = fs.readFileSync(backup, 'utf8');
  const result = core.applySpansText(source, spans, instancesBySpan, targetId,
    { strict: true, label: targetId });
  expected.set(targetId, { sha256: sha(result.text), file: path.basename(file) });
  const text = fs.readFileSync(file, 'utf8');
  flatDelivered.set(targetId, {
    delivered: 'flat-patched',
    sha256: sha(text),
    failures: [],
    invariant: core.criticalTargetSemanticIssue(targetId, text),
    missingPostconditions: postconditions.filter(value => !text.includes(value)),
  });
};
for (const target of profile.targets.filter(candidate =>
  candidate.path?.replace(/\\/g, '/').startsWith('out/preload/'))) {
  addFlatTarget(target.id, path.join(config.appRoot, target.path),
    profile.appSpec[target.specKey], target.postconditions || []);
}
addFlatTarget('glm', path.join(path.dirname(config.appRoot), profile.glm.path.replace(/^resources[\\/]/, '')),
  profile.glmSpec.spans, [profile.glm.marker, ...profile.glm.postconditions]);

// delivered output per target, from the last run's log
const logPath = config.logPath;
if (!fs.existsSync(logPath)) fail(`no runtime log at ${logPath} — launch the app first`);
const delivered = new Map();
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
  if (!line) continue;
  let entry;
  try { entry = JSON.parse(line); } catch { continue; }
  if ((entry.event === 'esm-target' || entry.event === 'renderer-target') && entry.targetId) {
    delivered.set(entry.targetId, entry);
  }
}
for (const [targetId, entry] of flatDelivered) delivered.set(targetId, entry);

let bad = 0;
console.log('target'.padEnd(22), 'delivery'.padEnd(10), 'match'.padEnd(6), 'detail');
for (const [targetId, want] of expected) {
  const got = delivered.get(targetId);
  if (!got) {
    bad++;
    console.log(targetId.padEnd(22), 'MISSING'.padEnd(10), ''.padEnd(6), `${want.file} never loaded`);
    continue;
  }
  const problems = [];
  if (got.delivered !== 'patched' && got.delivered !== 'flat-patched') {
    problems.push(`delivered=${got.delivered}`);
  }
  if (got.sha256 !== want.sha256) problems.push('sha256 mismatch');
  if (got.failures && got.failures.length) problems.push(`failures=${JSON.stringify(got.failures)}`);
  if (got.invariant) problems.push(`invariant: ${got.invariant}`);
  if (got.missingPostconditions && got.missingPostconditions.length) {
    problems.push(`missing postconditions: ${got.missingPostconditions.join(', ')}`);
  }
  if (problems.length) bad++;
  console.log(targetId.padEnd(22), String(got.delivered).padEnd(10),
    (problems.length ? 'NO' : 'yes').padEnd(6), problems.join('; '));
}
if (bad) {
  console.error(`\nverify-runtime: ${bad} target(s) failed`);
  process.exit(1);
}
console.log(`\nverify-runtime: all ${expected.size} runtime and flat-patched targets are byte-identical to the strict static transform`);

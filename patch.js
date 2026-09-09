#!/usr/bin/env node
/*
 * ZCode OpenAI OAuth patcher
 *
 *   node patch.js               patch, deploy, restart ZCode
 *   node patch.js --probe       inspect compatibility without modifying the install
 *   node patch.js --dry-run     validate and repack in a temporary directory
 *   node patch.js --no-deploy   write staged .patched files without deploying
 *   node patch.js --dir <path>  use a custom ZCode install directory
 *   node patch.js --restore     restore same-version pristine backups
 *   node patch.js --self-test   run the patcher's fixture checks
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');

const asar = require('@electron/asar');
const core = require('./patch-core.cjs');

const { countMatches, buildTransformInstances, criticalTargetSemanticIssue,
  criticalRendererProfileIssue } = core;
const compatibilityError = core.patchError;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const NO_DEPLOY = args.includes('--no-deploy');
const RESTORE = args.includes('--restore');
const PROBE = args.includes('--probe');
const SELF_TEST = args.includes('--self-test');
const dirIdx = args.indexOf('--dir');
const REQUESTED_INSTALL = dirIdx >= 0 ? args[dirIdx + 1] : null;
const APP_PATCH_MARKER = 'OpenAiOAuthAdapter';
const PROFILE_SCHEMA_VERSION = 1;
const PROFILE_ROOT = path.join(__dirname, 'profiles');
const OPENAI_PROVIDER_IDS = [
  'builtin:openai',
  'builtin:openai-coding-plan',
  'builtin:openai-start-plan',
];

function runningZCodeInstall() {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    '(Get-CimInstance Win32_Process -Filter "Name=\'ZCode.exe\'" | ' +
      'Select-Object -ExpandProperty ExecutablePath -First 1)',
  ], { encoding: 'utf8' });
  const executable = result.status === 0 ? result.stdout.trim() : '';
  return executable ? path.dirname(executable) : null;
}

function findInstall() {
  const candidates = process.env.ZCODE_INSTALL_DIR ? [process.env.ZCODE_INSTALL_DIR] : [
    runningZCodeInstall(),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'ZCode'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'ZCode'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode'),
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').flatMap(drive => [
      `${drive}:\\Program Files\\ZCode`,
      `${drive}:\\Program Files (x86)\\ZCode`,
    ]),
  ].filter(Boolean).map(candidate => path.resolve(candidate));
  const installs = [...new Set(candidates)].filter(candidate =>
    fs.existsSync(path.join(candidate, 'ZCode.exe')) &&
    fs.existsSync(path.join(candidate, 'resources', 'app.asar'))
  );
  if (installs.length === 1) return installs[0];
  if (installs.length > 1) {
    throw new Error(`multiple ZCode installs found; pass --dir <path>: ${installs.join(', ')}`);
  }
  throw new Error('ZCode install not found; pass --dir <path>');
}

function installPaths(install) {
  const resources = path.join(install, 'resources');
  const glm = path.join(resources, 'glm', 'zcode.cjs');
  return {
    INSTALL: install,
    ASAR: path.join(resources, 'app.asar'),
    APP_UNPACKED: path.join(resources, 'app.asar.unpacked'),
    BACKUP: path.join(resources, 'app.asar.bak-pristine'),
    BACKUP_META: path.join(resources, 'app.asar.bak-pristine.json'),
    GLM: glm,
    GLM_BAK: `${glm}.bak-pristine`,
    GLM_META: `${glm}.bak-pristine.json`,
  };
}

function applyProfilePaths(paths, profile) {
  const glm = resolveInside(paths.INSTALL, profile.glm.path, `profile ${profile.id} GLM path`);
  return {
    ...paths,
    GLM: glm,
    GLM_BAK: `${glm}.bak-pristine`,
    GLM_META: `${glm}.bak-pristine.json`,
  };
}

function packageVersion(asarPath) {
  try {
    return JSON.parse(asar.extractFile(asarPath, 'package.json').toString()).version || '';
  } catch {
    return '';
  }
}

function readMetadata(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return {};
  }
}

function resolveInside(root, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw compatibilityError(`${label} must be a non-empty relative path`);
  }
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw compatibilityError(`${label} escapes its profile root`);
  }
  return resolved;
}

function readJsonStrict(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw compatibilityError(`${label} is not valid JSON: ${error.message}`);
  }
}

function validateSpans(spans, label) {
  if (!Array.isArray(spans) || spans.length === 0) {
    throw compatibilityError(`${label} must contain at least one span`);
  }
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index];
    if (!span || typeof span.find !== 'string' || span.find.length === 0 ||
        typeof span.replace !== 'string' || span.replace.length === 0) {
      throw compatibilityError(`${label} span ${index + 1} must have non-empty find and replace strings`);
    }
  }
}

function loadProfileIndex(profileRoot = PROFILE_ROOT) {
  const index = readJsonStrict(path.join(profileRoot, 'index.json'), 'profile index');
  if (index.schemaVersion !== PROFILE_SCHEMA_VERSION ||
      !index.profiles || typeof index.profiles !== 'object' || Array.isArray(index.profiles)) {
    throw compatibilityError(`profile index must use schemaVersion ${PROFILE_SCHEMA_VERSION}`);
  }
  for (const [version, manifestPath] of Object.entries(index.profiles)) {
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      throw compatibilityError(`profile index contains an invalid exact version: ${version}`);
    }
    resolveInside(profileRoot, manifestPath, `profile ${version} manifest`);
  }
  return index;
}

function validateProfileManifest(manifest, version, profileDir, appSpec, glmSpec) {
  if (!manifest || manifest.schemaVersion !== PROFILE_SCHEMA_VERSION ||
      manifest.version !== version || typeof manifest.id !== 'string' || !manifest.id) {
    throw compatibilityError(`profile ${version} manifest identity is invalid`);
  }
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    throw compatibilityError(`profile ${version} must declare app targets`);
  }
  if (!appSpec || typeof appSpec !== 'object' || Array.isArray(appSpec)) {
    throw compatibilityError(`profile ${version} app spec is invalid`);
  }
  if (!glmSpec || typeof glmSpec !== 'object' || !Array.isArray(glmSpec.spans)) {
    throw compatibilityError(`profile ${version} GLM spec is invalid`);
  }
  validateSpans(glmSpec.spans, `profile ${version} GLM`);

  const ids = new Set();
  const specKeys = new Set();
  for (const target of manifest.targets) {
    if (!target || typeof target.id !== 'string' || !target.id || ids.has(target.id)) {
      throw compatibilityError(`profile ${version} has a missing or duplicate target id`);
    }
    if (typeof target.specKey !== 'string' || !target.specKey || specKeys.has(target.specKey)) {
      throw compatibilityError(`profile ${version} target ${target.id} has a missing or duplicate specKey`);
    }
    ids.add(target.id);
    specKeys.add(target.specKey);
    validateSpans(appSpec[target.specKey], `profile ${version} target ${target.id}`);
    if ((typeof target.path === 'string') === Boolean(target.resolver)) {
      throw compatibilityError(`profile ${version} target ${target.id} must declare exactly one path or resolver`);
    }
    if (target.path) resolveInside(profileDir, target.path, `profile ${version} target ${target.id} path`);
    if (target.resolver) {
      if (target.resolver.type !== 'marker-js' ||
          typeof target.resolver.directory !== 'string' || !target.resolver.directory ||
          typeof target.resolver.marker !== 'string' || !target.resolver.marker) {
        throw compatibilityError(`profile ${version} target ${target.id} resolver is invalid`);
      }
      resolveInside(profileDir, target.resolver.directory,
        `profile ${version} target ${target.id} resolver directory`);
    }
    if (!Array.isArray(target.postconditions) ||
        target.postconditions.some(value => typeof value !== 'string' || !value)) {
      throw compatibilityError(`profile ${version} target ${target.id} postconditions are invalid`);
    }
  }
  const extraSpecKeys = Object.keys(appSpec).filter(key => !specKeys.has(key));
  if (extraSpecKeys.length > 0) {
    throw compatibilityError(`profile ${version} app spec has undeclared targets: ${extraSpecKeys.join(', ')}`);
  }
  if (!manifest.glm || typeof manifest.glm.path !== 'string' || !manifest.glm.path ||
      typeof manifest.glm.marker !== 'string' || !manifest.glm.marker ||
      !Array.isArray(manifest.glm.postconditions) ||
      manifest.glm.postconditions.some(value => typeof value !== 'string' || !value)) {
    throw compatibilityError(`profile ${version} GLM manifest is invalid`);
  }
}

function loadProfile(version, profileRoot = PROFILE_ROOT) {
  const index = loadProfileIndex(profileRoot);
  const manifestRelative = index.profiles[version];
  if (!manifestRelative) {
    throw compatibilityError(`no verified compatibility profile for ZCode ${version}`);
  }
  const manifestPath = resolveInside(profileRoot, manifestRelative, `profile ${version} manifest`);
  const profileDir = path.dirname(manifestPath);
  const manifest = readJsonStrict(manifestPath, `profile ${version} manifest`);
  const appSpecPath = resolveInside(profileDir, manifest.appSpec, `profile ${version} appSpec`);
  const glmSpecPath = resolveInside(profileDir, manifest.glmSpec, `profile ${version} glmSpec`);
  if (!/^[0-9a-f]{64}$/.test(manifest.appSpecSha256 || '') ||
      fileSha256(appSpecPath) !== manifest.appSpecSha256 ||
      !/^[0-9a-f]{64}$/.test(manifest.glmSpecSha256 || '') ||
      fileSha256(glmSpecPath) !== manifest.glmSpecSha256) {
    throw compatibilityError(`profile ${version} spec checksum mismatch`);
  }
  const appSpec = readJsonStrict(appSpecPath, `profile ${version} app spec`);
  const glmSpec = readJsonStrict(glmSpecPath, `profile ${version} GLM spec`);
  validateProfileManifest(manifest, version, profileDir, appSpec, glmSpec);
  const profile = { ...manifest, profileDir, appSpec, glmSpec };
  profile.transformInstances = buildTransformInstances(profile, loadTransformsRegistry());
  return profile;
}

function loadAllProfiles(profileRoot = PROFILE_ROOT) {
  return Object.keys(loadProfileIndex(profileRoot).profiles).map(version => loadProfile(version, profileRoot));
}

function fileSha256(filePath) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function fileIncludes(filePath, value) {
  const needle = Buffer.from(value);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  let carry = Buffer.alloc(0);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return false;
      const chunk = carry.length === 0
        ? buffer.subarray(0, bytesRead)
        : Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      if (chunk.includes(needle)) return true;
      carry = Buffer.from(chunk.subarray(Math.max(0, chunk.length - needle.length + 1)));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function asarHasPatch(asarPath) {
  return fs.existsSync(asarPath) && fileIncludes(asarPath, APP_PATCH_MARKER);
}

function metadataHashMatches(metadata, filePath) {
  return typeof metadata.sha256 === 'string' && metadata.sha256.length === 64 &&
    metadata.sha256 === fileSha256(filePath);
}

function usableAppBackup(paths, version, profile) {
  if (!fs.existsSync(paths.BACKUP) || packageVersion(paths.BACKUP) !== version ||
      asarHasPatch(paths.BACKUP)) return false;
  const metadata = readMetadata(paths.BACKUP_META);
  return metadata.version === version &&
    (!metadata.profileId || !profile || metadata.profileId === profile.id) &&
    metadataHashMatches(metadata, paths.BACKUP);
}

function patchText(text, spans, label) {
  return core.applySpansText(text, spans, null, null, { strict: true, label }).text;
}

function isPristineText(text, spans, label) {
  try {
    patchText(text, spans, label);
    return true;
  } catch (error) {
    if (error && error.code === 'ZCODE_PATCH_INCOMPATIBLE') return false;
    throw error;
  }
}

function applySpans(filePath, spans, label) {
  const patched = patchText(fs.readFileSync(filePath, 'utf8'), spans, label);
  fs.writeFileSync(filePath, patched);
}

function syntaxCheck(filePath) {
  const result = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`syntax check failed after patching: ${filePath}\n${result.stderr}`);
  }
}

function findJsByMarker(dir, marker) {
  const matches = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const candidate = path.join(dir, file);
    if (fs.readFileSync(candidate, 'utf8').includes(marker)) matches.push(candidate);
  }
  if (matches.length !== 1) {
    throw compatibilityError(
      `expected exactly one bundle containing marker "${marker}" in ${dir}, found ${matches.length}`
    );
  }
  return matches[0];
}

function resolveProfileTarget(profile, target, extractDir) {
  const label = `profile ${profile.id} target ${target.id}`;
  if (target.path) return resolveInside(extractDir, target.path, `${label} path`);
  const directory = resolveInside(extractDir, target.resolver.directory, `${label} resolver directory`);
  return findJsByMarker(directory, target.resolver.marker);
}

function verifyPostconditions(filePath, postconditions, label) {
  const text = fs.readFileSync(filePath, 'utf8');
  const missing = postconditions.filter(value => !text.includes(value));
  if (missing.length > 0) {
    throw compatibilityError(`${label} is missing postconditions: ${missing.join(', ')}`);
  }
}

function verifyCriticalTargetSemantics(targetId, text, label) {
  const issue = criticalTargetSemanticIssue(targetId, text);
  if (issue) throw compatibilityError(`${label}: critical semantic invariant failed: ${issue}`);
}

function applySemanticEdits(text, edits, label) {
  for (const edit of edits) {
    if (edit.operation !== 'insert-after-match' && edit.operation !== 'replace-match') {
      throw compatibilityError(`${label}: unknown transform operation ${edit.operation}`);
    }
  }
  return core.applySemanticEdits(text, edits);
}

function loadTransformsRegistry() {
  const registry = readJsonStrict(path.join(__dirname, 'transforms', 'registry.json'), 'transform registry');
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.transforms)) {
    throw compatibilityError('transform registry must use schemaVersion 1');
  }
  const ids = new Set();
  for (const transform of registry.transforms) {
    if (!transform || typeof transform.id !== 'string' || !transform.id || ids.has(transform.id) ||
        !Array.isArray(transform.instances) || transform.instances.length === 0) {
      throw compatibilityError('transform registry contains an invalid or duplicate transform');
    }
    ids.add(transform.id);
    for (const instance of transform.instances) {
      if (typeof instance.target !== 'string' || !instance.target ||
          !Number.isInteger(instance.span) || instance.span < 0 ||
          !Array.isArray(instance.edits) || instance.edits.length === 0) {
        throw compatibilityError(`transform ${transform.id} has an invalid instance`);
      }
      for (const edit of instance.edits) {
        if ((edit.operation !== 'insert-after-match' && edit.operation !== 'replace-match') ||
            typeof edit.locate !== 'string' || !edit.locate ||
            typeof (edit.insert ?? edit.template) !== 'string' ||
            !(edit.insert ?? edit.template)) {
          throw compatibilityError(`transform ${transform.id} has an invalid edit`);
        }
      }
    }
  }
  return registry;
}

function applySpansWithTransforms(filePath, spans, instancesBySpan, targetKey, label) {
  const result = core.applySpansText(fs.readFileSync(filePath, 'utf8'), spans,
    instancesBySpan, targetKey, { strict: true, label });
  fs.writeFileSync(filePath, result.text);
  return result.levels;
}

function applyProfileTarget(profile, target, extractDir) {
  const filePath = resolveProfileTarget(profile, target, extractDir);
  const label = `profile ${profile.id} target ${target.id} (${path.basename(filePath)})`;
  const levels = applySpansWithTransforms(filePath, profile.appSpec[target.specKey],
    profile.transformInstances, target.id, label);
  const text = fs.readFileSync(filePath, 'utf8');
  verifyCriticalTargetSemantics(target.id, text, label);
  syntaxCheck(filePath);
  verifyPostconditions(filePath, target.postconditions, label);
  return { filePath, levels };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function zcodeRunning() {
  if (process.platform !== 'win32') return false;
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe'], { encoding: 'utf8' });
  return !!(result.stdout && result.stdout.includes('ZCode.exe'));
}

function killZCode() {
  if (process.platform !== 'win32') return;
  spawnSync('taskkill', ['/F', '/IM', 'ZCode.exe'], { stdio: 'ignore' });
  for (let index = 0; index < 20 && zcodeRunning(); index++) sleepMs(500);
  if (zcodeRunning()) throw new Error('ZCode.exe did not stop; close it manually and run patch.bat again');
}

function startZCode(paths) {
  const executable = path.join(paths.INSTALL, 'ZCode.exe');
  if (!fs.existsSync(executable)) return;
  const { spawn } = require('child_process');
  const child = spawn(executable, [], { detached: true, stdio: 'ignore' });
  child.unref();
}

function classifyGlmBackupFacts(facts, version) {
  if (!facts.exists || !facts.pristine || facts.metadataHashMatches !== true) return 'invalid';
  return facts.metaVersion === version ? 'usable' : 'invalid';
}

function glmBackupStatus(paths, version, profile) {
  const exists = fs.existsSync(paths.GLM_BAK);
  const pristine = exists && isPristineText(
    fs.readFileSync(paths.GLM_BAK, 'utf8'),
    profile.glmSpec.spans,
    'GLM pristine backup'
  );
  const metadata = readMetadata(paths.GLM_META);
  return classifyGlmBackupFacts({
    exists,
    pristine,
    metaVersion: metadata.version || '',
    metadataHashMatches: exists &&
      (!metadata.profileId || metadata.profileId === profile.id) &&
      metadataHashMatches(metadata, paths.GLM_BAK),
  }, version);
}

function writeMetadata(metaPath, version, sourcePath, profile) {
  const temporary = `${metaPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify({
    version,
    sha256: fileSha256(sourcePath),
    ...profile ? { profileId: profile.id, profileSchemaVersion: profile.schemaVersion } : {},
    savedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  fs.renameSync(temporary, metaPath);
}

function copyVerified(source, destination) {
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    fs.copyFileSync(source, temporary);
    if (fileSha256(source) !== fileSha256(temporary)) {
      throw new Error(`copy verification failed: ${destination}`);
    }
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function selectGlmSource(paths, version, profile) {
  const live = fs.readFileSync(paths.GLM, 'utf8');
  if (!live.includes(profile.glm.marker)) return paths.GLM;
  const status = glmBackupStatus(paths, version, profile);
  if (status === 'usable') return paths.GLM_BAK;
  throw new Error('patched GLM detected, but no hash-verified same-version pristine GLM backup is available');
}

function stageAsarSource(sourceAsar, unpackedSource, stageDir, extractDir) {
  const stagedAsar = path.join(stageDir, 'source.asar');
  const stagedUnpacked = `${stagedAsar}.unpacked`;
  copyVerified(sourceAsar, stagedAsar);
  if (fs.existsSync(unpackedSource)) {
    fs.symlinkSync(path.resolve(unpackedSource), stagedUnpacked, process.platform === 'win32' ? 'junction' : 'dir');
  }
  try {
    asar.extractAll(stagedAsar, extractDir);
  } finally {
    fs.rmSync(stagedUnpacked, { recursive: true, force: true });
  }
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, filePath);
}

function isGeneratedOpenAiModelRef(value) {
  if (typeof value !== 'string') return false;
  return OPENAI_PROVIDER_IDS.some(providerId =>
    value.includes(providerId) || value.includes(encodeURIComponent(providerId))
  );
}

function cleanStateObjects(config, agents) {
  let configChanged = false;
  let agentsChanged = false;
  const staleProfiles = new Set();

  if (config && config.provider && typeof config.provider === 'object') {
    for (const providerId of OPENAI_PROVIDER_IDS) {
      if (Object.prototype.hasOwnProperty.call(config.provider, providerId)) {
        delete config.provider[providerId];
        configChanged = true;
      }
    }
  }

  const modelOverrides = agents && agents.builtInModelOverrides;
  if (modelOverrides && typeof modelOverrides === 'object') {
    for (const [profileId, modelRef] of Object.entries(modelOverrides)) {
      if (!isGeneratedOpenAiModelRef(modelRef)) continue;
      staleProfiles.add(profileId);
      delete modelOverrides[profileId];
      agentsChanged = true;
    }
  }

  const thoughtOverrides = agents && agents.builtInThoughtLevelOverrides;
  if (thoughtOverrides && typeof thoughtOverrides === 'object') {
    for (const profileId of staleProfiles) {
      if (!Object.prototype.hasOwnProperty.call(thoughtOverrides, profileId)) continue;
      delete thoughtOverrides[profileId];
      agentsChanged = true;
    }
  }

  return { configChanged, agentsChanged };
}

function zcodeStateDirs() {
  const candidates = [];
  const base = process.env.ZCODE_DATA_BASE_DIR;
  if (base) {
    candidates.push(path.basename(base).toLowerCase() === '.zcode'
      ? path.join(base, 'v2')
      : path.join(base, '.zcode', 'v2'));
  }
  candidates.push(path.join(os.homedir(), '.zcode', 'v2'));
  return [...new Set(candidates.map(candidate => path.resolve(candidate)))];
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function staleStateFiles() {
  const results = [];
  for (const dir of zcodeStateDirs()) {
    const configPath = path.join(dir, 'config.json');
    const agentsPath = path.join(dir, 'agents-state.json');
    const config = readJsonIfPresent(configPath);
    const agents = readJsonIfPresent(agentsPath);
    if (!config && !agents) continue;
    const configCopy = config && JSON.parse(JSON.stringify(config));
    const agentsCopy = agents && JSON.parse(JSON.stringify(agents));
    const changes = cleanStateObjects(configCopy, agentsCopy);
    if (changes.configChanged || changes.agentsChanged) {
      results.push({ configPath, agentsPath, config, agents, changes });
    }
  }
  return results;
}

function cleanupStaleOpenAiState(paths) {
  if (staleStateFiles().length === 0) return false;

  console.log('incompatible unpatched ZCode detected; closing ZCode and removing stale OpenAI menu state...');
  killZCode();
  try {
    for (const item of staleStateFiles()) {
      const changes = cleanStateObjects(item.config, item.agents);
      if (changes.configChanged) writeJsonAtomic(item.configPath, item.config);
      if (changes.agentsChanged) writeJsonAtomic(item.agentsPath, item.agents);
    }
  } finally {
    startZCode(paths);
  }
  console.log('[cleaned] stale generated OpenAI providers and their subagent overrides; OAuth credentials were retained');
  return true;
}

function ensurePristineBackups(paths, version, profile) {
  const liveAppPristine = !asarHasPatch(paths.ASAR) && packageVersion(paths.ASAR) === version;
  const appBackupUsable = usableAppBackup(paths, version, profile);
  const appBuildChanged = liveAppPristine && appBackupUsable &&
    fileSha256(paths.ASAR) !== fileSha256(paths.BACKUP);
  if (!appBackupUsable || appBuildChanged) {
    if (!liveAppPristine) {
      throw new Error('cannot create a pristine app backup from the installed app.asar');
    }
    copyVerified(paths.ASAR, paths.BACKUP);
    writeMetadata(paths.BACKUP_META, version, paths.BACKUP, profile);
  } else if (!readMetadata(paths.BACKUP_META).profileId) {
    writeMetadata(paths.BACKUP_META, version, paths.BACKUP, profile);
  }

  const liveGlm = fs.readFileSync(paths.GLM, 'utf8');
  const liveGlmPristine = isPristineText(liveGlm, profile.glmSpec.spans, 'installed GLM');
  const status = glmBackupStatus(paths, version, profile);
  const glmBuildChanged = liveGlmPristine && status === 'usable' &&
    fileSha256(paths.GLM) !== fileSha256(paths.GLM_BAK);
  if (status !== 'usable' || glmBuildChanged) {
    if (!liveGlmPristine) {
      throw new Error('cannot create a pristine GLM backup from the installed zcode.cjs');
    }
    copyVerified(paths.GLM, paths.GLM_BAK);
    writeMetadata(paths.GLM_META, version, paths.GLM_BAK, profile);
  } else if (!readMetadata(paths.GLM_META).profileId) {
    writeMetadata(paths.GLM_META, version, paths.GLM_BAK, profile);
  }
}

function restore(paths, profile) {
  if (!fs.existsSync(paths.ASAR)) throw new Error(`app.asar not found at ${paths.ASAR}`);
  const version = packageVersion(paths.ASAR);
  if (!version || !usableAppBackup(paths, version, profile)) {
    throw new Error('no same-version pristine app.asar backup found');
  }
  const glmStatus = glmBackupStatus(paths, version, profile);
  if (glmStatus !== 'usable') {
    throw new Error('no hash-verified same-version pristine GLM backup found');
  }

  killZCode();
  try {
    copyVerified(paths.BACKUP, paths.ASAR);
    copyVerified(paths.GLM_BAK, paths.GLM);
    console.log('[OK] restored same-version pristine app.asar and glm/zcode.cjs');
  } finally {
    startZCode(paths);
  }
}

function replaceRuntimeFiles(paths, appOutput, glmOutput, copy = copyVerified) {
  try {
    copy(appOutput, paths.ASAR);
    copy(glmOutput, paths.GLM);
  } catch (error) {
    try {
      copy(paths.BACKUP, paths.ASAR);
      copy(paths.GLM_BAK, paths.GLM);
    } catch (rollbackError) {
      throw new Error(
        `deployment failed and rollback also failed: ${error.message}; rollback: ${rollbackError.message}`
      );
    }
    throw new Error(`deployment failed; both files were rolled back: ${error.message}`);
  }
}

function deployPrepared(paths, version, appOutput, glmOutput, profile) {
  console.log('closing ZCode...');
  killZCode();
  try {
    ensurePristineBackups(paths, version, profile);
    replaceRuntimeFiles(paths, appOutput, glmOutput);
    console.log('[deployed] app.asar and glm/zcode.cjs as one verified transaction');
  } finally {
    startZCode(paths);
  }
}

function selectPristineSources(paths, version, profile) {
  const liveAppPatched = asarHasPatch(paths.ASAR);
  const appSource = liveAppPatched
    ? (usableAppBackup(paths, version, profile) ? paths.BACKUP : null)
    : paths.ASAR;
  if (!appSource) {
    throw new Error('patched app.asar detected, but no same-version pristine app backup is available');
  }
  return {
    appSource,
    glmSource: selectGlmSource(paths, version, profile),
    liveAppPatched,
  };
}

async function prepareProfile(paths, version, profile, options = {}) {
  const { repack = true, quiet = false } = options;
  const sources = selectPristineSources(paths, version, profile);
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-openai-'));
  const extractDir = path.join(stageDir, 'app');
  const appOutput = path.join(stageDir, 'app.asar.patched');
  const glmOutput = path.join(stageDir, 'zcode.patched.cjs');
  try {
    if (!quiet) console.log(`preparing profile ${profile.id} from pristine ZCode ${version} sources in`, stageDir);
    stageAsarSource(sources.appSource, paths.APP_UNPACKED, stageDir, extractDir);

    const resolvedTargets = [];
    for (const target of profile.targets) {
      const { filePath, levels } = applyProfileTarget(profile, target, extractDir);
      resolvedTargets.push({ id: target.id, filePath, levels });
      if (!quiet) {
        console.log(`[prepared] ${target.id} (${path.basename(filePath)}): ` +
          `${profile.appSpec[target.specKey].length} spans`);
      }
    }

    copyVerified(sources.glmSource, glmOutput);
    const glmLevels = applySpansWithTransforms(glmOutput, profile.glmSpec.spans,
      profile.transformInstances, 'glm', `profile ${profile.id} GLM`);
    syntaxCheck(glmOutput);
    verifyPostconditions(glmOutput, [profile.glm.marker, ...profile.glm.postconditions],
      `profile ${profile.id} GLM`);
    if (!quiet) console.log(`[prepared] GLM: ${profile.glmSpec.spans.length} spans`);
    const fallbackLevels = [...resolvedTargets.flatMap(t => t.levels), ...glmLevels]
      .filter(level => level.level === 'anchor-fallback');
    if (!quiet) {
      for (const level of fallbackLevels) {
        console.log(`[fallback] anchor used for transform ${level.ids.join(', ')} (span ${level.span})`);
      }
    }

    if (repack) {
      if (!quiet) console.log('packing staged app.asar...');
      await asar.createPackageWithOptions(extractDir, appOutput, {
        unpackDir: '**/{node-pty,ssh2}/**',
      });
      if (packageVersion(appOutput) !== version || !fileIncludes(appOutput, profile.appMarker)) {
        throw new Error('staged app.asar verification failed');
      }
    }

    return { stageDir, extractDir, appOutput, glmOutput, resolvedTargets, glmLevels, ...sources };
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

function analyzeSpans(text, spans, instancesBySpan, targetKey) {
  let result = text;
  let matched = 0;
  const failures = [];
  const levels = [];
  for (let index = 0; index < spans.length; index++) {
    const instances = instancesBySpan.get(`${targetKey}:${index}`);
    if (instances) {
      const ids = instances.map(instance => instance.id);
      const semantic = applySemanticEdits(result, instances.flatMap(instance => instance.edits),
        `probe ${targetKey}#${index + 1}`);
      if (semantic !== null) {
        matched += 1;
        result = semantic;
        levels.push({ span: index + 1, level: 'semantic', ids });
        continue;
      }
    }
    const count = countMatches(result, spans[index].find);
    if (count === 1) {
      matched += 1;
      result = result.replace(spans[index].find, spans[index].replace);
      levels.push({
        span: index + 1,
        level: instances ? 'anchor-fallback' : 'anchor',
        ids: instances ? instances.map(instance => instance.id) : [],
      });
    } else {
      failures.push({ anchor: index + 1, count });
      levels.push({
        span: index + 1,
        level: 'failed',
        ids: instances ? instances.map(instance => instance.id) : [],
      });
    }
  }
  return { result, matched, total: spans.length, failures, levels };
}

function analyzeProfile(profile, extractDir, glmSource) {
  const targets = [];
  let matched = 0;
  let total = profile.glmSpec.spans.length;
  for (const target of profile.targets) {
    const spans = profile.appSpec[target.specKey];
    total += spans.length;
    try {
      const filePath = resolveProfileTarget(profile, target, extractDir);
      const analysis = analyzeSpans(fs.readFileSync(filePath, 'utf8'), spans,
        profile.transformInstances, target.id);
      const missingPostconditions = analysis.failures.length === 0
        ? target.postconditions.filter(value => !analysis.result.includes(value))
        : [];
      const invariantFailure = analysis.failures.length === 0
        ? criticalTargetSemanticIssue(target.id, analysis.result)
        : null;
      matched += analysis.matched;
      targets.push({
        id: target.id,
        physical: path.basename(filePath),
        matched: analysis.matched,
        total: analysis.total,
        failures: analysis.failures,
        missingPostconditions,
        invariantFailure,
        levels: analysis.levels,
      });
    } catch (error) {
      targets.push({
        id: target.id,
        matched: 0,
        total: spans.length,
        failures: [],
        missingPostconditions: [],
        levels: [],
        error: error.message,
      });
    }
  }

  const glmAnalysis = analyzeSpans(fs.readFileSync(glmSource, 'utf8'), profile.glmSpec.spans,
    profile.transformInstances, 'glm');
  const glmMissing = glmAnalysis.failures.length === 0
    ? [profile.glm.marker, ...profile.glm.postconditions]
      .filter(value => !glmAnalysis.result.includes(value))
    : [];
  matched += glmAnalysis.matched;
  return {
    profileId: profile.id,
    profileVersion: profile.version,
    matched,
    total,
    targets,
    glm: {
      matched: glmAnalysis.matched,
      total: glmAnalysis.total,
      failures: glmAnalysis.failures,
      missingPostconditions: glmMissing,
      levels: glmAnalysis.levels,
    },
  };
}

function selectUnknownProbeGlmSource(paths, version, profiles) {
  const live = fs.readFileSync(paths.GLM, 'utf8');
  if (!profiles.some(profile => live.includes(profile.glm.marker))) return paths.GLM;
  for (const profile of profiles) {
    if (glmBackupStatus(paths, version, profile) === 'usable') return paths.GLM_BAK;
  }
  throw new Error('patched GLM detected, but no hash-verified same-version pristine GLM backup is available');
}

function printProbeReport(version, reports) {
  console.log(`ZCode version: ${version}`);
  for (const report of reports) {
    console.log(`\n${report.profileId}: ${report.matched}/${report.total} anchors compatible`);
    const levelCounts = { semantic: 0, anchor: 0, 'anchor-fallback': 0, failed: 0 };
    const failedTransforms = [];
    for (const level of [...report.targets.flatMap(t => t.levels), ...report.glm.levels]) {
      levelCounts[level.level] += 1;
      if (level.level === 'failed') {
        for (const id of level.ids) failedTransforms.push(id);
      }
    }
    if (levelCounts.semantic + levelCounts['anchor-fallback'] > 0) {
      console.log(`  transform resolution: ${levelCounts.semantic} semantic, ` +
        `${levelCounts['anchor-fallback']} anchor-fallback, ${levelCounts.anchor} anchor-only, ` +
        `${levelCounts.failed} failed`);
    }
    for (const id of [...new Set(failedTransforms)]) {
      console.log(`  transform failed: ${id}`);
    }
    for (const target of report.targets) {
      if (target.matched === target.total && !target.error &&
          target.missingPostconditions.length === 0 && !target.invariantFailure) continue;
      const detail = target.error || [
        ...target.failures.map(item => `anchor ${item.anchor} matched ${item.count}`),
        ...target.missingPostconditions.map(value => `missing postcondition ${value}`),
        ...(target.invariantFailure ? [`critical invariant ${target.invariantFailure}`] : []),
      ].join('; ');
      console.log(`  ${target.id}: ${target.matched}/${target.total}${detail ? ` — ${detail}` : ''}`);
    }
    if (report.glm.matched !== report.glm.total || report.glm.missingPostconditions.length > 0) {
      const detail = [
        ...report.glm.failures.map(item => `anchor ${item.anchor} matched ${item.count}`),
        ...report.glm.missingPostconditions.map(value => `missing postcondition ${value}`),
      ].join('; ');
      console.log(`  glm: ${report.glm.matched}/${report.glm.total}${detail ? ` — ${detail}` : ''}`);
    }
  }
}

async function probeCompatibility(paths, version) {
  let exactProfile;
  try {
    exactProfile = loadProfile(version);
  } catch (error) {
    if (!error || error.code !== 'ZCODE_PATCH_INCOMPATIBLE' ||
        !error.message.startsWith('no verified compatibility profile')) throw error;
  }

  if (exactProfile) {
    const exactPaths = applyProfilePaths(paths, exactProfile);
    if (!fs.existsSync(exactPaths.GLM)) {
      throw compatibilityError(`profile ${exactProfile.id} GLM path is missing: ${exactPaths.GLM}`);
    }
    const prepared = await prepareProfile(exactPaths, version, exactProfile, { repack: false, quiet: true });
    try {
      const total = exactProfile.targets.reduce((sum, target) =>
        sum + exactProfile.appSpec[target.specKey].length, exactProfile.glmSpec.spans.length);
      const allLevels = [...prepared.resolvedTargets.flatMap(t => t.levels), ...prepared.glmLevels];
      const semantic = allLevels.filter(l => l.level === 'semantic').length;
      const fallback = allLevels.filter(l => l.level === 'anchor-fallback').length;
      console.log(`ZCode ${version}: verified profile ${exactProfile.id}`);
      console.log(`compatibility probe passed: ${total}/${total} anchors, syntax, and postconditions ` +
        `(${semantic} semantic, ${fallback} anchor-fallback, ${total - semantic - fallback} anchor-only)`);
      console.log('live files were untouched.');
    } finally {
      fs.rmSync(prepared.stageDir, { recursive: true, force: true });
    }
    return;
  }

  const profiles = loadAllProfiles();
  const liveAppPatched = asarHasPatch(paths.ASAR);
  const appSource = liveAppPatched
    ? (usableAppBackup(paths, version) ? paths.BACKUP : null)
    : paths.ASAR;
  if (!appSource) {
    throw new Error('patched app.asar detected, but no hash-verified same-version pristine backup is available');
  }
  const glmSource = selectUnknownProbeGlmSource(paths, version, profiles);
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-openai-probe-'));
  const extractDir = path.join(stageDir, 'app');
  try {
    stageAsarSource(appSource, paths.APP_UNPACKED, stageDir, extractDir);
    const reports = profiles.map(profile => analyzeProfile(profile, extractDir, glmSource))
      .sort((left, right) => right.matched - left.matched);
    printProbeReport(version, reports);
    console.log('\nThis version is not verified; probe never creates deployable output.');
    throw compatibilityError(`no verified compatibility profile for ZCode ${version}`);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`self-test failed: ${message}`);
}

function selfTest() {
  const profiles = loadAllProfiles();
  const profile = profiles.find(candidate => candidate.version === '3.10.2');
  const spec = profile.appSpec;
  const glmSpec = profile.glmSpec;
  assert(profile.id === 'zcode-3.10.2' && profile.targets.length === Object.keys(spec).length,
    'verified 3.10.2 profile and all app targets load');
  assert(profiles.some(candidate => candidate.version === '3.11.2'),
    'verified 3.11.2 profile and checksums load');

  let unknownProfileError;
  try {
    loadProfile('3.10.3');
  } catch (error) {
    unknownProfileError = error;
  }
  assert(unknownProfileError?.code === 'ZCODE_PATCH_INCOMPATIBLE' &&
    unknownProfileError.message.includes('no verified compatibility profile for ZCode 3.10.3'),
    'unknown versions fail closed before patch preparation');

  const rendererInvariantFixture = 'function menu({presetProviders:raw7,other:x}){' +
    'let view9=raw7.map(({id:a,displayName:b,provider:c})=>' +
    '({key:key(a),type:`preset`,presetId:a,label:b,provider:c}));' +
    'return[{id:`preset`,items:view9.filter(row=>family(row.presetId)!==`openai`)},' +
    '{id:`openai`,items:view9.filter(row=>family(row.presetId)===`openai`)}]}';
  assert(criticalTargetSemanticIssue('renderer.settings', rendererInvariantFixture) === null,
    'renderer invariant accepts renamed raw and normalized provider bindings');
  assert(criticalTargetSemanticIssue('renderer.settings',
    rendererInvariantFixture.replaceAll('items:view9.filter', 'items:raw7.filter')) !== null,
    'renderer invariant rejects filtering the raw provider array');
  assert(criticalTargetSemanticIssue('renderer.settings',
    rendererInvariantFixture.replace('family(row.presetId)===', 'otherFamily(row.presetId)===')) !== null,
    'renderer invariant rejects mismatched family classifiers');
  assert(criticalTargetSemanticIssue('renderer.settings',
    rendererInvariantFixture + rendererInvariantFixture) !== null,
    'renderer invariant rejects ambiguous mappings');

  const hostInvariantFixture = 'async loadPresetProviders(t0){let providers7=[],models8=[];' +
    'let keys=new Map(),openai9=await this.loadSinglePresetProvider([],"openai",null)' +
    '.catch(()=>null);openai9&&providers7.push(openai9);let remote=null}';
  assert(criticalTargetSemanticIssue('host.main', hostInvariantFixture) === null,
    'host invariant accepts renamed provider and OpenAI result bindings');
  assert(criticalTargetSemanticIssue('host.main',
    hostInvariantFixture.replace('providers7.push(openai9)', 'zaiStartPlan.push(openai9)')) !== null,
    'host invariant rejects pushing OpenAI into an unrelated binding');
  assert(criticalTargetSemanticIssue('host.main', '') !== null,
    'host invariant rejects a missing provider loader');

  for (const candidate of profiles) {
    const target = candidate.targets.find(item => item.id === 'renderer.settings');
    assert(criticalRendererProfileIssue(candidate.appSpec[target.specKey]) === null,
      `${candidate.version} renderer spans preserve normalized provider data flow`);
  }

  const profileFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-openai-profile-test-'));
  try {
    const fixtureManifest = {
      schemaVersion: 1,
      id: 'fixture',
      version: '1.2.3',
      targets: [{
        id: 'fixture.target',
        specKey: 'fixture.js',
        path: 'out/fixture.js',
        postconditions: ['patched'],
      }],
      glm: { path: 'resources/glm/zcode.cjs', marker: 'glm-marker', postconditions: [] },
    };
    const fixtureAppSpec = { 'fixture.js': [{ find: 'before', replace: 'patched' }] };
    const fixtureGlmSpec = { spans: [{ find: 'glm-before', replace: 'glm-marker' }] };
    validateProfileManifest(fixtureManifest, '1.2.3', profileFixtureDir,
      fixtureAppSpec, fixtureGlmSpec);

    let duplicateTargetError;
    try {
      validateProfileManifest({
        ...fixtureManifest,
        targets: [...fixtureManifest.targets, { ...fixtureManifest.targets[0] }],
      }, '1.2.3', profileFixtureDir, fixtureAppSpec, fixtureGlmSpec);
    } catch (error) {
      duplicateTargetError = error;
    }
    assert(duplicateTargetError?.code === 'ZCODE_PATCH_INCOMPATIBLE',
      'duplicate profile target ids are rejected');

    let traversalError;
    try {
      validateProfileManifest({
        ...fixtureManifest,
        targets: [{ ...fixtureManifest.targets[0], path: '../outside.js' }],
      }, '1.2.3', profileFixtureDir, fixtureAppSpec, fixtureGlmSpec);
    } catch (error) {
      traversalError = error;
    }
    assert(traversalError?.code === 'ZCODE_PATCH_INCOMPATIBLE',
      'profile target path traversal is rejected');

    let emptySpanError;
    try {
      validateProfileManifest(fixtureManifest, '1.2.3', profileFixtureDir,
        { 'fixture.js': [{ find: '', replace: 'patched' }] }, fixtureGlmSpec);
    } catch (error) {
      emptySpanError = error;
    }
    assert(emptySpanError?.code === 'ZCODE_PATCH_INCOMPATIBLE',
      'empty profile spans are rejected');

    const extractDir = path.join(profileFixtureDir, 'extract');
    const markerDir = path.join(extractDir, 'assets');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, 'one.js'), 'unique-marker');
    const markerTarget = {
      id: 'marker.target',
      resolver: { type: 'marker-js', directory: 'assets', marker: 'unique-marker' },
    };
    assert(path.basename(resolveProfileTarget({ id: 'fixture' }, markerTarget, extractDir)) === 'one.js',
      'profile marker resolver finds one logical target');
    fs.writeFileSync(path.join(markerDir, 'two.js'), 'unique-marker');
    let ambiguousMarkerError;
    try {
      resolveProfileTarget({ id: 'fixture' }, markerTarget, extractDir);
    } catch (error) {
      ambiguousMarkerError = error;
    }
    assert(ambiguousMarkerError?.code === 'ZCODE_PATCH_INCOMPATIBLE',
      'profile marker resolver rejects ambiguous targets');

    const postconditionFile = path.join(profileFixtureDir, 'postcondition.js');
    fs.writeFileSync(postconditionFile, 'patched');
    verifyPostconditions(postconditionFile, ['patched'], 'fixture postcondition');
    let postconditionError;
    try {
      verifyPostconditions(postconditionFile, ['missing'], 'fixture postcondition');
    } catch (error) {
      postconditionError = error;
    }
    assert(postconditionError?.code === 'ZCODE_PATCH_INCOMPATIBLE',
      'missing profile postconditions are rejected');

    const checksumDir = path.join(profileFixtureDir, 'checksum-profile');
    fs.mkdirSync(checksumDir, { recursive: true });
    const checksumAppSpec = JSON.stringify({ 'fixture.js': [{ find: 'before', replace: 'patched' }] });
    const checksumGlmSpec = JSON.stringify({ spans: [{ find: 'glm-before', replace: 'glm-marker' }] });
    fs.writeFileSync(path.join(checksumDir, 'app.json'), checksumAppSpec);
    fs.writeFileSync(path.join(checksumDir, 'glm.json'), checksumGlmSpec);
    const checksumManifest = {
      schemaVersion: 1,
      id: 'checksum-fixture',
      version: '9.9.9',
      appSpec: 'app.json',
      appSpecSha256: createHash('sha256').update(checksumAppSpec).digest('hex'),
      glmSpec: 'glm.json',
      glmSpecSha256: createHash('sha256').update(checksumGlmSpec).digest('hex'),
      targets: fixtureManifest.targets,
      glm: fixtureManifest.glm,
    };
    fs.writeFileSync(path.join(checksumDir, 'profile.json'), JSON.stringify(checksumManifest));
    fs.writeFileSync(path.join(checksumDir, 'index.json'), JSON.stringify({
      schemaVersion: 1,
      profiles: { '9.9.9': 'profile.json' },
    }));
    const checksumLoaded = loadProfile('9.9.9', checksumDir);
    assert(checksumLoaded.id === 'checksum-fixture', 'profile spec checksums load when valid');
    fs.writeFileSync(path.join(checksumDir, 'app.json'),
      checksumAppSpec.replace('before', 'tampered'));
    let checksumError;
    try {
      loadProfile('9.9.9', checksumDir);
    } catch (error) {
      checksumError = error;
    }
    assert(checksumError?.code === 'ZCODE_PATCH_INCOMPATIBLE' &&
      checksumError.message.includes('spec checksum mismatch'),
      'profile spec checksum tampering is rejected');
  } finally {
    fs.rmSync(profileFixtureDir, { recursive: true, force: true });
  }

  const registry = loadTransformsRegistry();
  for (const candidate of profiles) {
    for (const [key, instances] of candidate.transformInstances) {
      const separator = key.lastIndexOf(':');
      const targetId = key.slice(0, separator);
      const spanIndex = Number(key.slice(separator + 1));
      const span = targetId === 'glm'
        ? candidate.glmSpec.spans[spanIndex]
        : candidate.appSpec[candidate.targets.find(t => t.id === targetId).specKey][spanIndex];
      const semantic = applySemanticEdits(span.find, instances.flatMap(instance => instance.edits),
        `transform fixture ${candidate.version} ${key}`);
      assert(semantic === span.replace,
        `semantic transforms reproduce anchor byte-for-byte: ${candidate.version} ${key} ` +
        `[${instances.map(i => i.id).join(', ')}]`);
    }
  }
  assert(profiles.every(candidate => candidate.transformInstances.size === 31),
    'all mapped spans in every profile are covered by semantic transforms');

  const idMapInstance = registry.transforms
    .find(t => t.id === 'registry.provider-id-map').instances.find(i => i.target === 'glm');
  const renamedContext = glmSpec.spans[3].find.replaceAll('M2', 'Zq9');
  const renamedOutput = applySemanticEdits(renamedContext, idMapInstance.edits, 'renamed fixture');
  assert(renamedOutput !== null && renamedOutput.includes('${Zq9}openai-coding-plan'),
    'semantic locate survives minified identifier renames');
  assert(applySemanticEdits('zapi:`${Aa}zapi`;zapi:`${Bb}zapi`', idMapInstance.edits,
    'ambiguous fixture') === null,
    'ambiguous semantic sites fail closed to the verified anchor');

  const divergenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-openai-divergence-'));
  try {
    const divergenceFile = path.join(divergenceDir, 'target.js');
    fs.writeFileSync(divergenceFile, 'bigmodel:Q9.enum(["oauth","apiKey"]).optional()');
    const methodEdits = registry.transforms
      .find(t => t.id === 'schema.oauth-method-enum').instances[0].edits;
    let divergenceError;
    try {
      applySpansWithTransforms(divergenceFile, [{
        find: 'bigmodel:Q9.enum(["oauth","apiKey"]).optional()',
        replace: 'bigmodel:Q9.enum(["oauth","apiKey"]).optional(),unexpected',
      }], new Map([['fixture:0', [{ id: 'schema.oauth-method-enum', edits: methodEdits }]]]),
        'fixture', 'divergence fixture');
    } catch (error) {
      divergenceError = error;
    }
    assert(divergenceError?.message.includes('diverges from the verified anchor'),
      'semantic output that diverges from the verified anchor is rejected');
  } finally {
    fs.rmSync(divergenceDir, { recursive: true, force: true });
  }

  const oauthAdapter = spec['out/host/index.js'].find(span =>
    span.replace.includes('var openaiSlotPath=')
  );
  assert(oauthAdapter &&
    oauthAdapter.replace.includes('var openaiSlotPath=Dn(wt(),"openai-oauth-result.json")') &&
    !oauthAdapter.replace.includes('C:/Users/'),
    'OAuth callback handoff uses the current ZCode data directory');

  const codexStoreGuard = glmSpec.spans.find(span =>
    span.replace.includes('se=cdx?!1:P?.store')
  );
  assert(codexStoreGuard &&
    codexStoreGuard.replace.indexOf('se=cdx?!1:P?.store') <
      codexStoreGuard.replace.indexOf('te("reasoning.encrypted_content")'),
    'Codex adapter forces store=false before building reasoning continuity');
  const memoryStream = glmSpec.spans.find(span =>
    span.replace.includes('projectMemoryStreamText')
  );
  assert(memoryStream &&
    memoryStream.replace.includes('e.streamText(t)') &&
    memoryStream.replace.includes('case"finish"') &&
    memoryStream.replace.includes('case"error"'),
    'Project Memory uses Codex streaming and collects terminal events');
  const collectorStart = memoryStream.replace.indexOf('async function cgt(');
  const collectorEnd = memoryStream.replace.indexOf('async function pgt(', collectorStart);
  assert(collectorStart >= 0 && collectorEnd > collectorStart,
    'Project Memory stream collector can be isolated for execution tests');
  const collectProjectMemory = Function(
    'v8', 'qV',
    `${memoryStream.replace.slice(collectorStart, collectorEnd)};return cgt`
  )(toolCalls => toolCalls, error => error);
  const glmText = JSON.stringify(glmSpec);
  assert(!glmText.includes('"gpt-5.6-luna"') &&
    !glmSpec.spans.some(span => span.find.startsWith('function m5(')),
    'Subagent validation has no hardcoded OpenAI model reasoning table');
  const builtinProviderFilter = glmSpec.spans.find(span => span.find.startsWith('function RTt('));
  assert(builtinProviderFilter &&
    builtinProviderFilter.replace.includes('e===gs.openai') &&
    builtinProviderFilter.replace.includes('e===gs.openaiCodingPlan') &&
    builtinProviderFilter.replace.includes('e===gs.openaiStartPlan'),
    'GLM workspace catalog admits all built-in OpenAI provider IDs');
  const reasoningLevelsSpan = glmSpec.spans.find(span => span.find.startsWith('function uOi('));
  const reasoningLevels = Function(`${reasoningLevelsSpan?.replace};return uOi`)();
  assert(JSON.stringify(reasoningLevels({ reasoning: { levels: [{ value: 'max' }] } })) === '["max"]' &&
    JSON.stringify(reasoningLevels({ reasoning: { levels: { max: {}, ultra: {} } } })) === '["max","ultra"]',
    'GLM reads protocol-array and internal-object reasoning level formats');

  const chatCompletionsReasoningSpan = profiles.find(candidate => candidate.version === '3.11.2')
    .glmSpec.spans.find(span => span.find.startsWith('function LSo(){let e=lfr();'));
  assert(chatCompletionsReasoningSpan &&
    !chatCompletionsReasoningSpan.replace.includes('openaiCompatible:{thinking:') &&
    chatCompletionsReasoningSpan.replace.includes('openaiCompatible:{reasoningEffort:t}') &&
    chatCompletionsReasoningSpan.replace.includes('openaiCompatible:{reasoningEffort:e===G_?"high":"none"}'),
    'OpenAI-compatible reasoning profiles use reasoningEffort instead of thinking');
  const reasoningProfiles = Function('l2e', 'tfr', 'G_', 'u2e',
    `${chatCompletionsReasoningSpan.replace};return {LSo,BSo}`
  )(['high', 'max'], 1024, 'enabled', ['enabled', 'disabled']);
  const deepSeekReasoning = reasoningProfiles.LSo();
  const toggleReasoning = reasoningProfiles.BSo();
  assert(deepSeekReasoning.max.openaiCompatible.reasoningEffort === 'max' &&
    deepSeekReasoning.max.openaiCompatible.thinking === undefined &&
    deepSeekReasoning.max.anthropic.effort === 'max' &&
    deepSeekReasoning.max.anthropic.thinking.budgetTokens === 1024 &&
    toggleReasoning.enabled.openaiCompatible.reasoningEffort === 'high' &&
    toggleReasoning.disabled.openaiCompatible.reasoningEffort === 'none',
    'OpenAI-compatible reasoning fix preserves Anthropic profiles and maps both toggle states');

  const webFetchStreamSpan = profiles.find(candidate => candidate.version === '3.11.2')
    .glmSpec.spans.find(span => span.find.includes('()=>o.generateText({messages:u,tools:[]'));
  assert(webFetchStreamSpan &&
    webFetchStreamSpan.replace.includes('()=>cgt(o,{messages:u,tools:[]') &&
    !webFetchStreamSpan.replace.includes('()=>o.generateText('),
    'WebFetch prompt processing reuses the OpenAI stream collector');

  const dynamic = spec['out/host/index.js'].find(span =>
    span.find.startsWith('async loadSinglePresetProvider')
  ).replace;
  const makerStart = dynamic.indexOf(',mk=') + 1;
  const makerEnd = dynamic.indexOf(',m2=', makerStart);
  assert(makerStart > 0 && makerEnd > makerStart, 'dynamic model builder is present');
  const makeModel = Function(`let ${dynamic.slice(makerStart, makerEnd)};return mk`)();
  const visible = model => model && model.supported_in_api !== false &&
    model.visibility !== 'hide' && typeof model.slug === 'string' && model.slug.length > 0;
  const catalog = [
    {
      slug: 'gpt-fixture-a', display_name: 'GPT Fixture A', context_window: 111000,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'preview' }],
      default_reasoning_level: 'preview', input_modalities: ['text', 'image'],
      visibility: 'list', supported_in_api: true,
    },
    {
      slug: 'gpt-fixture-b', display_name: 'GPT Fixture B', context_window: 222000,
      supported_reasoning_levels: ['medium'], default_reasoning_level: 'medium',
      input_modalities: ['text'], visibility: 'list', supported_in_api: true,
    },
    { slug: 'gpt-reserve', visibility: 'hide', supported_in_api: true },
    { slug: 'not-in-api', visibility: 'list', supported_in_api: false },
  ];
  const models = catalog.filter(visible).map(model => makeModel(model, true));
  assert(models.length === 2, 'hidden and unsupported models are filtered');
  assert(models[0].contextWindow === 111000 && models[1].contextWindow === 222000,
    'each catalog context_window is propagated independently');
  assert(models[0].catalogContextWindow === 111000 &&
    models[1].catalogContextWindow === 222000,
    'official context baselines are attached to catalog models');
  assert(makeModel(catalog[0]).catalogContextWindow === undefined,
    'network fallback does not masquerade as an official baseline');
  assert(models[0].modalities.input.includes('image'), 'catalog input modalities are propagated');
  assert(models[0].reasoning.defaultLevel === 'preview' &&
    models[0].reasoning.levels.preview.openai.set[0].path[0] === 'store' &&
    models[0].reasoning.levels.preview.openai.set[0].value === false &&
    models[0].reasoning.levels.preview.openai.set[1].path[0] === 'reasoningEffort' &&
    models[0].reasoning.levels.preview.openai.set[1].value === 'preview',
    'new catalog reasoning levels propagate without source model tables');
  assert(!dynamic.includes('400000') && !dynamic.includes('maxOutputTokens'),
    'OAuth models do not use the old 400k/128k limits');
  assert(dynamic.includes('visibility!=="hide"') &&
    dynamic.includes('fetchFreshOpenAiCatalogModel'),
    'runtime filters hidden models and exposes fresh targeted lookup');
  const independentOpenAiLoad = spec['out/host/index.js'].find(span =>
    span.replace.includes('loadSinglePresetProvider([],"openai"')
  );
  const skipDuplicateOpenAiLoad = spec['out/host/index.js'].find(span =>
    span.replace.includes('Bj.filter(u=>u!=="openai")')
  );
  assert(independentOpenAiLoad && skipDuplicateOpenAiLoad,
    'OpenAI preset loads before and independently of the Z.ai client-config service');
  assert(dynamic.includes('c.every(x=>Number.isInteger(x.context_window)&&x.context_window>0)'),
    'official catalog sync rejects incomplete context metadata instead of inventing a baseline');

  const reasoningOverride = glmSpec.spans.find(span => span.find.startsWith('function abt('));
  assert(reasoningOverride &&
    reasoningOverride.replace.indexOf('t.reasoning){') <
      reasoningOverride.replace.indexOf('t.reasoningProfile===Rle'),
    'explicit persisted reasoning metadata precedes model-name heuristics');
  const buildReasoningOverride = Function(
    'Rle', 't4', 'bB', 'z6', 'uOi', 'cOi', 'dOi', 'lOi', 'wOi',
    'Eve', 'Z$', 'jX', 'Cve', 'Ave', 'Tve', 's',
    `${reasoningOverride.replace};return abt`
  );
  const projectReasoning = buildReasoningOverride(
    Symbol('profile'), () => true, () => false, () => false,
    model => model.reasoning.levels.map(level => level.value),
    options => options,
    (provider, model) => model.reasoning.providerOptionsByLevel,
    (level, levels) => levels.includes(level) ? level : undefined,
    () => undefined, () => ({}), () => ({}), () => ({}), () => ({}),
    () => ({}), () => ({}), value => value
  )({ kind: 'openai' }, {
    modelId: 'gpt-new-name',
    reasoning: {
      enabled: true,
      defaultLevel: 'preview',
      levels: [{ value: 'preview' }],
      providerOptionsByLevel: { preview: { openai: { store: false, reasoningEffort: 'preview' } } },
    },
  });
  assert(projectReasoning.supportsReasoning === true &&
    projectReasoning.reasoning.levels.length === 1 &&
    projectReasoning.reasoning.levels[0] === 'preview' &&
    projectReasoning.reasoning.providerOptionsByLevel.preview.openai.reasoningEffort === 'preview',
    'Subagent catalog overlay consumes dynamic persisted reasoning variants');

  const mergeOverride = spec['out/host/index.js'].find(span =>
    span.replace.includes('e.providerId===te.openai||e.providerId===te.openaiCodingPlan')
  );
  assert(mergeOverride && mergeOverride.replace.includes('catalogContextWindow') &&
    mergeOverride.replace.includes('replaceLocalModifiedWithAuthoritative:!0'),
    'OpenAI merge uses official baselines while refreshing authoritative capabilities');
  const mergeModels = Function('te', 'Pse', 'kse', 'Wh', 'nse',
    `return function(e){${mergeOverride.replace}}`
  )(
    { openai: 'openai', openaiCodingPlan: 'openai-coding', openaiStartPlan: 'openai-start' },
    options => options.authoritativeModels,
    entries => entries,
    model => typeof model === 'string' ? model : model.id,
    (target, seen, entries) => target.push(...entries)
  );
  const merged = mergeModels({
    providerId: 'openai-coding',
    incoming: { models: [
      { id: 'a', contextWindow: 333000, catalogContextWindow: 333000, reasoning: { official: 2 } },
      { id: 'b', contextWindow: 444000, catalogContextWindow: 444000, reasoning: { official: 2 } },
    ] },
    existing: { models: [
      { id: 'a', contextWindow: 111000, catalogContextWindow: 111000, reasoning: { official: 1 } },
      { id: 'b', contextWindow: 555000, catalogContextWindow: 222000, reasoning: { official: 1 } },
    ] },
  });
  assert(merged[0].contextWindow === 333000 && merged[0].catalogContextWindow === 333000,
    'unmodified context follows a changed official baseline');
  assert(merged[1].contextWindow === 555000 && merged[1].catalogContextWindow === 444000 &&
    merged[1].reasoning.official === 2,
    'ordinary refresh preserves only manual context while updating official capabilities');
  const fallbackExisting = [{ id: 'a', contextWindow: 123000, reasoning: { cached: true } }];
  const fallbackMerged = mergeModels({
    providerId: 'openai-coding',
    incoming: { models: [{ id: 'a', contextWindow: 272000 }] },
    existing: { models: fallbackExisting },
  });
  assert(JSON.stringify(fallbackMerged) === JSON.stringify(fallbackExisting),
    'catalog failure preserves the last persisted model catalog');

  const repairSpan = spec['out/host/index.js'].find(span =>
    span.replace.includes('async repairOpenAiContextWindow(q)')
  );
  const repairSource = repairSpan?.replace.match(
    /(async repairOpenAiContextWindow\(q\)\{[\s\S]*?\}),async refreshCodingPlanApiKey/
  )?.[1];
  assert(repairSource, 'targeted context repair method is present');
  function createRepairFixture(providerModels, fetchModel) {
    let providers = [{ id: 'openai-coding', models: JSON.parse(JSON.stringify(providerModels)) }];
    let fetchCount = 0;
    let writeCount = 0;
    const repair = Function('te', 'a', 'xi', 'So', 'us', 'D', 'g',
      `return {${repairSource}}.repairOpenAiContextWindow`
    )(
      { openai: 'openai', openaiCodingPlan: 'openai-coding', openaiStartPlan: 'openai-start' },
      { async fetchFreshOpenAiCatalogModel(modelId) { fetchCount += 1; return fetchModel(modelId); } },
      operation => operation(),
      async () => JSON.parse(JSON.stringify(providers)),
      async value => { providers = value; writeCount += 1; },
      () => {},
      new Set()
    );
    return {
      repair,
      get providers() { return providers; },
      get fetchCount() { return fetchCount; },
      get writeCount() { return writeCount; },
    };
  }
  const repairFixture = createRepairFixture([
    { id: 'sol', contextWindow: 777000, catalogContextWindow: 272000 },
    { id: 'luna', contextWindow: 888000, catalogContextWindow: 272000, reasoning: { keep: true } },
  ], modelId => modelId === 'luna' ? { slug: 'luna', context_window: 272000 } : null);
  const siblingBefore = JSON.stringify(repairFixture.providers[0].models[0]);
  return Promise.resolve().then(async () => {
    const streamed = await collectProjectMemory({
      providerId: 'builtin:openai-coding-plan',
      async *streamText() {
        yield { type: 'text_delta', text: 'hello ' };
        yield { type: 'text_delta', text: 'world' };
        yield { type: 'tool_call', toolCall: { id: 'tool-1', name: 'remember' } };
        yield { type: 'tool_call', toolCall: { id: 'tool-1', name: 'remember' } };
        yield { type: 'finish', finishReason: 'tool-calls', usage: { totalTokens: 12 } };
      },
    }, {});
    assert(streamed.text === 'hello world' && streamed.finishReason === 'tool-calls' &&
      streamed.usage.totalTokens === 12 && streamed.toolCalls.length === 1,
      'Project Memory aggregates OpenAI stream text, usage, and deduplicated tool calls');

    let generated = false;
    const nonOpenAi = await collectProjectMemory({
      providerId: 'custom:test',
      async generateText() { generated = true; return { text: 'fallback' }; },
    }, {});
    assert(generated && nonOpenAi.text === 'fallback',
      'Project Memory keeps generateText for non-OpenAI providers');

    let streamError;
    try {
      await collectProjectMemory({
        providerId: 'builtin:openai-coding-plan',
        async *streamText() { yield { type: 'error', error: new Error('stream failed') }; },
      }, {});
    } catch (error) {
      streamError = error;
    }
    assert(streamError?.message === 'stream failed',
      'Project Memory propagates OpenAI stream error events');

    let missingFinish;
    try {
      await collectProjectMemory({
        providerId: 'builtin:openai-coding-plan',
        async *streamText() { yield { type: 'text_delta', text: 'partial' }; },
      }, {});
    } catch (error) {
      missingFinish = error;
    }
    assert(missingFinish?.message === 'Project Memory stream ended before finish',
      'Project Memory rejects truncated streams without a finish event');

    return repairFixture.repair({
      providerId: 'openai-coding', modelId: 'luna', requestId: 'request-1',
    });
  }).then(async repaired => {
    assert(repaired === true && repairFixture.writeCount === 1,
      'context error repair writes one provider transaction');
    assert(repairFixture.providers[0].models[1].contextWindow === 272000 &&
      repairFixture.providers[0].models[1].catalogContextWindow === 272000 &&
      repairFixture.providers[0].models[1].reasoning.keep === true,
      'context error repair restores only the current model context');
    assert(JSON.stringify(repairFixture.providers[0].models[0]) === siblingBefore,
      'context error repair leaves sibling models byte-for-byte unchanged');
    await repairFixture.repair({
      providerId: 'openai-coding', modelId: 'luna', requestId: 'request-1',
    });
    assert(repairFixture.fetchCount === 1 && repairFixture.writeCount === 1,
      'one request triggers at most one catalog repair');

    const smaller = createRepairFixture([
      { id: 'luna', contextWindow: 200000, catalogContextWindow: 272000 },
    ], () => ({ slug: 'luna', context_window: 272000 }));
    assert(await smaller.repair({
      providerId: 'openai-coding', modelId: 'luna', requestId: 'request-2',
    }) === false && smaller.writeCount === 0 &&
      smaller.providers[0].models[0].contextWindow === 200000,
    'targeted repair never increases a smaller user context');

    const unavailable = createRepairFixture([
      { id: 'luna', contextWindow: 888000, catalogContextWindow: 272000 },
    ], async () => { throw new Error('catalog unavailable'); });
    assert(await unavailable.repair({
      providerId: 'openai-coding', modelId: 'luna', requestId: 'request-3',
    }) === false && unavailable.writeCount === 0,
    'catalog failure does not guess or write a context value');

    const failureBoundary = spec['out/host/index.js'].find(span =>
      span.replace.includes('repairOpenAiContextWindow({providerId:nt,modelId:mt,requestId:vn})')
    );
    assert(failureBoundary && failureBoundary.replace.includes('_e(pe.reason)==="context_exceeded"') &&
      !failureBoundary.replace.includes('Gr(pe.statusCode)===400'),
      'only normalized context failures trigger catalog repair');

    const iconOverride = spec['out/renderer/assets/styles-C2WGZ-SY.js'].find(span =>
      span.replace.includes('CBe={[Ii]:SBe,zai:N_,openai:')
    );
    assert(iconOverride &&
      iconOverride.replace.includes('backgroundColor:`currentColor`') &&
      iconOverride.replace.includes('maskImage:`url("${n}")`') &&
      !iconOverride.replace.includes('%2310A37F'),
      'OpenAI icon follows the current theme color');

    const iconOverride3112 = profiles.find(candidate => candidate.version === '3.11.2')
      .appSpec['out/renderer/assets/styles-DyAcaLKy.js'].find(span =>
        span.replace.includes('UUe,zai:s_,openai:'));
    assert(iconOverride3112 &&
      iconOverride3112.replace.includes('backgroundColor:`currentColor`') &&
      iconOverride3112.replace.includes('maskImage:`url("${n}")`'),
      'OpenAI icon follows the current theme color (3.11.2)');

    for (const rel of ['out/host/index.js', 'out/main/index.js', 'out/scheduler/index.js']) {
      const oauthPreset = spec[rel].find(span => span.replace.includes('name:"OpenAI - OAuth"')).replace;
      assert(oauthPreset.includes('contextWindow:272000'), `${rel} fallback context is conservative`);
      assert(oauthPreset.includes('reasoningEffort'), `${rel} fallback has reasoning metadata`);
    }

  const config = { provider: {
    'builtin:openai-coding-plan': { generated: true },
    'custom:keep': { generated: false },
  } };
  const agents = {
    builtInModelOverrides: {
      Explore: 'custom:builtin%3Aopenai-coding-plan:gpt-5.6-luna',
      judge: 'custom:keep:model',
    },
    builtInThoughtLevelOverrides: { Explore: 'medium', judge: 'high' },
  };
  const cleaned = cleanStateObjects(config, agents);
  assert(cleaned.configChanged && cleaned.agentsChanged, 'stale state is detected');
  assert(config.provider['custom:keep'] && !config.provider['builtin:openai-coding-plan'],
    'cleanup removes only generated OpenAI providers');
  assert(agents.builtInModelOverrides.judge && !agents.builtInModelOverrides.Explore,
    'cleanup preserves unrelated agent model overrides');
  assert(agents.builtInThoughtLevelOverrides.judge && !agents.builtInThoughtLevelOverrides.Explore,
    'cleanup removes only the paired thought override');

  assert(classifyGlmBackupFacts({
    exists: true, pristine: true, metadataHashMatches: false,
    metaVersion: '',
  }, '3.10.2') === 'invalid', 'legacy GLM backup without a hash is rejected');
  assert(classifyGlmBackupFacts({
    exists: true, pristine: true, metadataHashMatches: false,
    metaVersion: '3.10.2',
  }, '3.10.2') === 'invalid', 'GLM backup hash mismatch is rejected');
  assert(classifyGlmBackupFacts({
    exists: true, pristine: true, metadataHashMatches: true,
    metaVersion: '3.10.1',
  }, '3.10.2') === 'invalid', 'cross-version GLM backup is rejected');

  const hashFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-openai-hash-test-'));
  const hashFixture = path.join(hashFixtureDir, 'backup');
  try {
    fs.writeFileSync(hashFixture, 'pristine');
    assert(!metadataHashMatches({}, hashFixture), 'backup without SHA-256 metadata is rejected');
    const hash = fileSha256(hashFixture);
    assert(metadataHashMatches({ sha256: hash }, hashFixture), 'matching backup SHA-256 is accepted');
    fs.writeFileSync(hashFixture, 'tampered');
    assert(!metadataHashMatches({ sha256: hash }, hashFixture), 'tampered backup is rejected');
  } finally {
    fs.rmSync(hashFixtureDir, { recursive: true, force: true });
  }

  const transactionPaths = {
    ASAR: 'live-app', GLM: 'live-glm', BACKUP: 'backup-app', GLM_BAK: 'backup-glm',
  };
  const transactionFiles = {
    'new-app': 'new-app', 'new-glm': 'new-glm',
    'live-app': 'old-app', 'live-glm': 'old-glm',
    'backup-app': 'old-app', 'backup-glm': 'old-glm',
  };
  let transactionError;
  try {
    replaceRuntimeFiles(transactionPaths, 'new-app', 'new-glm', (source, destination) => {
      if (source === 'new-glm') throw new Error('second replacement failed');
      transactionFiles[destination] = transactionFiles[source];
    });
  } catch (error) {
    transactionError = error;
  }
  assert(transactionError?.message.includes('both files were rolled back') &&
    transactionFiles['live-app'] === 'old-app' && transactionFiles['live-glm'] === 'old-glm',
    'failure between runtime replacements rolls back both files');

  let rollbackError;
  try {
    replaceRuntimeFiles(transactionPaths, 'new-app', 'new-glm', source => {
      if (source === 'new-glm') throw new Error('deployment failed');
      if (source === 'backup-app') throw new Error('rollback failed');
    });
  } catch (error) {
    rollbackError = error;
  }
  assert(rollbackError?.message.includes('deployment failed and rollback also failed'),
    'rollback failure is reported explicitly');

  assert(patchText('a', [
    { find: 'a', replace: 'b' },
    { find: 'b', replace: 'c' },
  ], 'fixture') === 'c', 'spans are validated sequentially');

    console.log('[OK] self-test: dynamic catalog, context repair, reasoning, cleanup, and backups');
  });
}

async function main() {
  if (SELF_TEST) return selfTest();
  if (dirIdx >= 0 && !REQUESTED_INSTALL) throw new Error('--dir requires a path');
  if (PROBE && (DRY || NO_DEPLOY || RESTORE)) {
    throw new Error('--probe cannot be combined with --dry-run, --no-deploy, or --restore');
  }

  const install = REQUESTED_INSTALL || findInstall();
  let paths = installPaths(install);
  console.log('ZCode install:', install);
  if (!fs.existsSync(paths.ASAR)) throw new Error(`app.asar not found at ${paths.ASAR}`);

  const version = packageVersion(paths.ASAR);
  if (!version) throw new Error('could not read the installed ZCode package version');
  if (PROBE) return probeCompatibility(paths, version);

  const profile = loadProfile(version);
  paths = applyProfilePaths(paths, profile);
  if (!fs.existsSync(paths.GLM)) throw compatibilityError(`profile ${profile.id} GLM path is missing: ${paths.GLM}`);
  console.log(`compatibility profile: ${profile.id}`);
  if (RESTORE) return restore(paths, profile);

  const liveAppPatched = asarHasPatch(paths.ASAR);
  let prepared;
  try {
    prepared = await prepareProfile(paths, version, profile);

    if (DRY) {
      console.log('\ndry-run: profile, anchors, postconditions, syntax checks, and isolated repack passed; live files were untouched.');
      return;
    }

    if (NO_DEPLOY) {
      const appDestination = `${paths.ASAR}.patched`;
      const glmDestination = `${paths.GLM}.patched`;
      copyVerified(prepared.appOutput, appDestination);
      const unpackedOutput = `${prepared.appOutput}.unpacked`;
      const unpackedDestination = `${appDestination}.unpacked`;
      fs.rmSync(unpackedDestination, { recursive: true, force: true });
      if (fs.existsSync(unpackedOutput)) fs.cpSync(unpackedOutput, unpackedDestination, { recursive: true });
      copyVerified(prepared.glmOutput, glmDestination);
      console.log(`[packed] ${appDestination}`);
      console.log(`[packed] ${glmDestination}`);
      console.log('deploy skipped; live files were untouched.');
      return;
    }

    deployPrepared(paths, version, prepared.appOutput, prepared.glmOutput, profile);
    console.log('\nDone. ZCode restarted. Open Settings -> Model Providers -> OpenAI.');
  } catch (error) {
    if (error && error.code === 'ZCODE_PATCH_INCOMPATIBLE' &&
        !PROBE && !DRY && !NO_DEPLOY && !liveAppPatched) {
      cleanupStaleOpenAiState(paths);
    }
    throw error;
  } finally {
    if (prepared?.stageDir) fs.rmSync(prepared.stageDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('\n[FAIL] ' + (error && error.stack || String(error)));
  process.exitCode = 1;
});

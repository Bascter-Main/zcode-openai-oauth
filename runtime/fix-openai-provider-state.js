#!/usr/bin/env node
/*
 * Clears the stale disabled state left on the OpenAI providers by an earlier
 * logout:  enabled:false + systemDisabledReason ("oauth_provider_inactive" or
 * "coding_plan_not_connected"). Run with ZCode CLOSED.
 *
 *   node runtime/fix-openai-provider-state.js [--data <ZCode data base dir>] [--dry-run]
 *
 * The data base dir defaults to the `dataBaseDir` recorded in the ZCode
 * settings file; the provider store is <dataBaseDir>/.zcode/v2/config.json.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const dataIdx = args.indexOf('--data');
const DRY = args.includes('--dry-run');

const OPENAI_IDS = ['builtin:openai', 'builtin:openai-coding-plan', 'builtin:openai-start-plan'];

function resolveDataDir() {
  if (dataIdx >= 0 && args[dataIdx + 1]) return path.resolve(args[dataIdx + 1]);
  const settingsPaths = [
    path.join(os.homedir(), '.zcode', 'v2', 'setting.json'),
    path.join(process.env.APPDATA || '', 'ZCode', 'setting.json'),
  ];
  for (const candidate of settingsPaths) {
    try {
      const settings = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (typeof settings.dataBaseDir === 'string' && settings.dataBaseDir.trim()) {
        return path.resolve(settings.dataBaseDir.trim());
      }
    } catch {}
  }
  return null;
}

const dataDir = resolveDataDir();
if (!dataDir) {
  console.error('fix-openai-provider-state: pass --data <ZCode data base dir>');
  process.exit(1);
}
const configPath = path.join(dataDir, '.zcode', 'v2', 'config.json');
if (!fs.existsSync(configPath)) {
  console.error(`fix-openai-provider-state: no provider store at ${configPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(configPath, 'utf8');
const config = JSON.parse(raw);
if (!config.provider || typeof config.provider !== 'object') {
  console.error('fix-openai-provider-state: provider store has no provider map');
  process.exit(1);
}

let changed = 0;
for (const id of OPENAI_IDS) {
  const entry = config.provider[id];
  if (!entry) {
    console.log(`  ${id}: absent, nothing to do`);
    continue;
  }
  if (entry.enabled !== false && !entry.systemDisabledReason) {
    console.log(`  ${id}: already enabled, nothing to do`);
    continue;
  }
  console.log(`  ${id}: enabled ${entry.enabled} -> true, clearing reason ` +
    `"${entry.systemDisabledReason ?? ''}"`);
  entry.enabled = true;
  delete entry.systemDisabledReason;
  changed++;
}

if (!changed) {
  console.log('fix-openai-provider-state: no stale OpenAI disable state found');
  process.exit(0);
}
if (DRY) {
  console.log('fix-openai-provider-state: dry run, nothing written');
  process.exit(0);
}
fs.copyFileSync(configPath, `${configPath}.openai-fix-backup`);
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`fix-openai-provider-state: updated ${changed} provider(s); ` +
  `backup at ${path.basename(configPath)}.openai-fix-backup`);

'use strict';
/*
 * Shared pure-text patch core.
 *
 * Used by patch.js (static patching, strict mode) and by the runtime loader
 * (runtime/, fail-soft mode). No fs, no process state — text in, text out.
 */

function patchError(message) {
  const error = new Error(message);
  error.code = 'ZCODE_PATCH_INCOMPATIBLE';
  return error;
}

function countMatches(text, needle) {
  return text.split(needle).length - 1;
}

function expandTransformTemplate(template, match) {
  return template.replace(/\$(\d)/g, (m, n) => match[Number(n)] ?? '');
}

// Returns null when any locate does not match exactly once.
function applySemanticEdits(text, edits) {
  let result = text;
  for (const edit of edits) {
    const matches = [...result.matchAll(new RegExp(edit.locate, 'g'))];
    if (matches.length !== 1) return null;
    const match = matches[0];
    if (edit.operation === 'insert-after-match') {
      const at = match.index + match[0].length;
      result = result.slice(0, at) + expandTransformTemplate(edit.insert, match) + result.slice(at);
    } else if (edit.operation === 'replace-match') {
      result = result.slice(0, match.index) + expandTransformTemplate(edit.template, match) +
        result.slice(match.index + match[0].length);
    } else {
      return null;
    }
  }
  return result;
}

// Map `${target}:${spanIndex}` -> [{id, edits}] for the transforms a profile declares.
function buildTransformInstances(profile, registry) {
  const declared = new Set(profile.transforms ?? []);
  const bySpan = new Map();
  for (const transform of registry.transforms) {
    if (!declared.has(transform.id)) continue;
    for (const instance of transform.instances) {
      const spans = instance.target === 'glm'
        ? profile.glmSpec.spans
        : profile.appSpec[profile.targets.find(t => t.id === instance.target)?.specKey];
      if (!spans || instance.span >= spans.length) {
        throw patchError(
          `transform ${transform.id} references a missing span: ${instance.target}#${instance.span + 1}`);
      }
      const key = `${instance.target}:${instance.span}`;
      if (!bySpan.has(key)) bySpan.set(key, []);
      bySpan.get(key).push({ id: transform.id, edits: instance.edits });
    }
  }
  for (const id of declared) {
    if (!registry.transforms.some(t => t.id === id)) {
      throw patchError(`profile ${profile.id} declares an unknown transform: ${id}`);
    }
  }
  return bySpan;
}

// Apply spans with optional semantic transforms.
//   strict: every anchor must match exactly once; semantic output must equal the
//           verified anchor output. Throws on any deviation.
//   soft:   anchor match wins; otherwise semantic locate; otherwise record the
//           failure and leave that span's text unchanged. Never throws.
// Returns { text, levels, failures }.
function applySpansText(text, spans, instancesBySpan, targetKey, { strict, label }) {
  const levels = [];
  const failures = [];
  let result = text;
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index];
    const instances = instancesBySpan ? instancesBySpan.get(`${targetKey}:${index}`) : null;
    const ids = instances ? instances.map(instance => instance.id) : null;
    const anchorCount = countMatches(result, span.find);
    if (strict) {
      if (anchorCount !== 1) {
        throw patchError(
          `${label}: anchor ${index + 1}/${spans.length} matched ${anchorCount} times; ` +
          'this ZCode version changed the patched code.');
      }
      const expected = result.replace(span.find, span.replace);
      if (instances) {
        const semantic = applySemanticEdits(result, instances.flatMap(instance => instance.edits));
        if (semantic !== null) {
          if (semantic !== expected) {
            throw new Error(
              `${label}: semantic transform ${ids.join(', ')} diverges from the verified anchor ${index + 1}`);
          }
          levels.push({ span: index + 1, level: 'semantic', ids });
          result = semantic;
          continue;
        }
        levels.push({ span: index + 1, level: 'anchor-fallback', ids });
      } else {
        levels.push({ span: index + 1, level: 'anchor' });
      }
      result = expected;
      continue;
    }
    if (anchorCount === 1) {
      result = result.replace(span.find, span.replace);
      levels.push({ span: index + 1, level: 'anchor' });
      continue;
    }
    if (instances) {
      const semantic = applySemanticEdits(result, instances.flatMap(instance => instance.edits));
      if (semantic !== null) {
        levels.push({ span: index + 1, level: 'semantic', ids });
        result = semantic;
        continue;
      }
    }
    failures.push({ span: index + 1, anchorMatches: anchorCount, transforms: ids });
    levels.push({ span: index + 1, level: 'failed' });
  }
  return { text: result, levels, failures };
}

// --- critical cross-span data-flow invariants (pure text checks) ---

function criticalRendererPartitionsIssue(text, normalized) {
  const id = '[A-Za-z_$][\\w$]*';
  const branch = operator => [...text.matchAll(new RegExp(
    `items:${normalized}\\.filter\\((${id})=>(${id})\\(\\1\\.presetId\\)${operator}\\x60openai\\x60\\)`,
    'g'))];
  const regular = branch('!==');
  const openai = branch('===');
  if (regular.length !== 1 || openai.length !== 1) {
    return `expected one regular and one OpenAI partition over ${normalized}`;
  }
  if (regular[0][2] !== openai[0][2]) return 'provider partitions use different family classifiers';
  return null;
}

function criticalRendererSettingsIssue(text) {
  const id = '[A-Za-z_$][\\w$]*';
  const mappings = [...text.matchAll(new RegExp(
    `let (${id})=(${id})\\.map\\(\\(\\{id:(${id}),displayName:(${id}),provider:(${id})\\}\\)=>` +
    `\\(\\{key:[\\s\\S]{0,160}?type:\\x60preset\\x60,presetId:\\3,label:\\4,provider:\\5`, 'g'))];
  if (mappings.length !== 1) return `expected one normalized preset-provider mapping, found ${mappings.length}`;
  return criticalRendererPartitionsIssue(text, mappings[0][1]);
}

function criticalRendererProfileIssue(spans) {
  const mappings = [];
  for (const span of spans) {
    for (const match of span.replace.matchAll(/let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.map\(/g)) {
      mappings.push(match);
    }
  }
  if (mappings.length !== 1) return `expected one profile-level preset mapping, found ${mappings.length}`;
  return criticalRendererPartitionsIssue(spans.map(span => span.replace).join('\n'), mappings[0][1]);
}

function criticalHostMainIssue(text) {
  const id = '[A-Za-z_$][\\w$]*';
  const headers = [...text.matchAll(new RegExp(
    `async loadPresetProviders\\((${id})\\)\\{let (${id})=\\[\\],(${id})=\\[\\];`, 'g'))];
  if (headers.length !== 1) return `expected one loadPresetProviders provider array, found ${headers.length}`;
  const providers = headers[0][2];
  const loads = [...text.matchAll(new RegExp(
    `,(${id})=await this\\.loadSinglePresetProvider\\(\\[\\],[\"'\\x60]openai[\"'\\x60],` +
    `[\\s\\S]{0,240}?\\)\\.catch\\(\\(\\)=>null\\);`, 'g'))];
  if (loads.length !== 1) return `expected one independent OpenAI preset load, found ${loads.length}`;
  const openai = loads[0][1];
  const push = `${openai}&&${providers}.push(${openai});`;
  if (countMatches(text, push) !== 1) return `OpenAI preset is not pushed into the captured provider array ${providers}`;
  return null;
}

function criticalTargetSemanticIssue(targetId, text) {
  if (targetId === 'renderer.settings') return criticalRendererSettingsIssue(text);
  if (targetId === 'host.main') return criticalHostMainIssue(text);
  return null;
}

module.exports = {
  patchError,
  countMatches,
  expandTransformTemplate,
  applySemanticEdits,
  buildTransformInstances,
  applySpansText,
  criticalRendererPartitionsIssue,
  criticalRendererSettingsIssue,
  criticalRendererProfileIssue,
  criticalHostMainIssue,
  criticalTargetSemanticIssue,
};

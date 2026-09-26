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
    let span = spans[index];
    if (span.resolver) {
      // Source-semantic span: locate the anchor from stable keepNames / string
      // literals at apply time, so the profile survives minifier renaming.
      const resolver = RESOLVERS[span.resolver];
      let resolved = null;
      let resolveError = null;
      if (resolver) {
        try {
          resolved = resolver(result, span.params || {});
        } catch (error) {
          resolveError = error;
        }
      } else {
        resolveError = new Error(`unknown resolver: ${span.resolver}`);
      }
      if (!resolved || typeof resolved.find !== 'string' || typeof resolved.replace !== 'string') {
        const message = resolveError ? resolveError.message : 'resolver returned no span';
        if (strict) {
          throw patchError(`${label}: resolver ${span.resolver} (${index + 1}/${spans.length}) failed: ${message}`);
        }
        failures.push({ span: index + 1, resolver: span.resolver, error: message });
        levels.push({ span: index + 1, level: 'failed' });
        continue;
      }
      span = { find: resolved.find, replace: resolved.replace };
    }
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
  if (text.includes('ZcodeOpenAiOAuthAdapter')) {
    // 3.14.x resolver architecture: verify the OpenAI OAuth + managed-provider wiring
    // landed as a coherent whole instead of the 3.11.x provider-array data flow.
    if (!/function \w+\(\w+=process\.env\)\{return\{providers:\[[^\]]*,zcodeOaiProviderConfig\(\w+\)\]\}\}/
      .test(text)) return 'OpenAI provider config is not registered in createOAuthRuntimeConfig';
    if (!/case"openai":\w+\.push\(new ZcodeOpenAiOAuthAdapter\(\w+,\w+\)\);break;/.test(text)) {
      return 'OpenAI adapter is not registered in createOAuthProviderAdapters';
    }
    if (!text.includes('async exchangeToken(') || !text.includes('function zcodeOaiSyncNow')) {
      return 'OpenAI managed-provider sync is missing';
    }
    if (!text.includes('zcodeOaiStartupSync(') || !text.includes('zcodeOaiRemoveProvider()')) {
      return 'OpenAI startup/logout provider sync hooks are missing';
    }
    if (!text.includes('"openai"&&await this.repo.setActiveProvider(') ||
        !text.includes('zcodeOaiActive!=="openai"')) {
      return 'OpenAI login must not become the active app account';
    }
    if (!text.includes('managedModelIds') || !text.includes('explicitManualIds') ||
        !text.includes('userIds=currentIds.filter')) {
      return 'OpenAI catalog sync must preserve manual models and track managed model ids';
    }
    if (!text.includes('zcodeOaiManualSync') ||
        !text.includes('zcodeOaiManualOk=await zcodeOaiManualSync()') ||
        !text.includes('OpenAI catalog refresh failed: ')) {
      return 'OpenAI manual catalog refresh hook is missing';
    }
    if (!text.includes('zcodeOaiClientVersion') ||
        !text.includes('registry.npmjs.org/@openai/codex/latest') ||
        !text.includes('clientVersionCheckedAt')) {
      return 'OpenAI catalog client-version discovery is missing';
    }
    if (!text.includes('await this.repo.clearProvider("openai")')) {
      return 'OpenAI logout must clear the non-active Codex credential';
    }
    if (!text.includes('OpenAI provider name is managed') ||
        !text.includes('OpenAI provider endpoint is managed')) {
      return 'OpenAI provider identity and endpoint save guards are missing';
    }
    return null;
  }
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

function criticalRendererIconsIssue(text) {
  if (countMatches(text, 'openai:"data:image/svg+xml,') !== 1) {
    return 'OpenAI provider icon entry is missing or duplicated';
  }
  if (countMatches(text, 'backgroundColor:`currentColor`') !== 1 ||
      !text.includes('WebkitMaskImage:`url("')) {
    return 'OpenAI login icon must render through a theme-adaptive currentColor mask';
  }
  if (!text.includes('.result.provider!=="openai"&&') ||
      countMatches(text, '.result.provider!=="openai"&&') !== 2) {
    return 'OAuth callback must not adopt the OpenAI identity or family domain';
  }

  const id = '[A-Za-z_$][\\w$]*';
  const staleStartPlanItems = [...text.matchAll(new RegExp(
    `\\.\\.\\.(${id})\\.filter\\((${id})=>(${id})\\(\\2\\.presetId\\)\\)`, 'g'))];
  if (staleStartPlanItems.length !== 0) {
    return 'legacy Start Plan navigation items are still appended to the preset group';
  }

  const providerId = '"zcode-openai-codex"';
  const presetIndex = text.indexOf('id:`preset`,title:');
  const openaiIndex = text.indexOf('id:`openai`,title:`OpenAI`');
  const customIndex = text.indexOf('id:`custom`,title:');
  if (presetIndex < 0 || openaiIndex < presetIndex || customIndex < openaiIndex) {
    return 'OpenAI settings group must appear once between preset and custom groups';
  }
  if (countMatches(text, 'id:`openai`,title:`OpenAI`') !== 1) {
    return 'OpenAI settings group is missing or duplicated';
  }
  if (text.slice(presetIndex, openaiIndex).includes(providerId.slice(1, -1))) {
    return 'OpenAI must not be appended to the preset settings items';
  }

  const openaiGroups = [...text.matchAll(new RegExp(
    `id:\\x60openai\\x60,title:\\x60OpenAI\\x60,items:\\((${id})\\.some\\((${id})=>` +
    `\\2\\.providerId===${providerId}\\)\\?\\1\\.filter\\(\\2=>\\2\\.providerId===${providerId}\\)` +
    `\\.map\\(\\2=>\\(\\{key:(${id})\\(\\2\\.providerId\\),type:\\x60custom\\x60,label:(${id})\\(\\2\\),` +
    `provider:\\2,statusActive:\\2\\.executable===!0\\}\\)\\):\\[\\{key:\\3\\(${providerId}\\),` +
    `type:\\x60custom\\x60,label:\\x60OpenAI\\x60,provider:null,statusActive:!1\\}\\]\\)`, 'g'))];
  const customGroups = [...text.matchAll(new RegExp(
    `id:\\x60custom\\x60,title:(${id})\\.formatMessage\\(\\{id:` +
    `\\x60settings\\.modelProvider\\.customTitle\\x60\\}\\),items:(${id})\\.filter\\((${id})=>` +
    `\\3\\.providerId!==${providerId}\\)\\.map\\((${id})=>\\(\\{key:(${id})\\(\\4\\.providerId\\),` +
    `type:\\x60custom\\x60,label:(${id})\\(\\4\\),provider:\\4,statusActive:\\4\\.executable===!0\\}\\)\\)`, 'g'))];
  if (openaiGroups.length !== 1 || customGroups.length !== 1) {
    return 'expected one independent OpenAI group and one custom exclusion';
  }
  const [, openaiProviders, , openaiKey, openaiLabel] = openaiGroups[0];
  const [, , customProviders, , , customKey, customLabel] = customGroups[0];
  if (openaiProviders !== customProviders || openaiKey !== customKey || openaiLabel !== customLabel) {
    return 'OpenAI and custom settings partitions do not share the same bindings';
  }

  const fixedNavigation = [...text.matchAll(new RegExp(
    `(${id})\\.id===\\x60preset\\x60\\|\\|\\1\\.id===\\x60openai\\x60`, 'g'))];
  if (fixedNavigation.length !== 1) {
    return 'OpenAI settings navigation must use the fixed preset-style row';
  }
  if (countMatches(text, 'provider:null,statusActive:!1') !== 1) {
    return 'OpenAI logged-out navigation placeholder is missing or duplicated';
  }
  if (countMatches(text, 'key===`custom:zcode-openai-codex`') !== 1 ||
      !text.includes('断开连接') || !text.includes('连接 OpenAI') ||
      countMatches(text, 'presetApiKeyUrl:void 0,readOnlyEndpoints:!0,nameEditable:!1') !== 1) {
    return 'OpenAI connect/disconnect detail card or managed editor flags are missing';
  }
  if (countMatches(text, '断开 OpenAI 连接失败') !== 1) {
    return 'OpenAI disconnect handler is missing or duplicated';
  }

  const menuPartitions = [...text.matchAll(new RegExp(
    `const zcodeOaiMenuProviders=\\[\\.\\.\\.(${id})\\.providers\\.filter\\(` +
    `zcodeOaiMenuProvider=>zcodeOaiMenuProvider\\.providerId===${providerId}\\),` +
    `\\.\\.\\.\\1\\.providers\\.filter\\(zcodeOaiMenuProvider=>` +
    `zcodeOaiMenuProvider\\.providerId!==${providerId}\\)\\]`, 'g'))];
  if (menuPartitions.length !== 1) {
    return 'OpenAI model-menu family partition is missing or duplicated';
  }
  const menuGates = [...text.matchAll(new RegExp(
    `(${id})\\.providerId!==${providerId}&&!(${id})\\([^,]+,\\1\\.config\\.api\\?\\.type\\)`, 'g'))];
  const menuPresentations = [...text.matchAll(new RegExp(
    `key:(${id})\\.providerId===${providerId}\\?\\x60family:openai\\x60:` +
    `\\x60registry-provider:\\$\\{\\1\\.providerId\\}\\x60,label:\\1\\.providerId===${providerId}` +
    `\\?\\x60OpenAI\\x60:`, 'g'))];
  if (menuGates.length !== 1 || menuPresentations.length !== 1 ||
      menuGates[0][1] !== menuPresentations[0][1]) {
    return 'OpenAI model-menu family gate and presentation are incomplete';
  }

  const hiddenConnections = [...text.matchAll(new RegExp(
    `\\((${id})\\|\\|(${id})\\.providerId===${providerId}\\)\\?null:`, 'g'))];
  const hiddenApiKeys = [...text.matchAll(new RegExp(
    `(${id})&&(${id})\\.providerId!==${providerId}\\?`, 'g'))];
  if (hiddenConnections.length !== 1 || hiddenApiKeys.length !== 1 ||
      hiddenConnections[0][2] !== hiddenApiKeys[0][2]) {
    return 'OpenAI connection and API key sections must both be hidden';
  }
  const detailProvider = hiddenConnections[0][2];
  const detailStart = Math.max(0, hiddenConnections[0].index - 2200);
  const detailEnd = Math.min(text.length, hiddenApiKeys[0].index + 2200);
  const detailSlice = text.slice(detailStart, detailEnd);
  if (!detailSlice.includes('"data-testid":`model-provider-enabled-switch`') ||
      !detailSlice.includes(`providerId:${detailProvider}.providerId`) ||
      !detailSlice.includes('onAddModel:') || !detailSlice.includes('onReorderModelIds:')) {
    return 'OpenAI field hiding must preserve the provider toggle and model management section';
  }
  return null;
}

function criticalTargetSemanticIssue(targetId, text) {
  if (targetId === 'renderer.settings') return criticalRendererSettingsIssue(text);
  if (targetId === 'renderer.icons') return criticalRendererIconsIssue(text);
  if (targetId === 'host.main') return criticalHostMainIssue(text);
  return null;
}

// --- source-semantic resolvers (locate anchors via keepNames + string literals) ---
// Each resolver is a pure text function: (moduleText, params) -> { find, replace }.
// It must throw when the anchor cannot be located; applySpansText then either
// throws (strict) or records a failed span (soft), so a relocated/renamed anchor
// never produces a partially patched module.

const JS_IDENT = '[A-Za-z_$][\\w$]*';

function keepNamesBinding(text, name, label) {
  // esbuild keepNames emits: <helper>(<binding>,"<name>")
  const re = new RegExp(`[is]\\((${JS_IDENT}),${JSON.stringify(name)}\\)`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`${label || name}: keepNames binding for "${name}" found ${matches.length} times`);
  }
  return matches[0][1];
}

// Self-contained OpenAI (ChatGPT/Codex) OAuth provider block. Injected once into
// the host bundle ahead of createOAuthRuntimeConfig. It brings its own imports so
// it never depends on the bundle's minified import aliases, and it avoids template
// literals so it can be stored as a plain String.raw block.
const OPENAI_OAUTH_INJECTION = String.raw`
import{randomBytes as zcodeOaiRandomBytes,createHash as zcodeOaiCreateHash}from"node:crypto";
import{createServer as zcodeOaiCreateServer}from"node:http";
const zcodeOaiCfg={id:"openai",displayName:"OpenAI",enabled:!0,order:3,
authorizeUrl:"https://auth.openai.com/oauth/authorize",
tokenUrl:"https://auth.openai.com/oauth/token",
redirectUri:"http://localhost:1455/auth/callback",
clientId:"app_EMoamEEZ73f0CkXaXp7hrann",
apiBase:"https://chatgpt.com/backend-api/codex/responses"};
function zcodeOaiProviderConfig(e){return{...zcodeOaiCfg}}
const zcodeOaiVerifiers=new Map();
let zcodeOaiServerPromise=null;
function zcodeOaiPkce(){const v=zcodeOaiRandomBytes(32).toString("base64url");return{verifier:v,challenge:zcodeOaiCreateHash("sha256").update(v,"utf8").digest("base64url")}}
function zcodeOaiEnsureServer(){if(zcodeOaiServerPromise)return zcodeOaiServerPromise;zcodeOaiServerPromise=new Promise((resolve,reject)=>{const srv=zcodeOaiCreateServer((req,res)=>{try{const url=new URL(req.url||"/",zcodeOaiCfg.redirectUri);if(url.pathname==="/auth/callback"){const code=url.searchParams.get("code")||"",state=url.searchParams.get("state")||"",err=url.searchParams.get("error"),desc=url.searchParams.get("error_description");const target=err?"zcode://oauth/callback?error="+encodeURIComponent(err)+"&error_description="+encodeURIComponent(desc||"")+"&state="+encodeURIComponent(state):"zcode://oauth/callback?code="+encodeURIComponent(code)+"&state="+encodeURIComponent(state);res.writeHead(302,{Location:target});res.end()}else{res.writeHead(404);res.end()}}catch(e){try{res.writeHead(500);res.end()}catch{}}});srv.on("error",e=>{zcodeOaiServerPromise=null;reject(e)});srv.listen(1455,"127.0.0.1",()=>resolve(srv))});return zcodeOaiServerPromise}
class ZcodeOpenAiOAuthAdapter{
constructor(config,apiClient){this.config=config;this.meta={id:config.id,displayName:config.displayName,enabled:config.enabled,order:config.order};this.providerId="openai";this.redirectUri=config.redirectUri;this.apiClient=apiClient}
parseCallbackParams(url){const p=new URL(url),code=p.searchParams.get("code"),state=p.searchParams.get("state");if(!code||!state)throw new Error("OpenAI OAuth callback missing code or state");return{code,state}}
buildAuthorizeUrl(context){zcodeOaiEnsureServer().catch(()=>{});const pkce=zcodeOaiPkce();zcodeOaiVerifiers.set(context.state,pkce.verifier);const query=new URLSearchParams({response_type:"code",client_id:zcodeOaiCfg.clientId,redirect_uri:context.redirectUri,scope:"openid profile email offline_access",code_challenge:pkce.challenge,code_challenge_method:"S256",id_token_add_organizations:"true",codex_cli_simplified_flow:"true",state:context.state,originator:"opencode"});return zcodeOaiCfg.authorizeUrl+"?"+query.toString()}
async exchangeToken(params,context){const verifier=zcodeOaiVerifiers.get(params.state);zcodeOaiVerifiers.delete(params.state);const body=new URLSearchParams({grant_type:"authorization_code",code:params.code,redirect_uri:context.redirectUri,client_id:zcodeOaiCfg.clientId,...(verifier?{code_verifier:verifier}:{})}).toString();const res=await this.apiClient.request(zcodeOaiCfg.tokenUrl,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});const payload=await res.json().catch(()=>null);if(!res.ok||!payload||!payload.access_token)throw new Error("OpenAI token exchange failed: HTTP "+res.status);const tokenSet={accessToken:payload.access_token,...(payload.refresh_token?{refreshToken:payload.refresh_token}:{}),...(typeof payload.expires_in==="number"?{expiresAt:Date.now()+payload.expires_in*1000}:{})};zcodeOaiScheduleSync(this.apiClient,tokenSet.accessToken,tokenSet.refreshToken);return tokenSet}
async refreshToken(tokenSet){if(!tokenSet.refreshToken)throw new Error("当前账号缺少 refresh_token，请重新登录");const res=await this.apiClient.request(zcodeOaiCfg.tokenUrl,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:tokenSet.refreshToken,client_id:zcodeOaiCfg.clientId}).toString()});const payload=await res.json().catch(()=>null);if(!res.ok||!payload||!payload.access_token)throw new Error("OpenAI token refresh failed: HTTP "+res.status);const next={accessToken:payload.access_token,refreshToken:payload.refresh_token||tokenSet.refreshToken,...(typeof payload.expires_in==="number"?{expiresAt:Date.now()+payload.expires_in*1000}:{})};zcodeOaiScheduleSync(this.apiClient,next.accessToken,next.refreshToken);return next}
async fetchUserInfo(tokenSet){try{const parts=tokenSet.accessToken.split(".");if(parts.length===3){const payload=JSON.parse(Buffer.from(parts[1],"base64url").toString());const profile=payload["https://api.openai.com/profile"]||{};const email=profile.email||"",name=profile.name||email||"OpenAI";const auth=payload["https://api.openai.com/auth"]||{};const id=auth.chatgpt_user_id||payload.sub||email||"openai";return{id:String(id),username:String(email||name),displayName:String(name)}}}catch{}return{id:"openai",username:"OpenAI",displayName:"OpenAI"}}
normalizeError(error){return error instanceof Error?error:new Error("OpenAI OAuth 异常: "+String(error))}
}
`;

// The managed-provider sync module. dirFn is the bundle's resolved getCredentialsDir
// binding (keeps the custom dataBaseDir resolution correct on any install). The sync
// read-modify-writes provider_config.json directly; ZCode's personal repository polls
// that file, so changes propagate live. It never removes the provider on a failed
// refresh/catalog fetch — only a real OpenAI logout (credential delete) does.
function buildOpenAiSyncInjection(dirFn) {
  return String.raw`
import{readFileSync as zcodeOaiReadFileSync,writeFileSync as zcodeOaiWriteFileSync,renameSync as zcodeOaiRenameSync,existsSync as zcodeOaiExistsSync,unlinkSync as zcodeOaiUnlinkSync}from"node:fs";
import{join as zcodeOaiJoin}from"node:path";
const zcodeOaiProviderId="zcode-openai-codex";
const zcodeOaiSidecarName="openai-codex-oauth.json";
let zcodeOaiSyncFlight=null;
let zcodeOaiLastSyncError="";
const zcodeOaiFallbackClientVersion="0.156.1";
const zcodeOaiClientVersionTtl=6*60*60*1000;
function zcodeOaiConfigDir(){return ${dirFn}()}
function zcodeOaiReadJsonFile(p){try{return JSON.parse(zcodeOaiReadFileSync(p,"utf8"))}catch{return null}}
function zcodeOaiWriteJsonFile(p,obj){try{const tmp=p+".tmp-"+Date.now()+"-"+Math.floor(Math.random()*1e6);zcodeOaiWriteFileSync(tmp,JSON.stringify(obj,null,2));zcodeOaiRenameSync(tmp,p);return true}catch(e){return false}}
function zcodeOaiTokenClaims(t){try{const n=String(t||"").split(".");return n.length===3?JSON.parse(Buffer.from(n[1],"base64url").toString()):{}}catch{return{}}}
function zcodeOaiAccountId(t){const c=zcodeOaiTokenClaims(t);return String(c.chatgpt_account_id||(c["https://api.openai.com/auth"]||{}).chatgpt_account_id||"")}
function zcodeOaiPlanType(t){return String((zcodeOaiTokenClaims(t)["https://api.openai.com/auth"]||{}).chatgpt_plan_type||"").toLowerCase()}
function zcodeOaiTokenExp(t){const c=zcodeOaiTokenClaims(t);return typeof c.exp==="number"?c.exp*1000:0}
async function zcodeOaiHttpJson(apiClient,url,token,accountId){const res=await apiClient.request(url,{method:"GET",timeoutMs:15000,headers:{Authorization:"Bearer "+token,"OpenAI-Beta":"responses=experimental",originator:"opencode","User-Agent":"ZCode",...(accountId?{"chatgpt-account-id":accountId}:{})}});if(!res||!res.ok){zcodeOaiLastSyncError="HTTP "+(res&&res.status||0);return null}const payload=await res.json().catch(()=>null);if(!payload)zcodeOaiLastSyncError="invalid JSON";return payload}
function zcodeOaiValidClientVersion(v){if(typeof v!=="string"||!/^\d+\.\d+\.\d+$/.test(v))return false;const p=v.split(".").map(Number),b=zcodeOaiFallbackClientVersion.split(".").map(Number);for(let i=0;i<3;i++){if(p[i]>b[i])return true;if(p[i]<b[i])return false}return true}
async function zcodeOaiClientVersion(apiClient,sidecar){const now=Date.now();if(zcodeOaiValidClientVersion(sidecar&&sidecar.clientVersion)&&Number.isFinite(sidecar&&sidecar.clientVersionCheckedAt)&&now-sidecar.clientVersionCheckedAt>=0&&now-sidecar.clientVersionCheckedAt<zcodeOaiClientVersionTtl)return sidecar.clientVersion;try{const res=await apiClient.request("https://registry.npmjs.org/@openai/codex/latest",{method:"GET",timeoutMs:10000,headers:{"User-Agent":"ZCode"}});const payload=res&&res.ok?await res.json().catch(()=>null):null;if(zcodeOaiValidClientVersion(payload&&payload.version))return payload.version}catch(e){}return zcodeOaiValidClientVersion(sidecar&&sidecar.clientVersion)?sidecar.clientVersion:zcodeOaiFallbackClientVersion}
function zcodeOaiCatalogModels(payload){const list=(payload&&payload.models)||[];const seen=new Map();for(const m of list){if(!m||m.supported_in_api===false||m.visibility==="hide")continue;const id=typeof m.slug==="string"?m.slug:"";if(!id||seen.has(id))continue;seen.set(id,m)}return[...seen.values()]}
async function zcodeOaiAstraAllowed(apiClient,token,accountId,plan){if(!["plus","pro","team","business","enterprise"].includes(plan))return false;for(let a=0;a<4;a++){if(a)await new Promise(zcodeOaiDelay=>setTimeout(zcodeOaiDelay,250*a));try{const payload=await zcodeOaiHttpJson(apiClient,"https://chatgpt.com/backend-api/models",token,accountId);if(!payload)continue;return((payload&&payload.models)||[]).some(x=>x&&x.slug==="gpt-6-astra-wm"&&x.is_work_mode_model===true)}catch(e){}}return false}
function zcodeOaiReasoningSpec(levels){const ok=["none","minimal","low","medium","high","xhigh","max"];const vals=(Array.isArray(levels)?levels:[]).map(x=>typeof x==="string"?x:x&&typeof x.effort==="string"?x.effort:"").filter(x=>ok.includes(x));if(!vals.length)return null;return{values:vals,map:'{"reasoning":{"effort":reasoningLevel}}'}}
function zcodeOaiModelEntry(m){const id=m.slug;const rawCw=Number.isInteger(m.max_context_window)&&m.max_context_window>0?m.max_context_window:m.context_window;const cw=Number.isInteger(rawCw)&&rawCw>0?rawCw:272000;const supportsImage=Array.isArray(m.input_modalities)?m.input_modalities.includes("image"):true;const reasoning=zcodeOaiReasoningSpec(m.supported_reasoning_levels)||{values:["medium"],map:"{}"};const config={properties:{contextWindow:cw,inputFormat:{supportsText:true,supportsImage,supportsVideo:false,supportsAudio:false,supportsPdf:false},outputFormat:{supportsText:true},supportsToolCall:true,supportsJsonSchemaOutput:false,supportsNativeWebSearch:false,supportsMidConversationSystem:false},optionSpecs:{reasoningLevel:reasoning,maxOutputTokens:{max:128000,map:"{}"}}};return{id,config}}
const zcodeOaiAstraBaseline={slug:"gpt-6-astra",display_name:"GPT-6-Astra",supported_reasoning_levels:["low","medium","high","xhigh","max"],default_reasoning_level:"low",context_window:544000};
async function zcodeOaiCollectModels(apiClient,token,accountId,plan,sidecar){const clientVersion=await zcodeOaiClientVersion(apiClient,sidecar);zcodeOaiLastSyncError="";const payload=await zcodeOaiHttpJson(apiClient,"https://chatgpt.com/backend-api/codex/models?client_version="+encodeURIComponent(clientVersion),token,accountId);if(!payload)return null;const catalog=zcodeOaiCatalogModels(payload);if(!catalog.length){zcodeOaiLastSyncError="empty catalog";return null}const astraOk=await zcodeOaiAstraAllowed(apiClient,token,accountId,plan).catch(()=>false);const hasAstra=catalog.some(m=>m.slug==="gpt-6-astra");const models=catalog.slice();if(!hasAstra&&astraOk){const ref=catalog.find(m=>m.slug==="gpt-5.6-sol");const refCw=ref&&Number.isInteger(ref.max_context_window)&&ref.max_context_window>0?ref.max_context_window:ref&&Number.isInteger(ref.context_window)?ref.context_window:0;models.unshift(refCw?{...zcodeOaiAstraBaseline,context_window:refCw}:zcodeOaiAstraBaseline)}return{models,clientVersion}}
function zcodeOaiApplyToConfig(file,accessToken,accountId,models,previousManagedIds,previousManagedContextWindows){const doc=zcodeOaiReadJsonFile(file);if(!doc||typeof doc!=="object"||!doc.config||typeof doc.config!=="object")return null;const cfg=doc.config;const pcr=cfg.providerConfigRules&&typeof cfg.providerConfigRules==="object"?cfg.providerConfigRules:{};const mcr=cfg.modelConfigRules&&typeof cfg.modelConfigRules==="object"?cfg.modelConfigRules:{};const rules=Array.isArray(pcr.providerRules)?pcr.providerRules.slice():[];const ri=rules.findIndex(r=>r&&r.providerId===zcodeOaiProviderId);const existing=ri>=0?rules[ri]:null;const currentIds=existing&&existing.config&&Array.isArray(existing.config.personalModelIds)?existing.config.personalModelIds.filter(x=>typeof x==="string"&&x):[];const currentOrder=existing&&existing.config&&Array.isArray(existing.config.modelOrder)?existing.config.modelOrder.filter(x=>typeof x==="string"&&x):[];const allSmartRules=Array.isArray(mcr.providerModelRules)?mcr.providerModelRules:[];const allManualRules=Array.isArray(mcr.manualProviderModelRules)?mcr.manualProviderModelRules:[];const explicitManualIds=new Set(allManualRules.filter(r=>r&&r.providerId===zcodeOaiProviderId&&typeof r.modelId==="string").map(r=>r.modelId));const priorManaged=Array.isArray(previousManagedIds)&&previousManagedIds.length?new Set(previousManagedIds):new Set(currentIds.filter(id=>!explicitManualIds.has(id)));const userIds=currentIds.filter(id=>!priorManaged.has(id));for(const id of explicitManualIds)if(!userIds.includes(id))userIds.push(id);const managedModels=models.filter(m=>!explicitManualIds.has(m.id));const managedIds=managedModels.map(m=>m.id);const ids=[...managedIds,...userIds.filter(id=>!managedIds.includes(id))];const idSet=new Set(ids);const modelOrder=[...currentOrder.filter(id=>idSet.has(id)),...ids.filter(id=>!currentOrder.includes(id))];const rule={providerId:zcodeOaiProviderId,providerName:"OpenAI",enabled:existing&&typeof existing.enabled==="boolean"?existing.enabled:true,config:{group:"standard-personal",logo:{type:"builtin",key:"openai"},access:{type:"api-key",apiKey:accessToken},api:{type:"openai-responses",baseUrl:"https://chatgpt.com/backend-api/codex",headers:{"OpenAI-Beta":"responses=experimental",originator:"opencode",...(accountId?{"chatgpt-account-id":accountId}:{})}},personalModelIds:ids,modelOrder}};if(ri>=0)rules[ri]=rule;else rules.push(rule);const prevCw=new Map();for(const r of allSmartRules){const cw=r&&r.providerId===zcodeOaiProviderId&&r.config&&r.config.properties&&r.config.properties.contextWindow;if(typeof r.modelId==="string"&&Number.isInteger(cw)&&cw>0)prevCw.set(r.modelId,cw)}const previousBaselines=previousManagedContextWindows&&typeof previousManagedContextWindows==="object"?previousManagedContextWindows:{};const userSet=new Set(userIds);const modelRules=allSmartRules.filter(r=>!(r&&r.providerId===zcodeOaiProviderId)||userSet.has(r.modelId));const managedContextWindows={};for(const m of managedModels){const catalogCw=m&&m.config&&m.config.properties&&m.config.properties.contextWindow;if(Number.isInteger(catalogCw)&&catalogCw>0)managedContextWindows[m.id]=catalogCw;const keep=prevCw.get(m.id),baseline=previousBaselines[m.id];if(keep&&(!Number.isInteger(baseline)||keep!==baseline))m.config={...m.config,properties:{...m.config.properties,contextWindow:keep}};modelRules.push({modelId:m.id,config:m.config,providerId:zcodeOaiProviderId})}cfg.providerConfigRules={...pcr,providerRules:rules};cfg.modelConfigRules={...mcr,providerModelRules:modelRules,manualProviderModelRules:allManualRules};return zcodeOaiWriteJsonFile(file,doc)?{managedModelIds:managedIds,managedContextWindows}:null}
async function zcodeOaiSyncNow(apiClient,accessToken,refreshToken){try{const accountId=zcodeOaiAccountId(accessToken);const plan=zcodeOaiPlanType(accessToken);const dir=zcodeOaiConfigDir();const file=zcodeOaiJoin(dir,"provider_config.json");if(!zcodeOaiExistsSync(file)){zcodeOaiLastSyncError="provider config missing";return false}const sidecarPath=zcodeOaiJoin(dir,zcodeOaiSidecarName);const previousSidecar=zcodeOaiReadJsonFile(sidecarPath);const collected=await zcodeOaiCollectModels(apiClient,accessToken,accountId,plan,previousSidecar);if(!collected)return false;const managed=zcodeOaiApplyToConfig(file,accessToken,accountId,collected.models.map(zcodeOaiModelEntry),previousSidecar&&previousSidecar.managedModelIds,previousSidecar&&previousSidecar.managedContextWindows);if(!managed){zcodeOaiLastSyncError="provider config write failed";return false}if(refreshToken&&!zcodeOaiWriteJsonFile(sidecarPath,{refreshToken,accountId,plan,...managed,clientVersion:collected.clientVersion,clientVersionCheckedAt:Date.now(),savedAt:Date.now()})){zcodeOaiLastSyncError="sidecar write failed";return false}zcodeOaiLastSyncError="";return true}catch(e){zcodeOaiLastSyncError=e&&e.name?e.name:"sync failed";return false}}
function zcodeOaiScheduleSync(apiClient,accessToken,refreshToken){if(zcodeOaiSyncFlight)return zcodeOaiSyncFlight;zcodeOaiSyncFlight=Promise.resolve().then(()=>zcodeOaiSyncNow(apiClient,accessToken,refreshToken)).catch(()=>false).finally(()=>{zcodeOaiSyncFlight=null});return zcodeOaiSyncFlight}
let zcodeOaiApiClient=null;
function zcodeOaiManualSync(){if(!zcodeOaiApiClient)return Promise.resolve(true);try{const dir=zcodeOaiConfigDir();if(!zcodeOaiExistsSync(zcodeOaiJoin(dir,zcodeOaiSidecarName)))return Promise.resolve(true)}catch(e){return Promise.resolve(true)}zcodeOaiLastSyncError="";if(zcodeOaiSyncFlight)return zcodeOaiSyncFlight;zcodeOaiSyncFlight=Promise.resolve().then(()=>zcodeOaiStartupSyncNow(zcodeOaiApiClient)).catch(()=>false).finally(()=>{zcodeOaiSyncFlight=null});return zcodeOaiSyncFlight}
async function zcodeOaiRefreshAccessToken(apiClient,refreshToken){const res=await apiClient.request(zcodeOaiCfg.tokenUrl,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refreshToken,client_id:zcodeOaiCfg.clientId}).toString()});const payload=await res.json().catch(()=>null);if(!res||!res.ok||!payload||!payload.access_token)return null;return{accessToken:payload.access_token,refreshToken:payload.refresh_token||refreshToken}}
async function zcodeOaiStartupSyncNow(apiClient){try{const dir=zcodeOaiConfigDir();const sidecar=zcodeOaiReadJsonFile(zcodeOaiJoin(dir,zcodeOaiSidecarName));if(!sidecar||!sidecar.refreshToken)return false;const file=zcodeOaiJoin(dir,"provider_config.json");if(!zcodeOaiExistsSync(file))return false;const doc=zcodeOaiReadJsonFile(file);const rules=doc&&doc.config&&doc.config.providerConfigRules&&doc.config.providerConfigRules.providerRules;const existing=Array.isArray(rules)?rules.find(r=>r&&r.providerId===zcodeOaiProviderId):null;let token=existing&&existing.config&&existing.config.access?existing.config.access.apiKey:"";let refreshToken=sidecar.refreshToken;const exp=zcodeOaiTokenExp(token);if(!token||!exp||exp-Date.now()<2*864e5){const refreshed=await zcodeOaiRefreshAccessToken(apiClient,refreshToken);if(!refreshed)return false;token=refreshed.accessToken;refreshToken=refreshed.refreshToken}return await zcodeOaiSyncNow(apiClient,token,refreshToken)}catch(e){return false}}
function zcodeOaiStartupSync(apiClient){let attempts=0;const tick=()=>{attempts++;let ready=false;try{const dir=zcodeOaiConfigDir();ready=!!dir&&zcodeOaiExistsSync(zcodeOaiJoin(dir,"provider_config.json"))}catch(e){}if(ready||attempts>6){if(!zcodeOaiSyncFlight)zcodeOaiSyncFlight=Promise.resolve().then(()=>zcodeOaiStartupSyncNow(apiClient)).catch(()=>false).finally(()=>{zcodeOaiSyncFlight=null})}else setTimeout(tick,2000)};setTimeout(tick,1500)}
function zcodeOaiRemoveProvider(){try{const dir=zcodeOaiConfigDir();const file=zcodeOaiJoin(dir,"provider_config.json");const doc=zcodeOaiReadJsonFile(file);if(doc&&doc.config){const cfg=doc.config;const pcr=cfg.providerConfigRules||{};const mcr=cfg.modelConfigRules||{};const rules=(Array.isArray(pcr.providerRules)?pcr.providerRules:[]).filter(r=>!(r&&r.providerId===zcodeOaiProviderId));const modelRules=(Array.isArray(mcr.providerModelRules)?mcr.providerModelRules:[]).filter(r=>!(r&&r.providerId===zcodeOaiProviderId));cfg.providerConfigRules={...pcr,providerRules:rules};cfg.modelConfigRules={...mcr,providerModelRules:modelRules};zcodeOaiWriteJsonFile(file,doc)}try{zcodeOaiUnlinkSync(zcodeOaiJoin(dir,zcodeOaiSidecarName))}catch(e){}return true}catch(e){return false}}
`;
}

const OPENAI_ICON_DATA_URI =
  'data:image/svg+xml,%3Csvg%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%3E%3Ctitle%3EOpenAI%3C/title%3E%3Cpath%20fill%3D%22black%22%20d%3D%22M22.2819%209.8211a5.9847%205.9847%200%200%200-.5157-4.9108%206.0462%206.0462%200%200%200-6.5098-2.9A6.0651%206.0651%200%200%200%204.9807%204.1818a5.9847%205.9847%200%200%200-3.9977%202.9%206.0462%206.0462%200%200%200%20.7427%207.0966%205.98%205.98%200%200%200%20.511%204.9107%206.051%206.051%200%200%200%206.5146%202.9001A5.9847%205.9847%200%200%200%2013.2599%2024a6.0557%206.0557%200%200%200%205.7718-4.2058%205.9894%205.9894%200%200%200%203.9977-2.9001%206.0557%206.0557%200%200%200-.7475-7.0729zm-9.022%2012.6081a4.4755%204.4755%200%200%201-2.8764-1.0408l.1419-.0804%204.7783-2.7582a.7948.7948%200%200%200%20.3927-.6813v-6.7369l2.02%201.1686a.071.071%200%200%201%20.038.052v5.5826a4.504%204.504%200%200%201-4.4945%204.4944zm-9.6607-4.1254a4.4708%204.4708%200%200%201-.5346-3.0137l.142.0852%204.783%202.7582a.7712.7712%200%200%200%20.7806%200l5.8428-3.3685v2.3324a.0804.0804%200%200%201-.0332.0615L9.74%2019.9502a4.4992%204.4992%200%200%201-6.1408-1.6464zM2.3408%207.8956a4.485%204.485%200%200%201%202.3655-1.9728V11.6a.7664.7664%200%200%200%20.3879.6765l5.8144%203.3543-2.0201%201.1685a.0757.0757%200%200%201-.071%200l-4.8303-2.7865A4.504%204.504%200%200%201%202.3408%207.872zm16.5963%203.8558L13.1038%208.364%2015.1192%207.2a.0757.0757%200%200%201%20.071%200l4.8303%202.7913a4.4944%204.4944%200%200%201-.6765%208.1042v-5.6772a.79.79%200%200%200-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759%200%200%200-.7854%200L9.409%209.2297V6.8974a.0662.0662%200%200%201%20.0284-.0615l4.8303-2.7866a4.4992%204.4992%200%200%201%206.6802%204.66zM8.3065%2012.863l-2.02-1.1638a.0804.0804%200%200%201-.038-.0567V6.0742a4.4992%204.4992%200%200%201%207.3757-3.4537l-.142.0805L8.704%205.459a.7948.7948%200%200%200-.3927.6813zm1.0976-2.3654l2.602-1.4998%202.6069%201.4998v2.9994l-2.5974%201.4997-2.6067-1.4997Z%22/%3E%3C/svg%3E';

// Inject the OpenAI block and append the provider config to createOAuthRuntimeConfig.
function resolveOpenAiInjectAndRegisterConfig(text) {
  const cfg = keepNamesBinding(text, 'createOAuthRuntimeConfig', 'openaiInjectConfig');
  const dirFn = keepNamesBinding(text, 'getCredentialsDir', 'openaiInjectConfig');
  const re = new RegExp(
    `function ${cfg}\\((${JS_IDENT})=process\\.env\\)\\{return\\{providers:\\[([^\\]]+)\\]\\}\\}`);
  const match = text.match(re);
  if (!match) throw new Error('openaiInjectConfig: createOAuthRuntimeConfig providers array not found');
  const [full, paramName, list] = match;
  const replace = OPENAI_OAUTH_INJECTION + buildOpenAiSyncInjection(dirFn) +
    `function ${cfg}(${paramName}=process.env){return{providers:[${list},zcodeOaiProviderConfig(${paramName})]}}`;
  return { find: full, replace };
}

// Add case "openai" to createOAuthProviderAdapters' provider-id switch.
function resolveOpenAiRegisterAdapterCase(text) {
  keepNamesBinding(text, 'createOAuthProviderAdapters', 'openaiAdapterCase');
  const re = new RegExp(
    `for\\(let (${JS_IDENT}) of (${JS_IDENT})\\.providers\\)switch\\(\\1\\.id\\)\\{` +
    `case (${JS_IDENT}):(${JS_IDENT})\\.push\\(new (${JS_IDENT})\\(\\1,(${JS_IDENT})\\)\\);break;` +
    `case"zai":\\4\\.push\\(new (${JS_IDENT})\\(\\1,\\6\\)\\);break;default:break\\}return \\4\\}`);
  const match = text.match(re);
  if (!match) throw new Error('openaiAdapterCase: createOAuthProviderAdapters switch not found');
  const [full, loopVar, providersVar, bigmodelId, arrVar, bigmodelCtor, apiClientVar, zaiCtor] = match;
  const replace =
    `for(let ${loopVar} of ${providersVar}.providers)switch(${loopVar}.id){` +
    `case ${bigmodelId}:${arrVar}.push(new ${bigmodelCtor}(${loopVar},${apiClientVar}));break;` +
    `case"zai":${arrVar}.push(new ${zaiCtor}(${loopVar},${apiClientVar}));break;` +
    `case"openai":${arrVar}.push(new ZcodeOpenAiOAuthAdapter(${loopVar},${apiClientVar}));break;` +
    `default:break}return ${arrVar}}`;
  return { find: full, replace };
}

// Append "openai" to the credential repo's known OAuth provider ids.
function resolveOpenAiAppendKnownId(text) {
  const known = keepNamesBinding(text, 'collectKnownOAuthProviderIds', 'openaiKnownId');
  const reSet = new RegExp(
    `function ${known}\\((${JS_IDENT})=\\[\\]\\)\\{let (${JS_IDENT})=new Set\\((${JS_IDENT})\\)`);
  const matchSet = text.match(reSet);
  if (!matchSet) throw new Error('openaiKnownId: collectKnownOAuthProviderIds shape not found');
  const idsBinding = matchSet[3];
  const reArr = new RegExp(`${idsBinding}=\\[([^\\]]*?)\\]`);
  const matchArr = text.match(reArr);
  if (!matchArr) throw new Error('openaiKnownId: known provider ids array not found');
  const [fullArr, content] = matchArr;
  if (/"openai"/.test(content)) throw new Error('openaiKnownId: openai already present');
  return { find: fullArr, replace: `${idsBinding}=[${content},"openai"]` };
}

// Schedule the managed-provider startup sync right after the OAuth service is built.
function resolveOpenAiHookStartupSync(text) {
  const factory = keepNamesBinding(text, 'createOAuthService', 'openaiStartupHook');
  const re = new RegExp(
    `function ${factory}\\((${JS_IDENT}),(${JS_IDENT})=\\{\\}\\)\\{return new (${JS_IDENT})\\(\\1,` +
    `\\{\\.\\.\\.\\2,adapters:(${JS_IDENT})\\((${JS_IDENT})\\(\\2\\.env\\),\\{apiClient:\\2\\.apiClient\\}\\)\\}\\)\\}`);
  const match = text.match(re);
  if (!match) throw new Error('openaiStartupHook: createOAuthService factory shape not found');
  const [full, depsVar, envVar, serviceCtor, adaptersFn, configFn] = match;
  const replace =
    `function ${factory}(${depsVar},${envVar}={}){const zcodeOaiSvc=new ${serviceCtor}(${depsVar},` +
    `{...${envVar},adapters:${adaptersFn}(${configFn}(${envVar}.env),{apiClient:${envVar}.apiClient})});` +
    `zcodeOaiApiClient=${envVar}.apiClient;zcodeOaiStartupSync(${envVar}.apiClient);return zcodeOaiSvc}`;
  return { find: full, replace };
}

// The settings page already has a manual refresh button; it reaches the host as
// ProviderSettingsFacade.refresh("settings-manual"). Run the managed OpenAI
// catalog sync first so that button now refreshes the online model list too.
// The merge in zcodeOaiApplyToConfig already preserves user-added models and
// their overrides, so manual edits survive this refresh.
function resolveOpenAiHookManualRefresh(text) {
  const re = new RegExp(
    `async refresh\\((${JS_IDENT})\\)\\{return this\\.(#${JS_IDENT})\\?\\.refreshSources\\?` +
    `await this\\.\\2\\.refreshSources\\(\`settings:\\$\\{\\1\\}\`\\):await this\\.(#${JS_IDENT})` +
    `\\.refresh\\(\\1\\),this\\.getView\\(\\)\\}`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`openaiManualRefresh: provider settings facade refresh found ${matches.length} times`);
  }
  const [full, reason, mutations, runtime] = matches[0];
  const replace =
    `async refresh(${reason}){let zcodeOaiManualOk=!0;${reason}==="settings-manual"&&` +
    `(zcodeOaiManualOk=await zcodeOaiManualSync());this.${mutations}?.refreshSources?` +
    `await this.${mutations}.refreshSources(\`settings:\${${reason}}\`):await this.${runtime}.refresh(${reason});` +
    `if(!zcodeOaiManualOk)console.warn("OpenAI catalog refresh failed: "+` +
    `(zcodeOaiLastSyncError||"unknown"));return this.getView()}`;
  return { find: full, replace };
}

// Remove the managed provider when the OpenAI credential is cleared (logout).
function resolveOpenAiHookLogout(text) {
  keepNamesBinding(text, 'OAuthCredentialRepo', 'openaiLogoutHook');
  const re = new RegExp(
    `async clearProvider\\((${JS_IDENT})\\)\\{(await this\\.credentialService\\.delete\\(${JS_IDENT}\\(\\1\\)\\)[^}]*)\\}`);
  const match = text.match(re);
  if (!match) throw new Error('openaiLogoutHook: credential repo clearProvider not found');
  const [full, param, body] = match;
  const replace = `async clearProvider(${param}){${body};if(${param}==="openai")zcodeOaiRemoveProvider()}`;
  return { find: full, replace };
}

// Codex backend requires stateless Responses requests (store:false). The CLI leaves
// store unset (backend default store:true), so force it for the chatgpt.com codex
// endpoint while leaving every other openai-responses provider untouched.
function resolveOpenAiCodexStoreFalse(text) {
  const re = new RegExp(
    `let (${JS_IDENT})=(${JS_IDENT})\\?\\.store;\\1===!1&&(${JS_IDENT})&&(${JS_IDENT})\\("reasoning\\.encrypted_content"\\);`);
  const match = text.match(re);
  if (!match) throw new Error('codexStore: responses store computation not found');
  const [full, storeVar, optsVar, condVar, warnFn] = match;
  const replace =
    `let ${storeVar}=String(this.config.url({path:""})).includes("chatgpt.com")?!1:${optsVar}?.store;` +
    `${storeVar}===!1&&${condVar}&&${warnFn}("reasoning.encrypted_content");`;
  return { find: full, replace };
}

// Register the OpenAI brand icon for OAuth login/settings rows. The black-fill
// SVG is invisible on the dark login button, so the openai entry renders through
// a currentColor mask (the same adaptive structure the 3.10.2/3.11.2 line used),
// while every other provider keeps the plain img path byte-identical.
function resolveOpenAiRendererIcon(text) {
  const re = new RegExp(
    `(${JS_IDENT})=\\{(\\[${JS_IDENT}\\]:${JS_IDENT},zai:${JS_IDENT})\\};` +
    `function (${JS_IDENT})\\((${JS_IDENT}),(${JS_IDENT})\\)\\{let (${JS_IDENT})=\\1\\[\\4\\];` +
    `return \\6\\?\\(0,(${JS_IDENT})\\.jsx\\)\\(\`img\`,\\{src:\\6,alt:\`\`,"aria-hidden":\`true\`,` +
    `className:(${JS_IDENT})\\(\`shrink-0 object-contain\`,\\5\\)\\}\\):` +
    `\\(0,\\7\\.jsx\\)\\((${JS_IDENT}),\\{className:\\8\\(\`shrink-0\`,\\5\\)\\}\\)\\}`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`openaiRendererIcon: OAuth icon map and render function found ${matches.length} times`);
  }
  const [full, mapVar, entries, fn, provider, className, src, jsx, cn, fallback] = matches[0];
  const maskStyle =
    `style:{backgroundColor:\`currentColor\`,` +
    `WebkitMaskImage:\`url("\${${src}}")\`,WebkitMaskPosition:\`center\`,WebkitMaskRepeat:\`no-repeat\`,` +
    `WebkitMaskSize:\`contain\`,maskImage:\`url("\${${src}}")\`,maskPosition:\`center\`,` +
    `maskRepeat:\`no-repeat\`,maskSize:\`contain\`}`;
  const replace =
    `${mapVar}={${entries},openai:${JSON.stringify(OPENAI_ICON_DATA_URI)}};` +
    `function ${fn}(${provider},${className}){let ${src}=${mapVar}[${provider}];` +
    `return ${src}?${provider}===\`openai\`?` +
    `(0,${jsx}.jsx)(\`span\`,{"aria-hidden":\`true\`,className:${cn}(\`shrink-0\`,${className}),${maskStyle}}):` +
    `(0,${jsx}.jsx)(\`img\`,{src:${src},alt:\`\`,"aria-hidden":\`true\`,` +
    `className:${cn}(\`shrink-0 object-contain\`,${className})}):` +
    `(0,${jsx}.jsx)(${fallback},{className:${cn}(\`shrink-0\`,${className})})}`;
  return { find: full, replace };
}

// The Codex backend rejects any request field outside its known set (temperature,
// top_p, max_output_tokens, tool_choice, text, ...). The SDK still builds them for
// reasoning-capable unknown models, so for chatgpt.com reduce args to the codex set
// (the same whitelist the 3.11.x line verified live) while leaving every other
// openai-responses provider byte-identical.
function resolveOpenAiCodexArgsWhitelist(text) {
  const re = new RegExp(
    `return\\{webSearchToolName:(${JS_IDENT}),args:\\{\\.\\.\\.(${JS_IDENT}),tools:(${JS_IDENT}),` +
    `tool_choice:(${JS_IDENT})\\},warnings:\\[\\.\\.\\.(${JS_IDENT}),\\.\\.\\.(${JS_IDENT})\\],store:(${JS_IDENT}),`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`codexArgs: responses getArgs return shape found ${matches.length} times`);
  }
  const [full, webSearchTool, argsVar, toolsVar, toolChoiceVar, warnA, warnB, storeVar] = matches[0];
  const codexArgs =
    `Object.fromEntries(Object.entries({...${argsVar},tools:${toolsVar}}).filter(([k,v])=>` +
    `["model","instructions","input","tools","store","stream","include","reasoning"].includes(k)&&v!==undefined))`;
  const replace =
    `return{webSearchToolName:${webSearchTool},` +
    `args:String(this.config.url({path:""})).includes("chatgpt.com")?${codexArgs}:` +
    `{...${argsVar},tools:${toolsVar},tool_choice:${toolChoiceVar}},` +
    `warnings:[...${warnA},...${warnB}],store:${storeVar},`;
  return { find: full, replace };
}

// Codex backend answers failures with FastAPI-style {"detail": "..."} bodies, which
// the stock error schema rejects (masking the real error behind a parse failure).
// Loosen the main OpenAI provider's error schema and teach errorToMessage to read
// detail, matching what the 3.11.x line shipped after live testing.
function resolveOpenAiCodexErrorSchema(text) {
  const z = `(${JS_IDENT})`;
  const re = new RegExp(
    `(${JS_IDENT})=${z}\\.object\\(\\{error:\\2\\.object\\(\\{message:\\2\\.string\\(\\),` +
    `type:\\2\\.string\\(\\)\\.nullish\\(\\),param:\\2\\.any\\(\\)\\.nullish\\(\\),` +
    `code:\\2\\.union\\(\\[\\2\\.string\\(\\),\\2\\.number\\(\\)\\]\\)\\.nullish\\(\\)\\}\\)\\}\\),` +
    `(${JS_IDENT})=(${JS_IDENT})\\(\\{errorSchema:\\1,errorToMessage:(${JS_IDENT})\\((${JS_IDENT})=>\\6\\.error\\.message,("errorToMessage")\\)\\}\\);`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`codexError: OpenAI error schema found ${matches.length} times`);
  }
  const [full, schemaVar, zod, factoryVar, factoryFn, wrapFn, argVar, label] = matches[0];
  const replace =
    `${schemaVar}=${zod}.object({error:${zod}.object({message:${zod}.string(),` +
    `type:${zod}.string().nullish(),param:${zod}.any().nullish(),` +
    `code:${zod}.union([${zod}.string(),${zod}.number()]).nullish()}).nullish(),` +
    `detail:${zod}.string().nullish()}),` +
    `${factoryVar}=${factoryFn}({errorSchema:${schemaVar},` +
    `errorToMessage:${wrapFn}(${argVar}=>${argVar}.error?.message??${argVar}.detail??"Bad Request",${label})});`;
  return { find: full, replace };
}

// OpenAI is a provider credential, not an app identity. The stock login completion
// makes the fresh provider the active account, which flips the sidebar identity to
// the ChatGPT user and (via the null family domain) duplicates coding-plan rows in
// the settings navigation. Keep zai/bigmodel semantics untouched.
function resolveOpenAiNoActiveFlip(text) {
  const re = new RegExp(
    `await this\\.repo\\.saveUserProfile\\((${JS_IDENT}),(${JS_IDENT})\\((${JS_IDENT}),(${JS_IDENT})\\)\\),` +
    `await (${JS_IDENT})\\(\\),await this\\.repo\\.setActiveProvider\\((${JS_IDENT})\\),`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`openaiNoActiveFlip: persistOAuthSession completion found ${matches.length} times`);
  }
  const [full, provider, wrapFn, innerProvider, profileVar, assertFn, activeProvider] = matches[0];
  if (provider !== innerProvider || provider !== activeProvider) {
    throw new Error('openaiNoActiveFlip: completion touches more than one provider binding');
  }
  const replace =
    `await this.repo.saveUserProfile(${provider},${wrapFn}(${provider},${profileVar})),` +
    `await ${assertFn}(),${provider}!=="openai"&&await this.repo.setActiveProvider(${provider}),`;
  return { find: full, replace };
}

// Self-heal installs where the pre-fix login already stored active=openai: resolve
// the active provider back to a family identity that still holds a token.
function resolveOpenAiSanitizeActiveProvider(text) {
  const loadRe = new RegExp(
    `async loadActiveProvider\\(\\)\\{try\\{return await this\\.credentialService\\.load\\((${JS_IDENT})\\)\\}` +
    `catch\\((${JS_IDENT})\\)\\{if\\(!(${JS_IDENT})\\(\\2\\)\\)throw \\2;` +
    `return await this\\.clearCorruptOAuthSession\\(\\),null\\}\\}`, 'g');
  const loadMatches = [...text.matchAll(loadRe)];
  if (loadMatches.length !== 1) {
    throw new Error(`openaiActiveRepair: loadActiveProvider found ${loadMatches.length} times`);
  }
  const tokenRe = new RegExp(
    `async loadTokenSet\\((${JS_IDENT})\\)\\{try\\{let (${JS_IDENT})=await this\\.credentialService\\.load\\((${JS_IDENT})\\(\\1\\)\\);`, 'g');
  const tokenMatches = [...text.matchAll(tokenRe)];
  if (tokenMatches.length !== 1) {
    throw new Error(`openaiActiveRepair: loadTokenSet found ${tokenMatches.length} times`);
  }
  const [full, activeKey, errVar, isCorrupt] = loadMatches[0];
  const tokenKey = tokenMatches[0][3];
  const replace =
    `async loadActiveProvider(){try{const zcodeOaiActive=await this.credentialService.load(${activeKey});` +
    `if(zcodeOaiActive!=="openai")return zcodeOaiActive;` +
    `for(const zcodeOaiFamily of ["zai","bigmodel"]){try{` +
    `if(await this.credentialService.load(${tokenKey}(zcodeOaiFamily)))return zcodeOaiFamily}catch(zcodeOaiProbe){}}` +
    `return null}catch(${errVar}){if(!${isCorrupt}(${errVar}))throw ${errVar};` +
    `return await this.clearCorruptOAuthSession(),null}}`;
  return { find: full, replace };
}

// The renderer applies the OAuth callback result straight into the app identity
// (setUser) and the provider-family domain. For OpenAI that turns the ChatGPT user
// into the app account and drops the family domain to null, which makes the
// settings navigation render every family's coding-plan rows. Skip both for openai.
function resolveOpenAiCallbackIdentity(text) {
  const re = new RegExp(
    `if\\((${JS_IDENT})\\.setUser\\(\\1\\.result\\.userInfo\\),\\1\\.setOAuthError\\(null\\),` +
    `await \\1\\.setProviderFamilyDomain\\(\\1\\.result\\.provider\\),`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`openaiCallbackIdentity: OAuth success handler found ${matches.length} times`);
  }
  const [full, ctx] = matches[0];
  const replace =
    `if(${ctx}.result.provider!=="openai"&&${ctx}.setUser(${ctx}.result.userInfo),` +
    `${ctx}.setOAuthError(null),` +
    `${ctx}.result.provider!=="openai"&&await ${ctx}.setProviderFamilyDomain(${ctx}.result.provider),`;
  return { find: full, replace };
}

// The 3.14.x settings navigation already renders branded Z.ai and BigModel preset
// entries. It also appends their obsolete Start Plan coding-plan nodes, producing
// two indistinguishable rows whenever no family domain is selected. Remove only
// that append; the branded entries and their detail/entitlement paths stay intact.
function resolveOpenAiRemoveLegacyStartPlans(text) {
  const re = new RegExp(
    `,\\.\\.\\.(${JS_IDENT})\\.filter\\((${JS_IDENT})=>(${JS_IDENT})\\(\\2\\.presetId\\)\\)\\]`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`openaiStartPlanNav: legacy Start Plan append found ${matches.length} times`);
  }
  return { find: matches[0][0], replace: ']' };
}

// Give the managed OAuth-backed provider its own settings group between the
// built-in and personal-provider sections. The item stays type "custom" so the
// stock personal-provider detail and full model editor remain available. When
// the provider is absent (logged out), a placeholder keeps the entry visible so
// the detail page can offer reconnect instead of vanishing entirely.
function resolveOpenAiSettingsGroup(text) {
  const re = new RegExp(
    `(\\{id:\\x60preset\\x60,title:(${JS_IDENT})\\.formatMessage\\(\\{id:` +
    `\\x60settings\\.modelProvider\\.presetTitle\\x60\\}\\),items:\\[[\\s\\S]{0,1400}?\\]\\}),` +
    `\\{id:\\x60custom\\x60,title:(${JS_IDENT})\\.formatMessage\\(\\{id:` +
    `\\x60settings\\.modelProvider\\.customTitle\\x60\\}\\),items:(${JS_IDENT})\\.map\\((${JS_IDENT})=>` +
    `\\(\\{key:(${JS_IDENT})\\(\\5\\.providerId\\),type:\\x60custom\\x60,label:(${JS_IDENT})\\(\\5\\),` +
    `provider:\\5,statusActive:\\5\\.executable===!0\\}\\)\\)\\}`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`openaiSettingsGroup: preset/custom group pair found ${matches.length} times`);
  }
  const [full, presetGroup, presetIntl, customIntl, providers, item, keyFn, labelFn] = matches[0];
  if (presetIntl !== customIntl) {
    throw new Error('openaiSettingsGroup: preset/custom groups use different intl bindings');
  }
  const providerId = '"zcode-openai-codex"';
  const mapItem = value =>
    `${value}.map(${item}=>({key:${keyFn}(${item}.providerId),type:\x60custom\x60,` +
    `label:${labelFn}(${item}),provider:${item},statusActive:${item}.executable===!0}))`;
  const openaiItems =
    `(${providers}.some(${item}=>${item}.providerId===${providerId})?` +
    mapItem(`${providers}.filter(${item}=>${item}.providerId===${providerId})`) +
    `:[{key:${keyFn}(${providerId}),type:\x60custom\x60,label:\x60OpenAI\x60,provider:null,statusActive:!1}])`;
  const customItems = mapItem(`${providers}.filter(${item}=>${item}.providerId!==${providerId})`);
  const replace =
    `${presetGroup},{id:\x60openai\x60,title:\x60OpenAI\x60,items:${openaiItems}},` +
    `{id:\x60custom\x60,title:${customIntl}.formatMessage({id:\x60settings.modelProvider.customTitle\x60}),` +
    `items:${customItems}}`;
  return { find: full, replace };
}

// OpenAI is connected via OAuth, not owned by the user like a custom provider.
// The stock custom-detail branch ends in a delete action; replace it for the
// managed provider with the old patch's connect/disconnect card. The card uses
// Detail's existing onCodingPlanLogin/onCodingPlanDisconnect callbacks, so the
// OAuth entry point and provider refresh stay on stock code paths. Non-OpenAI
// custom providers keep the original branch byte-identical.
function resolveOpenAiConnectCard(text) {
  const re = new RegExp(
    `if\\((${JS_IDENT})\\.type===\`codingPlanLoading\`\\)return null;` +
    `if\\(!\\1\\.provider\\)return\\(0,(${JS_IDENT})\\.jsx\\)\\((${JS_IDENT}),\\{loadingLabel:(${JS_IDENT})\\}\\);` +
    `let (${JS_IDENT})=\\1\\.provider,(${JS_IDENT})=\\5\\.templateId\\?(${JS_IDENT})\\(\\5\\):void 0;` +
    `return\\(0,\\2\\.jsx\\)\\((${JS_IDENT}),\\{provider:\\5,onSave:(${JS_IDENT}),` +
    `\\.\\.\\.(${JS_IDENT}),onDelete:\\(\\)=>(${JS_IDENT})\\(\\5\\),` +
    `onReorderModelIds:(${JS_IDENT})\\?(${JS_IDENT})=>\\12\\(\\5\\.providerId,\\13\\):void 0,` +
    `onTestModel:(${JS_IDENT}),`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`openaiConnectCard: custom provider detail branch found ${matches.length} times`);
  }
  const [full, item, jsx, loading, loadingLabel, provider, apiKeyUrl, urlFn, card,
    onSave, editingProps, onDelete, reorder, reorderIds, onTest] = matches[0];
  const loginRe = new RegExp(
    `onCodingPlanLogin:(${JS_IDENT}),onRetryCodingPlan:(${JS_IDENT}),` +
    `onCodingPlanDisconnect:(${JS_IDENT}),onOpenApiKeyUrl:`, 'g');
  const loginMatches = [...text.matchAll(loginRe)];
  if (loginMatches.length !== 1) {
    throw new Error(`openaiConnectCard: coding plan login/disconnect props found ${loginMatches.length} times`);
  }
  const [, onLogin, , onDisconnect] = loginMatches[0];
  const jsxEsc = jsx.replace(/[$^.*+?()[\]{}|\\]/g, '\\$&');
  const buttonRe = new RegExp(`\\(0,${jsxEsc}\\.jsx\\)\\((${JS_IDENT}),\\{variant:\`outline\`,children:\`Close\`\\}\\)`, 'g');
  const buttonMatches = [...text.matchAll(buttonRe)];
  if (buttonMatches.length !== 1) {
    throw new Error(`openaiConnectCard: shared Button binding found ${buttonMatches.length} times`);
  }
  const button = buttonMatches[0][1];
  const providerId = '`zcode-openai-codex`';
  const connectCard =
    `(0,${jsx}.jsx)(\`div\`,{className:\`rounded-xl border border-border bg-card p-5\`,children:` +
    `(0,${jsx}.jsxs)(\`div\`,{className:\`flex items-center justify-between gap-4\`,children:[` +
    `(0,${jsx}.jsxs)(\`div\`,{className:\`space-y-1\`,children:[` +
    `(0,${jsx}.jsx)(\`div\`,{className:\`text-ui-base font-medium text-foreground\`,` +
    `children:${provider}?\`OpenAI 已连接\`:\`未连接\`}),` +
    `(0,${jsx}.jsx)(\`div\`,{className:\`text-ui-sm text-foreground-subtle\`,` +
    `children:${provider}?\`ChatGPT 订阅已通过 OAuth 连接，OpenAI 模型可正常使用。\`:` +
    `\`连接 ChatGPT 订阅后，即可使用 OpenAI 模型。\`})]}),` +
    `(0,${jsx}.jsx)(${button},{type:\`button\`,variant:${provider}?\`outline\`:\`default\`,` +
    `onClick:()=>{${provider}?${onDisconnect}(${providerId},\`openai\`,\`OpenAI\`):` +
    `${onLogin}(${providerId},\`openai\`,\`OpenAI\`,\`disconnected\`)},` +
    `children:${provider}?\`断开连接\`:\`连接 OpenAI\`})]})})`;
  const managedEditor =
    `(0,${jsx}.jsx)(${card},{provider:${provider},onSave:${onSave},...${editingProps},` +
    `onDelete:void 0,onReorderModelIds:${reorder}?${reorderIds}=>${reorder}(${provider}.providerId,${reorderIds}):void 0,` +
    `onTestModel:${onTest},presetApiKeyUrl:void 0,readOnlyEndpoints:!0,nameEditable:!1,` +
    `onOpenPresetApiKey:void 0})`;
  const replace =
    `if(${item}.type===\`codingPlanLoading\`)return null;let ${provider}=${item}.provider;` +
    `if(${item}.key===\`custom:zcode-openai-codex\`)return(0,${jsx}.jsxs)(\`div\`,` +
    `{className:\`space-y-3\`,children:[${connectCard},${provider}?${managedEditor}:null]});` +
    `if(!${item}.provider)return(0,${jsx}.jsx)(${loading},{loadingLabel:${loadingLabel}});` +
    `let ${apiKeyUrl}=${provider}.templateId?${urlFn}(${provider}):void 0;` +
    `return(0,${jsx}.jsx)(${card},{provider:${provider},onSave:${onSave},...${editingProps},` +
    `onDelete:()=>${onDelete}(${provider}),` +
    `onReorderModelIds:${reorder}?${reorderIds}=>${reorder}(${provider}.providerId,${reorderIds}):void 0,` +
    `onTestModel:${onTest},`;
  return { find: full, replace };
}

// Route OpenAI disconnect through the same settings callback Z.ai/BigModel use.
// The stock handler intentionally ignores non-Z.ai providers; OpenAI just needs
// logout + provider refresh (no family domain or coding-plan webview cleanup).
function resolveOpenAiDisconnectHandler(text) {
  const re = new RegExp(
    `async\\((${JS_IDENT}),(${JS_IDENT}),(${JS_IDENT})\\)=>\\{` +
    `if\\(!\\(\\2!==\`bigmodel\`&&\\2!==\`zai\`\\)\\)\\{(${JS_IDENT})\\(\\1\\),(${JS_IDENT})\\(\\1\\);try\\{`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`openaiDisconnectHandler: coding plan disconnect handler found ${matches.length} times`);
  }
  const [full, preset, provider, providerName, setDisconnect, setSync] = matches[0];
  const logoutMatch = text.match(new RegExp(`await (${JS_IDENT})\\.logout\\(${provider}\\)`));
  const refreshMatch = text.match(new RegExp(`clearUserWhenLoggedOut:!0\\}\\),await (${JS_IDENT})\\(\\),`));
  const loggerMatch = text.match(new RegExp(`(${JS_IDENT})\\.info\\(\`\\[ModelProviderSection\\] 请求解绑`));
  if (!logoutMatch || !refreshMatch || !loggerMatch) {
    throw new Error('openaiDisconnectHandler: logout/refresh/logger bindings not found');
  }
  const [, oauthService] = logoutMatch;
  const [, refresh] = refreshMatch;
  const [, logger] = loggerMatch;
  const clear = `${setDisconnect}(zcodeOaiP=>zcodeOaiP===${preset}?null:zcodeOaiP),` +
    `${setSync}(zcodeOaiP=>zcodeOaiP===${preset}?null:zcodeOaiP)`;
  const replace =
    `async(${preset},${provider},${providerName})=>{` +
    `if(${provider}===\`openai\`){${setDisconnect}(${preset}),${setSync}(${preset});try{` +
    `await ${oauthService}.logout(${provider}),await ${refresh}()` +
    `}catch(zcodeOaiErr){${logger}.error(\`[ModelProviderSection] 断开 OpenAI 连接失败\`,{error:zcodeOaiErr})}` +
    `finally{${clear}}return}` +
    full.slice(`async(${preset},${provider},${providerName})=>{`.length);
  return { find: full, replace };
}

// The OpenAI settings group is managed, so it should use the fixed provider-row
// renderer rather than the drag-and-drop personal-provider renderer.
function resolveOpenAiFixedNavigation(text) {
  const re = new RegExp(
    `(${JS_IDENT})\\.id===\\x60preset\\x60\\?\\(0,(${JS_IDENT})\\.jsx\\)\\((${JS_IDENT}),` +
    `\\{group:\\1,selectedNodeKey:(${JS_IDENT}),onSelectNavItem:(${JS_IDENT})\\}\\):` +
    `\\(0,\\2\\.jsx\\)\\((${JS_IDENT}),\\{group:\\1,selectedNodeKey:\\4,` +
    `onSelectNavItem:\\5,`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`openaiFixedNavigation: navigation renderer branch found ${matches.length} times`);
  }
  const [full, group, jsx, fixedRenderer, selected, selectItem, sortableRenderer] = matches[0];
  const replace =
    `${group}.id===\x60preset\x60||${group}.id===\x60openai\x60?` +
    `(0,${jsx}.jsx)(${fixedRenderer},{group:${group},selectedNodeKey:${selected},onSelectNavItem:${selectItem}}):` +
    `(0,${jsx}.jsx)(${sortableRenderer},{group:${group},selectedNodeKey:${selected},` +
    `onSelectNavItem:${selectItem},`;
  return { find: full, replace };
}

// Pull OpenAI out of the ordinary registry-provider sequence. A family-prefixed
// key gives it the same native separator treatment as built-in account groups,
// while directItems remains unset so its models stay in a submenu.
function resolveOpenAiModelMenuFirst(text) {
  const re = new RegExp(
    `function (${JS_IDENT})\\((${JS_IDENT}),(${JS_IDENT}),(${JS_IDENT})=\\{\\}\\)\\{` +
    `return \\3\\.providers\\.flatMap\\((${JS_IDENT})=>\\{if\\(!(${JS_IDENT})` +
    `\\(\\2,\\5\\.config\\.api\\?\\.type\\)\\)return\\[\\];`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`openaiModelMenuFirst: registry group builder found ${matches.length} times`);
  }
  const [full, fn, selected, view, labels, provider, supports] = matches[0];
  const providerId = '"zcode-openai-codex"';
  const replace =
    `function ${fn}(${selected},${view},${labels}={}){` +
    `const zcodeOaiMenuProviders=[...${view}.providers.filter(zcodeOaiMenuProvider=>` +
    `zcodeOaiMenuProvider.providerId===${providerId}),...${view}.providers.filter(` +
    `zcodeOaiMenuProvider=>zcodeOaiMenuProvider.providerId!==${providerId})];` +
    `return zcodeOaiMenuProviders.flatMap(${provider}=>{if(${provider}.providerId!==${providerId}&&` +
    `!${supports}(${selected},${provider}.config.api?.type))return[];`;
  return { find: full, replace };
}

// Change the generated group presentation for OpenAI without touching item values
// or ordinary providers. The family key creates a native separator; no directItems
// flag is added, so OpenAI remains a submenu.
function resolveOpenAiModelMenuPresentation(text) {
  const re = new RegExp(
    `return\\[\\{key:\\x60registry-provider:\\$\\{(${JS_IDENT})\\.providerId\\}\\x60,` +
    `label:(${JS_IDENT})\\?\\.label\\|\\|\\1\\.providerName\\?\\.trim\\(\\)\\|\\|\\1\\.providerId,`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`openaiModelMenuPresentation: registry group presentation found ${matches.length} times`);
  }
  const [full, provider, presentation] = matches[0];
  const managed = `${provider}.providerId==="zcode-openai-codex"`;
  const replace =
    `return[{key:${managed}?\x60family:openai\x60:` +
    `\x60registry-provider:\${${provider}.providerId}\x60,label:${managed}?\x60OpenAI\x60:` +
    `${presentation}?.label||${provider}.providerName?.trim()||${provider}.providerId,`;
  return { find: full, replace };
}

// Keep the managed provider endpoint/name guards at the host write boundary, but
// hide its connection and API key sections entirely. The header toggle and
// ProviderModelsSection are untouched.
function resolveOpenAiHideManagedFields(text) {
  const re = new RegExp(
    `,(${JS_IDENT})=(${JS_IDENT})\\.config\\.access\\?\\.type===` +
    `\\x60zhipu-account\\x60,(${JS_IDENT})=(${JS_IDENT})\\(\\2\\.config\\.access\\);` +
    `return[\\s\\S]{0,1700}?children:\\[\\1\\?null:`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`openaiHideManagedFields: provider card body found ${matches.length} times`);
  }
  const provider = matches[0][2];
  const account = matches[0][1];
  const apiKey = matches[0][3];
  const connectionFind = `${account}?null:`;
  const apiKeyRe = new RegExp(`${apiKey}\\?\\(0,${JS_IDENT}\\.jsx\\)\\(`, 'g');
  const apiKeyMatches = [...text.matchAll(apiKeyRe)].filter(match =>
    match.index > matches[0].index && match.index < matches[0].index + 3000);
  if (countMatches(text, connectionFind) !== 1 || apiKeyMatches.length !== 1) {
    throw new Error('openaiHideManagedFields: connection or API key branch is not unique');
  }
  const apiKeyFind = `${apiKey}?`;
  return {
    find: `${connectionFind}${text.slice(text.indexOf(connectionFind) + connectionFind.length, apiKeyMatches[0].index)}${apiKeyFind}`,
    replace: `(${account}||${provider}.providerId==="zcode-openai-codex")?null:` +
      `${text.slice(text.indexOf(connectionFind) + connectionFind.length, apiKeyMatches[0].index)}` +
      `${apiKey}&&${provider}.providerId!=="zcode-openai-codex"?`,
  };
}

// OpenAI is never the active app account, so the stock OAuthService.logout
// (which only clears the active provider) would leave the Codex credential and
// managed provider in place. Route logout("openai") through the credential
// repo's clearProvider, which already triggers zcodeOaiRemoveProvider.
function resolveOpenAiLogoutProvider(text) {
  const re = new RegExp(
    `async logout\\((${JS_IDENT})\\)\\{if\\(!\\1\\)\\{await this\\.logoutActiveSession\\(\\);return\\}`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`openaiLogoutProvider: OAuthService.logout found ${matches.length} times`);
  }
  const [full, provider] = matches[0];
  const replace =
    `async logout(${provider}){if(${provider}==="openai"){await this.repo.clearProvider("openai"),` +
    `await this.cancelPending("openai");return}if(!${provider}){await this.logoutActiveSession();return}`;
  return { find: full, replace };
}

// Reject attempts to mutate the managed provider identity or endpoint at the
// host write boundary. Enabled/access/model operations remain valid.
function resolveOpenAiManagedProviderGuard(text) {
  const re = new RegExp(
    `async savePersonalProviderOverlay\\((${JS_IDENT}),(${JS_IDENT}),(${JS_IDENT}),(${JS_IDENT})\\)` +
    `\\{(${JS_IDENT})\\("providerId",\\1\\);`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`openaiManagedProviderGuard: save boundary found ${matches.length} times`);
  }
  const [full, providerId, config, membership, metadata, validate] = matches[0];
  const guard =
    `if(${providerId}==="zcode-openai-codex"){` +
    `if(${metadata}?.providerName!==void 0&&${metadata}.providerName?.trim()!=="OpenAI")` +
    `throw new Error("OpenAI provider name is managed");` +
    `if(${config}.api===null||${config}.api?.type!==void 0&&${config}.api.type!=="openai-responses"||` +
    `${config}.api?.baseUrl!==void 0&&String(${config}.api.baseUrl).replace(/\\/+$/,'')!==` +
    `"https://chatgpt.com/backend-api/codex")throw new Error("OpenAI provider endpoint is managed")}`;
  return {
    find: full,
    replace: `async savePersonalProviderOverlay(${providerId},${config},${membership},${metadata})` +
      `{${validate}("providerId",${providerId});${guard}`,
  };
}

const RESOLVERS = {
  'openai.injectAndRegisterConfig': resolveOpenAiInjectAndRegisterConfig,
  'openai.registerAdapterCase': resolveOpenAiRegisterAdapterCase,
  'openai.appendKnownId': resolveOpenAiAppendKnownId,
  'openai.hookStartupSync': resolveOpenAiHookStartupSync,
  'openai.hookManualRefresh': resolveOpenAiHookManualRefresh,
  'openai.hookLogout': resolveOpenAiHookLogout,
  'openai.logoutProvider': resolveOpenAiLogoutProvider,
  'openai.noActiveFlip': resolveOpenAiNoActiveFlip,
  'openai.sanitizeActiveProvider': resolveOpenAiSanitizeActiveProvider,
  'openai.managedProviderGuard': resolveOpenAiManagedProviderGuard,
  'openai.codexStoreFalse': resolveOpenAiCodexStoreFalse,
  'openai.codexArgsWhitelist': resolveOpenAiCodexArgsWhitelist,
  'openai.codexErrorSchema': resolveOpenAiCodexErrorSchema,
  'openai.callbackIdentity': resolveOpenAiCallbackIdentity,
  'openai.removeLegacyStartPlans': resolveOpenAiRemoveLegacyStartPlans,
  'openai.settingsGroup': resolveOpenAiSettingsGroup,
  'openai.connectCard': resolveOpenAiConnectCard,
  'openai.disconnectHandler': resolveOpenAiDisconnectHandler,
  'openai.fixedNavigation': resolveOpenAiFixedNavigation,
  'openai.modelMenuFirst': resolveOpenAiModelMenuFirst,
  'openai.modelMenuPresentation': resolveOpenAiModelMenuPresentation,
  'openai.hideManagedFields': resolveOpenAiHideManagedFields,
  'openai.rendererIcon': resolveOpenAiRendererIcon,
};

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
  RESOLVERS,
  OPENAI_OAUTH_INJECTION,
  buildOpenAiSyncInjection,
};

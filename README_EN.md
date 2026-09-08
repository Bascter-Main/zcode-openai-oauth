# ZCode OpenAI OAuth Patcher

[中文](README.md) | **English**

Adds a built-in **OpenAI model provider** to the [ZCode](https://zcode.z.ai) desktop app for Windows. Sign in with a ChatGPT subscription (Plus/Pro) through OAuth and use GPT models directly in chat without affecting the existing Z.ai or BigModel account.

Verified versions: ZCode **3.10.2 and 3.11.2** (stable patch baseline: `v1.0.0`). The patcher selects an exact-version compatibility profile; unknown versions are never attempted silently in deploy mode.

## Quick Start

```bat
git clone https://github.com/Bascter-Main/zcode-openai-oauth.git
cd zcode-openai-oauth
patch.bat
```

`patch.bat` requires Node.js 18 or later and installs the small asar packaging dependency from the lockfile on its first run. It then extracts `app.asar`, applies uniquely validated content-anchor patches, checks every modified JavaScript file, repackages the application, closes ZCode, deploys both runtime components transactionally, and restarts ZCode.

After ZCode restarts, open **Settings → Model Providers → OpenAI → Connect** and complete authorization in the browser. The model picker will then show an OpenAI submenu. Its GPT model list is fetched **dynamically** from the Codex model catalog.

Additional commands:

```bat
node patch.js --probe        :: Read-only compatibility inspection (does not modify the install or restart ZCode)
node patch.js --dry-run      :: Fully patch and repack a precisely supported version without writing to the install
node patch.js --restore      :: Restore pristine files from the hash-verified same-version backup
node patch.js --dir <path>   :: Use a custom ZCode installation directory
```

**After a ZCode upgrade:** the official updater will overwrite the patch. Run `patch.bat` again after the upgrade. The patch uses content anchors plus exact-version profiles instead of fixed byte offsets; every anchor must match exactly once. If ZCode changes the relevant implementation, the patcher reports the affected target/anchor and aborts without deploying a partially patched package.

### Version compatibility policy

- **Verified versions:** the profile matches the exact version and all anchors, syntax checks, postconditions, critical data-flow invariants, and the isolated repack pass before deployment is allowed.
- **Structural candidates:** `--probe` reports which semantic transforms still locate and which exact anchors failed. The report is migration evidence only and never creates a deployable profile.
- **Unknown versions:** deploy and restore fail explicitly because no verified profile exists. Minified identifiers are not guessed and fuzzy replacement is never attempted.
- **Adding a profile:** a version is indexed only after its pristine `app.asar` and `resources/glm/zcode.cjs` are available, the actual bindings used by large host/renderer injections are reviewed again, and the complete test matrix passes. Version wildcards such as `3.10.x` are not used.

## Runtime patch mode (experimental)

The default flow writes the patch into `app.asar` at deploy time. Runtime mode leaves the bundles untouched on disk: after extraction, the same profile is applied **at load time** — main/host/scheduler through module loader hooks, the renderer through protocol-level response rewriting. Every site degrades independently: if an anchor stops matching after an update, that feature is simply absent while the app keeps running; a broken package is never produced. Preloads and the agent runtime cannot be intercepted at load time, so they are flat-patched at install time (with `.rt-pristine` backups).

```bat
:: Install (close ZCode first; if the static patch was applied before, run node patch.js --restore first)
node runtime/install-runtime.js --dir "D:\Program Files\ZCode"

:: After launching ZCode once, verify runtime delivery is byte-identical to the strict static transform
node runtime/verify-runtime.js --dir "D:\Program Files\ZCode"

:: Uninstall (close ZCode first)
node runtime/install-runtime.js --dir "D:\Program Files\ZCode" --restore
```

Delivery details are recorded in `resources/app/out/.zcode-runtime/runtime.log` (per-target anchor hits, postcondition and critical-invariant results, delivered content hashes).

## Transform Framework

Patches are more than text replacement. Every migratable edit point is declared as a **semantic transform** in `transforms/registry.json`:

| Transform | Purpose | Coverage |
|---|---|---|
| `schema.oauth-method-enum` / `oauth-provider-enum` / `oauth-connection-secrets` | Register openai in the OAuth schemas | GLM, protocol, scheduler, preload×5, renderer |
| `registry.provider-id-map` | Register the three `builtin:openai*` provider IDs | 7 bundles |
| `registry.builtin-provider-predicate` | Include OpenAI providers in the workspace catalog | GLM, protocol, renderer |
| `registry.start-plan-predicate` / `coding-plan-predicate` | Recognize OpenAI start/coding plans | renderer, protocol |
| `registry.provider-family-descriptor` | Register the OpenAI provider family | GLM, renderer, scheduler, preload×5 |
| `glm.reasoning-levels-parser` | Accept reasoning levels in both array and object form | GLM |

Location uses three progressive levels:

1. **Semantic locate** — patterns capture minified identifier names with wildcards (for example `` zapi:`${X}zapi` `` adapts to any renamed prefix variable such as `M2`, `Te`, or `We`), and must match exactly once in the whole bundle;
2. **Exact-anchor fallback** — if semantic location fails on a verified version, the version's full content anchor is used;
3. **Fail-closed** — if neither matches, the run aborts without writing anything.

On verified versions the semantic transform output must be **byte-identical** to the anchor output, otherwise the run is rejected (guards against transform drift). `--probe` reports each transform's resolution level (`semantic` / `anchor-fallback` / `failed`), so after an upgrade you can see exactly which semantic site changed. Large injections (host catalog sync, renderer JSX, and similar) stay on exact anchors but keep unique target/span diagnostics.

The final bundles also pass two cross-span data-flow invariants: the OpenAI preset must be pushed into the provider array captured from `loadPresetProviders`, and both settings groups must filter the labeled display array produced by `presetProviders.map(...)`. These checks capture actual bindings rather than relying on minified names such as `n` or `pe`, so renamed or reused identifiers fail closed before deployment.

## How It Works

| Layer | Implementation |
|---|---|
| OAuth | Uses the public Codex CLI client (`app_EMoamEEZ73f0CkXaXp7hrann`) with PKCE S256. A local loopback server at `127.0.0.1:1455` receives the callback and completes the token exchange in the host process. Tokens refresh automatically 60 seconds before expiration. |
| Model catalog | Calls `GET chatgpt.com/backend-api/codex/models` with the bearer token, `OpenAI-Beta: responses=experimental`, and `chatgpt-account-id`. The catalog refreshes during preset synchronization and falls back to a static list when offline. |
| Requests | Uses the Responses API with the required `store:false` and `stream:true` settings and sends only `model`, `instructions`, `input`, `tools`, `store`, `stream`, `include`, and `reasoning`. |
| Compatibility add-on | OpenAI-compatible chat-completions endpoints use `reasoning_effort` instead of the unsupported `thinking` field; Anthropic reasoning configuration remains unchanged. |
| UI | Adds a dedicated OpenAI provider group, the official OpenAI logo, and connect/disconnect controls. |

## Files

- `patch.js` — version-independent patch engine (profile selection, extraction, patching, validation, repacking, probing, deployment, and restart)
- `patch-core.cjs` — pure-text patch core shared by the static patcher and runtime mode (content anchors, semantic transforms, critical data-flow invariants)
- `runtime/` — runtime patch mode: load-time transforms (bootstrap, loader hooks, protocol rewriting) plus install/verify scripts
- `profiles/index.json` — exact ZCode version to compatibility profile mapping
- `profiles/<version>/profile.json` — target, marker, postcondition, and spec-checksum configuration
- `profiles/<version>/patch-spec.json` — content-anchor patches for target bundles inside `app.asar`
- `profiles/<version>/glm-spec.json` — content-anchor patches for the agent runtime at `resources/glm/zcode.cjs`
- `transforms/registry.json` — semantic transform definitions (version-tolerant site location and insertion templates)
- `package.json` / `package-lock.json` — locks the asar dependency version used by the patcher
- `patch.bat` — Windows double-click entry point; installs dependencies automatically on first run

## License

This project is licensed under the [MIT License](LICENSE).

## Disclaimer

This project is intended for learning and research. It uses the public Codex CLI OAuth client and observed API behavior. Follow the OpenAI and ZCode terms of service. You are responsible for any account-related consequences of using this patch.

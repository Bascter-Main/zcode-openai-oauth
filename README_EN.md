# ZCode OpenAI OAuth Patcher

[中文](README.md) | **English**

Adds a built-in **OpenAI model provider** to the [ZCode](https://zcode.z.ai) desktop app for Windows. Sign in with a ChatGPT subscription through OAuth and use the GPT models currently enabled for that account without changing the existing Z.ai or BigModel application identity.

Verified versions: ZCode **3.10.2, 3.11.2, and 3.14.3**. The patcher selects an exact-version compatibility profile; unknown versions are never attempted silently in deploy mode.

## Quick Start

```bat
git clone https://github.com/Bascter-Main/zcode-openai-oauth.git
cd zcode-openai-oauth
patch.bat
```

`patch.bat` requires Node.js 18 or later and installs the small asar packaging dependency from the lockfile on its first run. It then extracts `app.asar`, applies uniquely validated content-anchor patches, checks every modified JavaScript file, repackages the application, closes ZCode, deploys both runtime components transactionally, and restarts ZCode.

After ZCode restarts, open **Settings → Model Providers → OpenAI → Connect** and complete authorization in the browser. OpenAI appears as a dedicated group in both settings and the model picker. Its model list is fetched **dynamically** from the Codex catalog and reflects the subscription and workspace entitlements of the connected account, including GPT-6 Sol, Astra, and Luna when enabled.

Additional commands:

```bat
node patch.js --probe        :: Read-only compatibility inspection (does not modify the install or restart ZCode)
node patch.js --dry-run      :: Fully patch and repack a precisely supported version without writing to the install
node patch.js --no-deploy    :: Produce validated .patched files without deploying them
node patch.js --self-test    :: Run the patcher's fixture and behavior checks
node patch.js --restore      :: Restore pristine files from the hash-verified same-version backup
node patch.js --dir <path>   :: Use a custom ZCode installation directory
```

**After a ZCode upgrade:** the official updater will overwrite the patch. Run `patch.bat` again after the upgrade. The patch uses content anchors plus exact-version profiles instead of fixed byte offsets; every anchor must match exactly once. If ZCode changes the relevant implementation, the patcher reports the affected target/anchor and aborts without deploying a partially patched package.

### Current features

- OpenAI is a dedicated top-level settings group between Z.ai and custom providers. Connecting it never replaces the Z.ai or BigModel account shown by ZCode.
- The OpenAI detail page shows OAuth connection status with **Connect OpenAI** and **Disconnect** actions. The navigation entry remains available after disconnecting so the account can be connected again.
- Managed provider identity, Base URL, API format, and OAuth credential fields are hidden. The provider enabled switch and model management remain available.
- Models can be added, edited, enabled, disabled, deleted, and reordered. Online refresh preserves user-added models, explicit manual rules, context-window overrides, and unrelated provider settings.
- The Codex catalog synchronizes after the first connection, at startup, after token refresh, and from the existing manual refresh action on the Model Providers page. Managed models follow server-side availability and account entitlements.
- The Codex client version is discovered from the public stable `@openai/codex` metadata and cached. Offline sync uses the last successful version or a verified compatibility baseline so an obsolete catalog version does not hide newly released models.

### Version compatibility policy

- **Verified versions:** the profile matches the exact version and all anchors, syntax checks, postconditions, critical data-flow invariants, and the isolated repack pass before deployment is allowed.
- **Structural candidates:** `--probe` reports which semantic transforms still locate and which exact anchors failed. The report is migration evidence only and never creates a deployable profile.
- **Unknown versions:** deploy and restore fail explicitly because no verified profile exists. Minified identifiers are not guessed and fuzzy replacement is never attempted.
- **Adding a profile:** a version is indexed only after its pristine `app.asar` and `resources/glm/zcode.cjs` are available, the actual bindings used by large host/renderer injections are reviewed again, and the complete test matrix passes. Version wildcards such as `3.10.x` are not used.

## Runtime patch mode (experimental)

The default flow writes the patch into `app.asar` at deploy time. Runtime mode leaves the original bundles untouched: after extraction, the same profile is applied **at load time** — main/host/scheduler through module loader hooks, the renderer through protocol-level response rewriting. Load-time targets can degrade independently and record failed sites. Preloads and the agent runtime cannot be intercepted at load time, so they are flat-patched in strict mode during installation (with `.rt-pristine` backups); any strict validation failure aborts the installation.

```bat
:: Install (fully exit ZCode from the tray first; the installer refuses to write while the target runs)
:: If the static patch was applied before, run node patch.js --restore first
node runtime/install-runtime.js --dir "D:\Program Files\ZCode"

:: Restart ZCode after installation, wait for the main window, then verify the current install generation
:: Verifying without a restart reports that requirement instead of comparing stale-process hashes
node runtime/verify-runtime.js --dir "D:\Program Files\ZCode"

:: Uninstall (close ZCode first)
node runtime/install-runtime.js --dir "D:\Program Files\ZCode" --restore
```

Delivery details are recorded in `resources/app/out/.zcode-runtime/runtime.log` (per-target anchor hits, postcondition and critical-invariant results, delivered content hashes).

## Transform Framework

Patches are more than text replacement. Each exact-version profile selects a strict location mechanism:

| Mechanism | Versions | Behavior |
|---|---|---|
| Semantic transforms plus exact anchors | 3.10.2 and 3.11.2 | `transforms/registry.json` captures minified bindings. Semantic output must be byte-identical to the verified anchor output or deployment is rejected. |
| Semantic resolvers | 3.14.3 | `patch-core.cjs` locates host and renderer logic from retained function names, structure, and strings. Every resolver must match exactly once or fail closed. |
| Strict postconditions and critical invariants | All profiles | Final bundles are checked for OAuth registration, account isolation, catalog synchronization, connect/disconnect behavior, settings groups, model-menu presentation, and request compatibility. |

`--probe` runs the same location, syntax, postcondition, and critical-invariant checks against the current installation without producing deployable output. Older transform profiles can fall back from semantic location to an exact anchor; resolver-only profiles require a unique structural match. If any required site cannot be verified, the patcher aborts without writing installation files.

## How It Works

| Layer | Implementation |
|---|---|
| OAuth | Uses the public Codex CLI client (`app_EMoamEEZ73f0CkXaXp7hrann`) with PKCE S256. A local loopback server at `127.0.0.1:1455` receives the callback and completes the token exchange in the host process. Tokens refresh automatically. |
| Model catalog | Calls `GET chatgpt.com/backend-api/codex/models` with the bearer token, `OpenAI-Beta: responses=experimental`, and `chatgpt-account-id`. It synchronizes after connection, at startup, after token refresh, and on manual refresh. The catalog client version is discovered and cached; failures keep the existing configuration intact. |
| Model merge | Server-managed models follow catalog and entitlement changes, while user-added models, explicit rules, context overrides, order, and unrelated provider settings are preserved. |
| Requests | Uses the Responses API with the required `store:false` and `stream:true` settings and removes parameters or reasoning levels unsupported by the subscription backend. |
| Compatibility add-on | OpenAI-compatible chat-completions endpoints use `reasoning_effort` instead of the unsupported `thinking` field; Anthropic reasoning configuration remains unchanged. |
| UI | Adds dedicated OpenAI settings/model groups, the official OpenAI logo, and connect/disconnect controls. Managed connection fields are hidden while model editing remains available. |

## Files

- `patch.js` — version-independent patch engine (profile selection, extraction, patching, validation, repacking, probing, deployment, and restart)
- `patch-core.cjs` — patch core shared by the static patcher and runtime mode (semantic transforms, resolvers, content anchors, and critical invariants)
- `runtime/` — runtime patch mode: load-time transforms (bootstrap, loader hooks, protocol rewriting) plus install/verify scripts
- `profiles/index.json` — exact ZCode version to compatibility profile mapping
- `profiles/<version>/profile.json` — target, marker, postcondition, and spec-checksum configuration
- `profiles/<version>/patch-spec.json` — resolver or content-anchor patches for target bundles inside `app.asar`
- `profiles/<version>/glm-spec.json` — resolver or content-anchor patches for the agent runtime at `resources/glm/zcode.cjs`
- `transforms/registry.json` — semantic transform definitions (version-tolerant site location and insertion templates)
- `package.json` / `package-lock.json` — locks the asar dependency version used by the patcher
- `patch.bat` — Windows double-click entry point; installs dependencies automatically on first run

## License

This project is licensed under the [MIT License](LICENSE).

## Disclaimer

This project is intended for learning and research. It uses the public Codex CLI OAuth client and observed API behavior. Follow the OpenAI and ZCode terms of service. You are responsible for any account-related consequences of using this patch.

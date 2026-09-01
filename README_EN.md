# ZCode OpenAI OAuth Patcher

[中文](README.md) | **English**

Adds a built-in **OpenAI model provider** to the [ZCode](https://zcode.z.ai) desktop app for Windows. Sign in with a ChatGPT subscription (Plus/Pro) through OAuth and use GPT models directly in chat without affecting the existing Z.ai or BigModel account.

Verified version: ZCode **3.10.2** (stable patch baseline: `v1.0.0`). The patcher selects an exact-version compatibility profile; unknown versions are never attempted silently in deploy mode.

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

- **Verified version:** the profile matches the exact version and all anchors, syntax checks, postconditions, and the isolated repack pass before deployment is allowed.
- **Structural candidate:** if a new version appears to match an existing profile, `--probe` produces a compatibility report; it still is not deployed automatically.
- **Unknown version:** deploy and restore fail explicitly because no verified profile exists. There is no fuzzy patching or guessing.
- **Adding a profile:** ZCode 3.10.1/3.10.3 or later can be added only after the corresponding pristine `app.asar` and `resources/glm/zcode.cjs` are available and the same test matrix passes. `3.10.x` wildcards are not used.

## How It Works

| Layer | Implementation |
|---|---|
| OAuth | Uses the public Codex CLI client (`app_EMoamEEZ73f0CkXaXp7hrann`) with PKCE S256. A local loopback server at `127.0.0.1:1455` receives the callback and completes the token exchange in the host process. Tokens refresh automatically 60 seconds before expiration. |
| Model catalog | Calls `GET chatgpt.com/backend-api/codex/models` with the bearer token, `OpenAI-Beta: responses=experimental`, and `chatgpt-account-id`. The catalog refreshes during preset synchronization and falls back to a static list when offline. |
| Requests | Uses the Responses API with the required `store:false` and `stream:true` settings and sends only `model`, `instructions`, `input`, `tools`, `store`, `stream`, `include`, and `reasoning`. |
| UI | Adds a dedicated OpenAI provider group, the official OpenAI logo, and connect/disconnect controls. |

## Files

- `patch.js` — version-independent patch engine (profile selection, extraction, patching, validation, repacking, probing, deployment, and restart)
- `profiles/index.json` — exact ZCode version to compatibility profile mapping
- `profiles/<version>/profile.json` — target, marker, postcondition, and spec-checksum configuration
- `profiles/<version>/patch-spec.json` — content-anchor patches for target bundles inside `app.asar`
- `profiles/<version>/glm-spec.json` — content-anchor patches for the agent runtime at `resources/glm/zcode.cjs`
- `package.json` / `package-lock.json` — locks the asar dependency version used by the patcher
- `patch.bat` — Windows double-click entry point; installs dependencies automatically on first run

## License

This project is licensed under the [MIT License](LICENSE).

## Disclaimer

This project is intended for learning and research. It uses the public Codex CLI OAuth client and observed API behavior. Follow the OpenAI and ZCode terms of service. You are responsible for any account-related consequences of using this patch.

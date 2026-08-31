# ZCode OpenAI OAuth Patcher

[中文](README.md) | **English**

Adds a built-in **OpenAI model provider** to the [ZCode](https://zcode.z.ai) desktop app for Windows. Sign in with a ChatGPT subscription (Plus/Pro) through OAuth and use GPT models directly in chat without affecting the existing Z.ai or BigModel account.

Supported version: ZCode 3.10.x. For other versions, run `--dry-run` first to verify the patch anchors.

## Quick Start

```bat
git clone https://github.com/Bascter-Main/zcode-openai-oauth.git
cd zcode-openai-oauth
patch.bat
```

`patch.bat` requires Node.js 18 or later and automatically installs the small asar packaging dependency on its first run. It then extracts `app.asar`, applies the patch to 12 files using approximately 90 content anchors, checks the syntax of every modified JavaScript file, repackages the application, closes ZCode, deploys the patched files, and restarts ZCode.

After ZCode restarts, open **Settings → Model Providers → OpenAI → Connect** and complete authorization in the browser. The model picker will then show an OpenAI submenu. Its GPT model list is fetched **dynamically** from the Codex model catalog.

Additional commands:

```bat
node patch.js --dry-run      :: Verify compatibility without writing files
node patch.js --restore      :: Restore the pristine files from backup
node patch.js --dir <path>   :: Use a custom ZCode installation directory
```

**After a ZCode upgrade:** the official updater will overwrite the patch. Run `patch.bat` again after the upgrade. The patch uses unique content anchors instead of bundle filename hashes or byte offsets. If ZCode changes the relevant implementation, the patcher reports the anchors that no longer match and aborts without deploying a partially patched package.

## How It Works

| Layer | Implementation |
|---|---|
| OAuth | Uses the public Codex CLI client (`app_EMoamEEZ73f0CkXaXp7hrann`) with PKCE S256. A local loopback server at `127.0.0.1:1455` receives the callback and completes the token exchange in the host process. Tokens refresh automatically 60 seconds before expiration. |
| Model catalog | Calls `GET chatgpt.com/backend-api/codex/models` with the bearer token, `OpenAI-Beta: responses=experimental`, and `chatgpt-account-id`. The catalog refreshes during preset synchronization and falls back to a static list when offline. |
| Requests | Uses the Responses API with the required `store:false` setting and sends only the supported `model`, `instructions`, `input`, `tools`, `store`, and `reasoning` fields. |
| UI | Adds a dedicated OpenAI provider group, the official OpenAI logo, and connect/disconnect controls. |

## Files

- `patch.js` — extracts, patches, validates, repackages, deploys, and restarts ZCode
- `patch-spec.json` — content-anchor patches for 12 bundles inside `app.asar`
- `glm-spec.json` — seven patches for the agent runtime at `resources/glm/zcode.cjs`
- `package.json` / `package-lock.json` — locks the asar dependency version used by the patcher
- `patch.bat` — Windows double-click entry point; installs dependencies automatically on first run

## License

This project is licensed under the [MIT License](LICENSE).

## Disclaimer

This project is intended for learning and research. It uses the public Codex CLI OAuth client and observed API behavior. Follow the OpenAI and ZCode terms of service. You are responsible for any account-related consequences of using this patch.

# ZCode OpenAI OAuth Patcher

**中文** | [English](README_EN.md)

给 [ZCode](https://zcode.z.ai) 桌面版（Windows）内置一个 **OpenAI 模型供应商**：用 ChatGPT 订阅（Plus/Pro）OAuth 登录，直接在聊天里使用 GPT 系列模型，与原有 Z.ai / BigModel 账号互不干扰。

支持版本：ZCode 3.10.x（其他版本请先 `--dry-run` 验证锚点）。

## 一键使用

```bat
git clone https://github.com/Bascter-Main/zcode-openai-oauth.git
cd zcode-openai-oauth
patch.bat
```

`patch.bat` 需要系统装有 Node.js ≥ 18；首次运行会自动安装小型 asar 打包依赖。随后一条命令完成：解包 `app.asar` → 打补丁（12 个文件、约 90 处锚点）→ 逐文件语法校验 → 重新打包 → 关闭 ZCode → 部署 → 重启。

然后打开 ZCode → 设置 → 模型供应商 → OpenAI → 连接，浏览器完成授权即可。模型选择器里会出现 OpenAI 分组（gpt-5.6 系列 / gpt-5.5 / gpt-5.4 等，列表从 Codex 目录接口**动态获取**）。

其他命令：

```bat
node patch.js --dry-run    :: 只验证当前版本能否打上（不写任何文件）
node patch.js --restore    :: 还原官方原版（从备份恢复）
node patch.js --dir <路径> :: 指定自定义安装目录
```

**ZCode 升级后**：官方升级会覆盖补丁。升级完成后重新跑一次 `patch.bat` 即可。补丁全部基于**内容锚点**（不依赖文件名哈希和字节偏移），只要 ZCode 没有重构相关代码就能直接打上；若某处官方实现变了，补丁器会明确报出哪些锚点失效且不会写出坏包。

## 实现原理

| 层 | 内容 |
|---|---|
| OAuth | Codex CLI 公开客户端（`app_EMoamEEZ73f0CkXaXp7hrann`），PKCE S256，本地回环 `127.0.0.1:1455` 接收回调并在 host 进程内完成 token 交换；token 自动刷新（提前 60s） |
| 模型目录 | `GET chatgpt.com/backend-api/codex/models`（Bearer + `OpenAI-Beta: responses=experimental` + `chatgpt-account-id`），每次预置同步时动态刷新，离线时回退到内置静态列表 |
| 请求 | Responses API，`store:false`（订阅后端强制），字段白名单（只发 `model/instructions/input/tools/store/reasoning`） |
| UI | 独立的 OpenAI 分组、官方 OpenAI logo、连接/断开卡片 |

## 文件说明

- `patch.js` — 补丁器（解包/打补丁/校验/打包/部署/重启）
- `patch-spec.json` — asar 内 12 个 bundle 的锚点补丁（自动从官方原版 diff 生成，已剔除全部调试代码）
- `glm-spec.json` — agent 运行时 `resources/glm/zcode.cjs` 的 7 处补丁
- `package.json` / `package-lock.json` — 锁定补丁器使用的 asar 依赖版本
- `patch.bat` — Windows 双击入口（首次运行自动安装依赖）

## 许可证

本项目采用 [MIT 许可证](LICENSE)。

## 免责

仅供学习研究。补丁基于 Codex CLI 的公开 OAuth 客户端与接口行为，请遵守 OpenAI 与 ZCode 各自的服务条款。使用本补丁造成的账号风险自负。

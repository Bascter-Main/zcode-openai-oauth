# ZCode OpenAI OAuth Patcher

**中文** | [English](README_EN.md)

给 [ZCode](https://zcode.z.ai) 桌面版（Windows）内置一个 **OpenAI 模型供应商**：用 ChatGPT 订阅（Plus/Pro）OAuth 登录，直接在聊天里使用 GPT 系列模型，与原有 Z.ai / BigModel 账号互不干扰。

已验证版本：ZCode **3.10.2、3.11.2**（稳定补丁基线：`v1.0.0`）。补丁器按精确版本选择兼容性 profile；未知版本不会在部署模式下静默尝试。

## 一键使用

```bat
git clone https://github.com/Bascter-Main/zcode-openai-oauth.git
cd zcode-openai-oauth
patch.bat
```

`patch.bat` 需要系统装有 Node.js ≥ 18；首次运行会按锁文件安装小型 asar 打包依赖。随后一条命令完成：解包 `app.asar` → 按唯一内容锚点打补丁 → 逐文件语法校验 → 重新打包 → 关闭 ZCode → 事务部署 → 重启。

然后打开 ZCode → 设置 → 模型供应商 → OpenAI → 连接，浏览器完成授权即可。模型选择器里会出现 OpenAI 分组（gpt-5.6 系列 / gpt-5.5 / gpt-5.4 等，列表从 Codex 目录接口**动态获取**）。

其他命令：

```bat
node patch.js --probe      :: 只读检查当前版本与已有 profile 的兼容性（不写安装目录、不重启 ZCode）
node patch.js --dry-run    :: 对精确支持的版本完成完整补丁与隔离重新打包（不写安装目录）
node patch.js --restore    :: 还原官方原版（从 hash 校验过的同版本备份恢复）
node patch.js --dir <路径> :: 指定自定义安装目录
```

**ZCode 升级后**：官方升级会覆盖补丁。升级完成后重新运行 `patch.bat`。补丁基于**内容锚点**和精确版本 profile（不依赖固定字节偏移），每个锚点必须唯一匹配；若官方实现变了，补丁器会明确报出哪些 target/anchor 失效且不会写出坏包。

### 版本兼容政策

- **已验证版本**：profile 精确匹配版本号，并且所有锚点、语法检查、postcondition、关键数据流不变量和隔离重新打包全部通过，才允许部署。
- **结构候选**：新版本可以用 `--probe` 查看哪些 semantic transform 仍能定位、哪些 exact anchor 已失效；报告只用于迁移分析，不产生可部署 profile。
- **未知版本**：部署与恢复模式直接失败并说明没有 verified profile，不猜测压缩变量、不做模糊替换。
- **新增 profile**：只有取得对应 pristine `app.asar` 与 `resources/glm/zcode.cjs`，重新核对大块 host/renderer 注入的实际变量绑定并完成同等测试后，才加入 `profiles/index.json`。不使用 `3.10.x` 通配符。

## 运行时补丁模式（实验）

默认流程在部署时把补丁写进 `app.asar`。运行时模式不改写 bundle：解包后在**加载时**按同一份 profile 变换代码——main/host/scheduler 经模块加载钩子，renderer 经协议层改写。每个点位独立失败降级：某个锚点在新版本失效时，对应功能缺席，但应用照常运行，不会产出坏包。preload 与 agent 运行时无法被加载时拦截，仍在安装时扁平修补（带 `.rt-pristine` 备份）。

```bat
:: 安装（需先关闭 ZCode；若此前使用过静态补丁，先 node patch.js --restore）
node runtime/install-runtime.js --dir "D:\Program Files\ZCode"

:: 启动一次 ZCode 后，校验运行时投递与静态严格变换逐字节一致
node runtime/verify-runtime.js --dir "D:\Program Files\ZCode"

:: 卸载（需先关闭 ZCode）
node runtime/install-runtime.js --dir "D:\Program Files\ZCode" --restore
```

投递明细记录在 `resources/app/out/.zcode-runtime/runtime.log`（每个目标的锚点命中数、postcondition 与关键不变量校验结果、投递内容哈希）。

## 修改点位框架

补丁不只是“文本替换”。每个可迁移的修改点都在 `transforms/registry.json` 中声明为**语义 transform**：

| transform | 作用 | 覆盖 |
|---|---|---|
| `schema.oauth-method-enum` / `oauth-provider-enum` / `oauth-connection-secrets` | 在 OAuth schema 中注册 openai | GLM、protocol、scheduler、preload×5、renderer |
| `registry.provider-id-map` | 注册 `builtin:openai*` 三个 provider ID | 7 个 bundle |
| `registry.builtin-provider-predicate` | 让 workspace catalog 包含 OpenAI provider | GLM、protocol、renderer |
| `registry.start-plan-predicate` / `coding-plan-predicate` | OpenAI start/coding plan 判定 | renderer、protocol |
| `registry.provider-family-descriptor` | 注册 OpenAI provider family | GLM、renderer、scheduler、preload×5 |
| `glm.reasoning-levels-parser` | reasoning levels 同时兼容 array/object | GLM |

定位策略是三级递进的：

1. **语义定位**：locate pattern 用通配捕获 minified 变量名（如 `zapi:\`${X}zapi\`` 自动适配 `M2`/`Te`/`We` 等任意命名），在整个 bundle 中要求恰好一个匹配；
2. **exact anchor 兜底**：已验证版本上语义定位失败时，回退到该版本的完整内容锚点；
3. **fail-closed**：两者都失败时中止，不写任何文件。

已验证版本上强制**逐字节等价**：语义 transform 的输出必须与 anchor 输出完全一致，否则直接拒绝（防止 transform 定义漂移）。`--probe` 会按 transform ID 报告每个点位的定位结果（`semantic` / `anchor-fallback` / `failed`），升级后一眼就能看出是哪个语义点位变了。其余大块注入（host 目录同步、renderer JSX 等）保留精确锚点，但都有唯一 target/span 诊断。

补丁器还会在最终 bundle 上检查两条跨 span 数据流不变量：OpenAI preset 必须加入 `loadPresetProviders` 实际捕获的 provider 数组；设置页的普通/OpenAI 分组必须过滤由 `presetProviders.map(...)` 生成的带标签显示数组。检查动态捕获变量绑定而不是依赖 `n`、`pe` 等压缩名，因此压缩名即使在新版中变化或复用，也会在部署前 fail closed。

## 实现原理

| 层 | 内容 |
|---|---|
| OAuth | Codex CLI 公开客户端（`app_EMoamEEZ73f0CkXaXp7hrann`），PKCE S256，本地回环 `127.0.0.1:1455` 接收回调并在 host 进程内完成 token 交换；token 自动刷新（提前 60s） |
| 模型目录 | `GET chatgpt.com/backend-api/codex/models`（Bearer + `OpenAI-Beta: responses=experimental` + `chatgpt-account-id`），每次预置同步时动态刷新，离线时回退到内置静态列表 |
| 请求 | Responses API，`store:false`（订阅后端强制）、`stream:true`，字段白名单（只发 `model/instructions/input/tools/store/stream/include/reasoning`） |
| 兼容附加项 | OpenAI-compatible chat-completions 端点使用 `reasoning_effort`，不发送不受支持的 `thinking` 字段；Anthropic reasoning 配置保持不变 |
| UI | 独立的 OpenAI 分组、官方 OpenAI logo、连接/断开卡片 |

## 文件说明

- `patch.js` — 版本无关补丁引擎（profile 选择/解包/打补丁/校验/打包/探测/部署/重启）
- `patch-core.cjs` — 静态补丁器与运行时共享的纯文本补丁核心（内容锚点/语义 transform/关键数据流不变量）
- `runtime/` — 运行时补丁模式：加载时变换（bootstrap、loader hooks、协议层改写）与安装/校验脚本
- `profiles/index.json` — 精确 ZCode 版本到 profile 的映射
- `profiles/<版本>/profile.json` — target、marker、postcondition 和 spec 校验配置
- `profiles/<版本>/patch-spec.json` — asar 内各目标 bundle 的内容锚点补丁
- `profiles/<版本>/glm-spec.json` — agent 运行时 `resources/glm/zcode.cjs` 的内容锚点补丁
- `transforms/registry.json` — 语义 transform 定义（跨版本可复用的点位定位与插入模板）
- `package.json` / `package-lock.json` — 锁定补丁器使用的 asar 依赖版本
- `patch.bat` — Windows 双击入口（首次运行自动安装依赖）

## 许可证

本项目采用 [MIT 许可证](LICENSE)。

## 免责

仅供学习研究。补丁基于 Codex CLI 的公开 OAuth 客户端与接口行为，请遵守 OpenAI 与 ZCode 各自的服务条款。使用本补丁造成的账号风险自负。

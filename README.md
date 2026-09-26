# ZCode OpenAI OAuth Patcher

**中文** | [English](README_EN.md)

给 [ZCode](https://zcode.z.ai) 桌面版（Windows）内置一个 **OpenAI 模型供应商**：通过 ChatGPT 订阅 OAuth 登录，直接在聊天里使用账号当前获准使用的 GPT 系列模型，并保持原有 Z.ai / BigModel 应用账号身份不变。

已验证版本：ZCode **3.10.2、3.11.2、3.14.3**。补丁器按精确版本选择兼容性 profile；未知版本不会在部署模式下静默尝试。

## 一键使用

```bat
git clone https://github.com/Bascter-Main/zcode-openai-oauth.git
cd zcode-openai-oauth
patch.bat
```

`patch.bat` 需要系统装有 Node.js ≥ 18；首次运行会按锁文件安装小型 asar 打包依赖。随后一条命令完成：解包 `app.asar` → 按唯一内容锚点打补丁 → 逐文件语法校验 → 重新打包 → 关闭 ZCode → 事务部署 → 重启。

然后打开 ZCode → 设置 → 模型供应商 → OpenAI → 连接，浏览器完成授权即可。OpenAI 在设置和模型选择器中均为独立分组；模型列表从 Codex 目录接口**动态获取**，会按当前账号的订阅与工作区权限显示可用模型（包括已获准使用的 GPT-6 Sol / Astra / Luna）。

其他命令：

```bat
node patch.js --probe      :: 只读检查当前版本与已有 profile 的兼容性（不写安装目录、不重启 ZCode）
node patch.js --dry-run    :: 对精确支持的版本完成完整补丁与隔离重新打包（不写安装目录）
node patch.js --no-deploy  :: 生成校验过的 .patched 文件，但不部署
node patch.js --self-test  :: 运行补丁器自带的 fixture 与行为校验
node patch.js --restore    :: 从 hash 校验过的同版本备份恢复官方原版
node patch.js --dir <路径> :: 指定自定义安装目录
```

**ZCode 升级后**：官方升级会覆盖补丁。升级完成后重新运行 `patch.bat`。补丁基于**内容锚点**和精确版本 profile（不依赖固定字节偏移），每个锚点必须唯一匹配；若官方实现变了，补丁器会明确报出哪些 target/anchor 失效且不会写出坏包。

### 当前功能

- OpenAI 在设置页中位于“智谱”和“自定义供应商”之间，是独立的一级分组，不会改变 ZCode 左下角的 Z.ai / BigModel 登录身份。
- OpenAI 详情页提供 OAuth 连接状态及“连接 OpenAI”/“断开连接”；断开后导航项仍保留，可随时重新连接。
- 受管的供应商名称、Base URL、API 格式与 OAuth 凭据不显示为可编辑字段；供应商启用开关和模型管理仍保留。
- 支持添加、编辑、启停、删除和排序模型。在线刷新不会覆盖用户手动添加的模型、显式手动规则、上下文窗口覆盖或其他供应商配置。
- 首次连接、应用启动、token 刷新以及模型供应商页面的手动刷新都会同步 Codex 在线目录。服务端新增或撤回的受管模型会随账号 entitlement 更新。
- Codex 客户端版本从公开的 `@openai/codex` 稳定版元数据获取并缓存；离线时使用最近成功版本或已验证兼容基线，避免因过期目录版本遗漏新模型。

### 版本兼容政策

- **已验证版本**：profile 精确匹配版本号，并且所有锚点、语法检查、postcondition、关键数据流不变量和隔离重新打包全部通过，才允许部署。
- **结构候选**：新版本可以用 `--probe` 查看哪些 semantic transform 仍能定位、哪些 exact anchor 已失效；报告只用于迁移分析，不产生可部署 profile。
- **未知版本**：部署与恢复模式直接失败并说明没有 verified profile，不猜测压缩变量、不做模糊替换。
- **新增 profile**：只有取得对应 pristine `app.asar` 与 `resources/glm/zcode.cjs`，重新核对大块 host/renderer 注入的实际变量绑定并完成同等测试后，才加入 `profiles/index.json`。不使用 `3.10.x` 通配符。

## 运行时补丁模式（实验）

默认流程在部署时把补丁写进 `app.asar`。运行时模式不改写原始 bundle：解包后在**加载时**按同一份 profile 变换代码——main/host/scheduler 经模块加载钩子，renderer 经协议层改写。加载时目标可按点位独立降级并记录失败；preload 与 agent 运行时无法被加载时拦截，仍在安装时以严格模式扁平修补（带 `.rt-pristine` 备份），任一严格校验失败都会拒绝安装。

```bat
:: 安装（必须先从托盘完全退出 ZCode；若仍有目标进程，安装器会拒绝写入）
:: 若此前使用过静态补丁，先 node patch.js --restore
node runtime/install-runtime.js --dir "D:\Program Files\ZCode"

:: 安装后重新启动 ZCode，等待主窗口加载完成，再校验当前安装 generation 的投递
:: 不重启就验证会明确提示重启，不会拿旧进程日志误报哈希不匹配
node runtime/verify-runtime.js --dir "D:\Program Files\ZCode"

:: 卸载（需先关闭 ZCode）
node runtime/install-runtime.js --dir "D:\Program Files\ZCode" --restore
```

投递明细记录在 `resources/app/out/.zcode-runtime/runtime.log`（每个目标的锚点命中数、postcondition 与关键不变量校验结果、投递内容哈希）。

## 修改点位框架

补丁不只是“文本替换”，而是按版本 profile 选择严格的定位机制：

| 机制 | 适用范围 | 行为 |
|---|---|---|
| 语义 transform + exact anchor | 3.10.2、3.11.2 | `transforms/registry.json` 捕获压缩变量绑定；语义输出必须与已验证 anchor 逐字节一致，否则拒绝部署 |
| 语义 resolver | 3.14.3 | `patch-core.cjs` 根据函数名保留标记、结构与字符串定位 host/renderer 逻辑；每个 resolver 必须唯一匹配，否则 fail closed |
| 严格 postcondition 与关键不变量 | 所有 profile | 对最终 bundle 检查 OAuth 注册、账号隔离、目录同步、连接/断开、设置分组、模型菜单和请求兼容性等关键行为 |

`--probe` 会对当前安装执行同一套只读定位、语法、postcondition 和关键不变量检查，不生成可部署输出。旧版 transform profile 支持语义定位失败后的 exact-anchor 回退；resolver-only profile 则要求结构唯一命中。任何必要点位无法验证时，补丁器都会中止且不写安装文件。

## 实现原理

| 层 | 内容 |
|---|---|
| OAuth | Codex CLI 公开客户端（`app_EMoamEEZ73f0CkXaXp7hrann`），PKCE S256，本地回环 `127.0.0.1:1455` 接收回调并在 host 进程内完成 token 交换；token 自动刷新 |
| 模型目录 | `GET chatgpt.com/backend-api/codex/models`（Bearer + `OpenAI-Beta: responses=experimental` + `chatgpt-account-id`）；首次连接、启动、token 刷新和手动刷新时同步；客户端目录版本动态发现并缓存，失败时保留现有配置 |
| 模型合并 | 在线目录管理的模型随服务端与账号 entitlement 增删；用户手动模型、显式规则、上下文覆盖、排序和其他供应商规则保持不变 |
| 请求 | Responses API，`store:false`（订阅后端强制）、`stream:true`，过滤订阅后端不支持的参数与 reasoning 档位 |
| 兼容附加项 | OpenAI-compatible chat-completions 端点使用 `reasoning_effort`，不发送不受支持的 `thinking` 字段；Anthropic reasoning 配置保持不变 |
| UI | 独立的 OpenAI 设置/模型分组、官方 OpenAI logo、连接/断开卡片；隐藏受管连接字段并保留模型编辑能力 |

## 文件说明

- `patch.js` — 版本无关补丁引擎（profile 选择/解包/打补丁/校验/打包/探测/部署/重启）
- `patch-core.cjs` — 静态补丁器与运行时共享的补丁核心（语义 transform、resolver、内容锚点与关键不变量）
- `runtime/` — 运行时补丁模式：加载时变换（bootstrap、loader hooks、协议层改写）与安装/校验脚本
- `profiles/index.json` — 精确 ZCode 版本到 profile 的映射
- `profiles/<版本>/profile.json` — target、marker、postcondition 和 spec 校验配置
- `profiles/<版本>/patch-spec.json` — asar 内各目标 bundle 的 resolver 或内容锚点补丁
- `profiles/<版本>/glm-spec.json` — agent 运行时 `resources/glm/zcode.cjs` 的 resolver 或内容锚点补丁
- `transforms/registry.json` — 语义 transform 定义（跨版本可复用的点位定位与插入模板）
- `package.json` / `package-lock.json` — 锁定补丁器使用的 asar 依赖版本
- `patch.bat` — Windows 双击入口（首次运行自动安装依赖）

## 许可证

本项目采用 [MIT 许可证](LICENSE)。

## 免责

仅供学习研究。补丁基于 Codex CLI 的公开 OAuth 客户端与接口行为，请遵守 OpenAI 与 ZCode 各自的服务条款。使用本补丁造成的账号风险自负。

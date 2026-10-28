# 心语（HeartEcho）· 项目总览、架构与运行原理

> **给接手 AI 的上手手册**
> 版本：v1.0 ｜ 编制日期：2026-10-28 ｜ 代码基线：本地 HEAD `ff20321`（含扩展系统与 PR #16；相对 origin/main 领先 4 个提交，未推送）
> 配套文档：
> - 本轮新需求的**最终实施范围与决策**：[实施任务书 v1.1](实施任务书-v1.1-已确认.md)（**以此为准**）
> - 调查报告与方案比较（v1.0）：[需求任务书-安装器与启动修复](需求任务书-安装器与启动修复.md)
>
> 阅读建议：先读第 1、2、3、8 节建立整体印象，再按第 20 节顺序深入各模块。

---

## 1. 一分钟了解项目

**心语（HeartEcho）** 是一个 Windows 上的自托管 QQ 人格化数字伴侣：用户用自己的 QQ 号作机器人，跑在自家电脑上，接大模型（DeepSeek/OpenAI/Kimi/GLM 等 OpenAI 兼容接口），带长期记忆、数字生命、主动消息、QQ 空间、插件/技能扩展，以及一个完全本地化的控制面板。

| 维度 | 事实 |
| --- | --- |
| 运行时 | **Node.js 24**（`engines` 写 ≥22.5；`node:sqlite` 需要较新版本，FTS5 需要编译支持） |
| 第三方运行时依赖 | **零**。只用 Node 内置模块；开发依赖仅 eslint/prettier/esbuild/postject |
| 平台 | Windows 10/11 x64（托盘、自启动、Edge app 模式窗口、`node:sqlite`、PowerShell 托盘脚本都是 Windows 取向；核心逻辑可移植） |
| 语言/模块 | ESM（`.mjs`/扩展 `.js`，根 `package.json` `"type": "module"`） |
| 数据库 | `node:sqlite`（`DatabaseSync`），WAL + FTS5，`main.db` |
| 协议 | OneBot 11（WS 主通道 + HTTP），通过本机 **SnowLuma**（注入 QQ 客户端 hook）把 QQ 变成接口 |
| 控制面板 | 单端口本地 HTTP（默认 `127.0.0.1:5311`），前端是**单文件字符串模板**（无框架、无构建步骤） |
| 分发形态 | 现在：源码运行 / SEA 单文件 `心语.exe` / TB 便携包；**计划 v1.3.0：两个一键安装包（泛用版 + 领航员终端）**，内置 SnowLuma 与 Node 运行时 |
| 许可证 | AGPL-3.0-only（心语本体）；扩展与 SnowLuma 有各自许可，详见 `EXTENSIONS.md` §6、`NOTICE` |

**它不是什么**：不是云服务、不是无头爬虫、不自动登录 QQ、不内置 API Key、不内置协议端登录态、不做多用户 SaaS。所有数据落在本机。

---

## 2. 快速开始（开发与验证）

> ⚠️ 本机可能正在运行一份**真实实例**（用户日常使用），数据在 `dist\data` 或 `%LOCALAPPDATA%\心语`。**不要**用默认数据目录跑测试/实验，也不要在未确认时重启/退出用户实例。

### 2.1 环境

```powershell
node -v            # 需要 Node 24（v24.x；至少 22.5，推荐 24）
npm -v
# 已安装依赖（node_modules 存在；esbuild/postject 也在里面，虽然未写进 package.json devDeps）
```

### 2.2 离线测试（不花钱、不连 QQ）

```powershell
node tools/smoke.mjs              # 模块冒烟 + 前端脚本语法
node tools/selftest.mjs           # 离线自检，当前 98/98（临时数据目录，不碰真实数据）
node tools/extensions-test.mjs    # 16 个扩展包单测，当前 91/91
node --test tools/security-test.mjs   # 当前 22/22
node --test tools/tooling-test.mjs    # 当前 6/6
node --test tools/next-version-test.mjs  # 当前 31/31
node tools/conversation-flow-test.mjs    # 当前 15/15
node tools/check-identifiers.mjs        # 554 个导入名全部存在
node tools/check-ui-template.mjs        # 前端模板结构检查（0 可疑行）
node tools/backup-verify.mjs            # 备份/恢复演练
```

### 2.3 起一个隔离的开发实例（推荐）

```powershell
$env:HEARTECHO_DATA_DIR = "$env:TEMP\heartecho-dev"
$env:HEARTECHO_LOG_DIR  = "$env:TEMP\heartecho-dev\logs"
node index.mjs --no-panel --no-tray
# 控制面板 http://127.0.0.1:5311/ ，token 在 %TEMP%\heartecho-dev\panel-token
# 访问面板时要带 #panelToken=<token>（见 §13 授权）
```

其他常用参数：

```powershell
node index.mjs --probe              # 自检配置/角色/模型/QQ 后退出
node index.mjs --selftest           # 打包/源码都可用
node index.mjs --desktop-check      # 托盘/图标/权限自检
node index.mjs --no-panel --no-tray # 纯后台
node index.mjs --instance <目录>    # 跑某个多实例目录
```

### 2.4 打包（现状，SEA）

```powershell
node tools/build-exe.mjs            # → dist\心语.exe（约 91 MB）
node tools/package-tb.mjs           # → dist\HeartEcho-TB\（TB 便携包，含 node.exe）
```

> 打包需要 esbuild + postject（已在 `node_modules`，但 `package.json` devDependencies 未列，属于已知待修项）。打包前会自动跑 `tools/gen-extensions.mjs` 生成扩展注册表。

### 2.5 不要随便跑的测试

- `node tools/e2e-live.mjs`：会真的发 QQ 消息、花模型钱，需要用户三个真实 QQ 号/令牌；
- `tools/qzone-verify.mjs --write` / `qzone-interact-verify.mjs` / `qzone-image-verify.mjs`：会真实发空间、点赞、评论；
- `node tools/build-exe.mjs`：会覆盖 `dist\心语.exe`，如果正在运行会因文件占用失败（先退出程序，或问用户）；
- 任何会重启/退出正在服务的实例的操作。

### 2.6 代码检查现状（重要基线）

- `npm run lint`（`eslint . --max-warnings=0`）当前**不绿**：**78 个既有 error**（多为未使用变量/旧写法）。
- `npx prettier --check .` 当前**不绿**：**114 个文件**存在格式差异（项目刻意没有一次性格式化旧代码）。
- **要求**：不要为了“让 lint 变绿”去全局重构/格式化；只保证自己改的地方不新增问题。改动集中在业务逻辑时按现有风格写即可。`lib/ui-app.mjs` 的 `APP_JS` 由自定义处理器检查，`npm run format` / `format:check` 会特殊处理嵌在模板里的前端代码。

---

## 3. 总体架构

```
┌──────────────────────────── Windows 本机 ────────────────────────────┐
│                                                                      │
│  QQ 客户端（QQNT，用户登录机器人号）                                  │
│        │ SnowLuma 注入 hook（native .node/.dll）                     │
│        ▼                                                             │
│  协议端 SnowLuma（独立进程，Node 运行；OneBot 11 WS/HTTP）             │
│        │ ws://127.0.0.1:3101/（TB: 3103）                            │
│        ▼                                                             │
│  心语 Node 进程（index.mjs）                                          │
│   ├─ lib/onebot.mjs        OneBot 客户端 / 事件标准化 / 重连           │
│   ├─ lib/chat.mjs          会话编排（合并、生成、发送）                │
│   ├─ lib/policy.mjs        准入、限流、黑名单、暂停                    │
│   ├─ lib/budget.mjs        预算预留/对账                              │
│   ├─ lib/llm.mjs           模型网关、分层提示词、工具调用循环          │
│   ├─ lib/memory.mjs        分层记忆与检索                             │
│   ├─ lib/life.mjs          数字生命/关系/经历/反思/日记               │
│   ├─ lib/extensions.mjs    扩展宿主（插件/技能）                       │
│   ├─ lib/scheduler.mjs     主动消息/提醒/节日生日                      │
│   ├─ lib/weather.mjs       天气与主动提醒                              │
│   ├─ lib/qzone.mjs         QQ 空间（能力门控）                         │
│   ├─ lib/tb.mjs            TB 专属（群规/搜索/角色）                   │
│   ├─ lib/api.mjs           本地 HTTP API + 面板服务                    │
│   ├─ lib/desktop.mjs       托盘/Edge app 窗口/开机自启/重启             │
│   ├─ lib/protocol.mjs      协议端诊断/启动/重启                        │
│   └─ lib/storage.mjs       SQLite 读写（会话/消息/群成员/策略）         │
│        │                                                             │
│        ├─ 数据：%LOCALAPPDATA%\心语 或 <程序目录>\data（见 §6）        │
│        └─ 控制面板：http://127.0.0.1:5311（本地、token 授权）          │
│                                                                      │
│  打包/工具链：tools/*（selftest、打包、页面检查、e2e…）                │
└──────────────────────────────────────────────────────────────────────┘
```

**四条主要数据通路：**

1. **入站聊天**：QQ 消息 → SnowLuma → OneBot WS → `ChatEngine.receive()` → 合并/去抖 → `handle()` → 规则/预算/记忆/提示词 → 模型 → 拆气泡 → OneBot 发送 → 落库/审计。
2. **主动行为**：`Scheduler` / `QZoneScheduler` / 天气定时器 → 构造上下文 → 模型（或固定文案）→ 发送（同样过策略与预算）。
3. **面板请求**：浏览器窗口 → `http://127.0.0.1:5311/api/*` → `api.mjs` 路由 → 各服务 → JSON；面板前端（`ui-app.mjs`）渲染。
4. **扩展工具调用**：模型返回 `tool_calls` → `llm.speakWithTools()` 循环 → `ExtensionHost.runTool()` → 扩展 `execute(ctx,args)` → 结果回填 → 继续模型。核心 `finish` 工具用于收尾。

---

## 4. 启动顺序（`index.mjs`）

`index.mjs` 是唯一入口；理解启动顺序能避免“为什么面板没起来/为什么没连 QQ”类问题。

1. **第一个 import**：`lib/boot-env.mjs`
   - 只解析 `--instance <目录>` 和 `--tb`，设置 `HEARTECHO_APP_DIR` / `HEARTECHO_DATA_DIR` / `HEARTECHO_LOG_DIR` / `HEARTECHO_SETTINGS` / `HEARTECHO_EDITION`；
   - **必须在任何业务模块之前**，因为 `paths.mjs` 在模块加载时就把目录算死了。
2. 加载 `paths/config/log/db/...`，`ensureDirs()`，`ensureConfigFile()`。
3. `--tb` 且未初始化：写入 TB 角色卡 + 面板 5321 + OneBot 3103/3102（`index.mjs:191-196`）。
4. `ensureLocalToken()`（生成协议端访问令牌）、`pruneLogs(14)`、打开数据库、`migrate()`（结构版本 3，迁移前自动备份）、修正历史记忆归属。
5. 构造服务对象：`LlmGateway`、`OneBot`、`Scheduler`、`ChatEngine`、`QZoneAdapter/QZoneScheduler`、`TbGroupService`、`InteractionService`、`ExtensionHost`。
6. 特殊模式提前返回：`--probe`、自检（`--selftest`，会切到临时数据目录递归跑）、`--test-image`、`--archive-now/--diary-now/--greet-now`、自启动/桌面自检。
7. 常驻模式：
   - **单实例锁**（按数据目录哈希，见 `index.mjs:101-145`）；若另一个实例真在跑，就打开它的面板而不是报错；
   - **账号占位**：同一 QQ 号只能一个实例；`claimAccount` 在 selfId 非法时返回错误，当前代码直接 `exit 1`（**已知 P0 bug，见 §18**）；
   - **开机自启**：仅 SEA 打包版首次运行时自动登记（源码模式不动系统启动项）；
   - `extensions.init({setup:true, activate:true})`：装载扩展（失败只影响扩展本身）；
   - 起 HTTP 面板服务（失败不阻塞机器人）；
   - `ensureProtocol()`：按需启动协议端（SnowLuma/NapCat）；
   - `client.start()` / `scheduler.start()` / `qzoneScheduler.start()`；
   - 预热天气；启动归档/日记/扩展定时器；
   - 桌面壳：`--tray` 或 SEA 打包版 → 起 PowerShell 托盘 + Edge app 窗口（`--no-panel`/`--no-tray` 可关）。
8. 退出（`shutdown`）：停 Chat/TB/Scheduler/QZone/扩展、关面板、停 OneBot；彻底退出时按需停协议端；退出备份；释放锁与账号占位。**重启**通过退出码 42 / `relaunchSelf()` 由外壳拉起，`--takeover` 让新实例等锁和端口。

> 安装版（v1.3.0，方案 A2）将把“是否打包 exe（`isSea`）”的判断改为“是否安装模式（launcher 注入环境变量）”，启动顺序本身不变；详见 v1.1 任务书。

---

## 5. 目录与文件地图

### 5.1 仓库（源码）

```
E:\心语\
├── index.mjs                 主入口（启动/常驻/自检/桌面壳）
├── 启动心语.bat / 启动TB.bat  源码启动器（GBK+CRLF；注意启动参数问题）
├── package.json / package-lock.json
├── README.md                 使用说明（部分内容已过时，见 v1.0 任务书 §2.6）
├── EXTENSIONS.md             扩展系统与 16 个包的说明、许可提醒
├── CONTRIBUTING.md           开发检查/格式化约定
├── SECURITY-BOUNDARIES.md    面板、私人档案、清空契约的升级说明
├── NOTICE / LICENSE          AGPL-3.0
├── lib\                      全部后端模块（见 5.2）
├── extensions\               16 个插件/技能包 + 兼容层 src\
├── tools\                    自检/测试/打包/诊断工具（见 §16）
├── examples\                 示例角色卡等
├── docs\                     本地文档（gitignore；含本轮任务书）
├── data\                     源码模式默认数据目录（gitignore）
├── dist\                     打包产物 + 便携版数据 + instances（gitignore）
├── protocol\                 用户自备 SnowLuma/NapCat（gitignore，含登录态）
├── build\                    打包中间产物（gitignore）
└── node_modules\             开发依赖（gitignore）
```

### 5.2 `lib/` 模块地图（按重要性/依赖顺序）

| 模块 | 职责 | 关键点 |
| --- | --- | --- |
| `boot-env.mjs` | 最先执行的 env 解析 | `--instance`/`--tb` |
| `paths.mjs` | 目录/设置解析（env > `心语设置.json` > 默认） | 源码 `data\`；打包 exe 默认 `%LOCALAPPDATA%\心语`；协议端目录 |
| `config.mjs` | 默认配置、normalize、角色卡、activeCharacter、回复风格 | 角色 id 校验（当前有大小写覆盖 bug） |
| `credentials.mjs` | API Key 合并/掩码 | 面板不回传明文 Key |
| `privacy.mjs` | 私人档案注入边界 | 只有明确绑定的私聊可用 |
| `db.mjs` | SQLite 打开、schema/migrate、事务、备份、审计、事件幂等 | SCHEMA_VERSION=3；FTS5 trigram |
| `storage.mjs` | 会话/消息/群成员/成员策略 | 所有查询强制 scopeKey |
| `memory.mjs` | 六类记忆、四类来源、检索评分、冲突取代 | scope 强过滤；敏感内容过滤 |
| `extended-memory.mjs` | 可选 Hindsight 扩展记忆（每日摘要/召回/授权） | 默认关闭；同意指纹 |
| `life.mjs` | 数字生命：状态/关系/经历/反思/目标/日记 | 证据不足不下结论 |
| `scope-lifecycle.mjs` | 作用域代次（清空/换角色/换号后旧任务失效） | 生成前后校验 |
| `policy.mjs` | 规则引擎：暂停、黑名单、屏蔽词、限流、准入、审计 | 黑名单 = 0 出站 + 0 模型调用 |
| `budget.mjs` | 预算闸门：原子预留/对账/预警/熔断 | 全局/私聊/群；按日/月 |
| `llm.mjs` | 模型网关：提示词分层、任务路由、重试、错误自愈、工具调用循环 | 只在这里发模型 HTTP |
| `providers.mjs` | 供应商与模型预设、价格、`MAX_OUTPUT_TOKENS=65536` | 8 家预设 |
| `tools.mjs` | ToolRegistry / OpenAI tool schema / 结果归一化 / 解析 tool_calls | 工具名 sanitize |
| `extensions.mjs` | 扩展宿主：发现/装载/设置/生命周期/钩子/能力/提示词片段/工具/会话记录 | 单扩展失败隔离 |
| `extensions-runtime.mjs` | 扩展运行期服务绑定（settings/dataDir/logger 等） | |
| `stickers.mjs` | 核心表情收藏（收集/列表/路径） | 图片大小/去重/上限 |
| `onebot.mjs` | OneBot WS/HTTP 客户端、事件标准化、发送 API、重连 | 事件按 selfId 过滤 |
| `chat.mjs` | 会话编排：合并、去抖、生成、扩展集成、发送、审计 | 核心流程见 §8 |
| `interactions.mjs` | 戳一戳/输入状态/入群欢迎事件 | 只响应本账号 |
| `recovery.mjs` | 断线期间漏消息补回 | 幂等 |
| `scheduler.mjs` | 主动消息/提醒/节日生日/追话 | job_key 唯一；静默时段 |
| `weather.mjs` | IP/城市定位、Open-Meteo 预报、提醒阈值、用户纠正 | 失败只影响天气 |
| `qzone.mjs` / `qzone-job.mjs` | QQ 空间能力门控/读写/审批/定时 | HTTP 200 ≠ 页面生效 |
| `tb.mjs` | TB 角色、群规、搜索、专属策略 | TB 专属；`--tb` |
| `api.mjs` | 本地 HTTP API + 面板 HTML 服务 + SSE 日志 | 面板授权校验 |
| `panel-auth.mjs` | 面板 token / cookie / Host/Origin/Content-Type 校验 | 本地安全边界 |
| `next-api.mjs` | “记忆与互动”增量 API | Hindsight/额度/TB 搜索 |
| `ui.mjs` / `ui-app.mjs` / `ui-css.mjs` / `ui-icons*.mjs` | 控制面板（HTML/CSS/JS 全内联） | 单文件巨型模板，见 §13 |
| `desktop.mjs` | 托盘（PowerShell WinForms）、Edge app 窗口、自启动、重启自己 | 关窗=缩托盘 |
| `protocol.mjs` | 协议端诊断/启动/重启/停止、多实例共用、日志 | SnowLuma 注入模型的约束 |
| `health.mjs` | 连接体检、协议端账号配置 `onebot_<QQ>.json` | 只读诊断 |
| `instances.mjs` | 多实例：登记表、账号占位、启动、共用协议端、实例面板 URL | 一个 QQ = 一个实例 |
| `hindsight-runtime.mjs` | 本地 Hindsight（Docker）托管启动 | 可选 |
| `log.mjs` | 日志（文件+内存+SSE）、级别、脱敏 | 14 天保留 |
| `util.mjs` | 时间/文本/JSON/哈希/清洗/分气泡/睡眠等 | |
| `files.mjs` | 图片/文件/转文本、大小与类型 | |
| `jobs.mjs` | 面板长任务（归档/日记/反思）状态 | |
| `service-http.mjs` | 外部服务 URL 校验与 JSON 调用（SSRF/HTTPS 约束） | Hindsight/TB 搜索 |

### 5.3 数据目录（运行时数据）

源码模式：`<仓库>\data\`；SEA 打包默认：`%LOCALAPPDATA%\心语\`；TB：`%LOCALAPPDATA%\心语TB\`（`boot-env.mjs`）；可用 `HEARTECHO_DATA_DIR` 或 `心语设置.json` 覆盖。

```
<data>\
├── config.json            面板/程序可改的全部设置（含模型 Key —— 只在本地）
├── characters\<id>.json   角色卡
├── database\main.db       SQLite（消息/记忆/账单/审计/调度…）
├── database\*.db-wal/shm
├── extensions\
│   ├── state.json         每个扩展的开关与设置
│   ├── sessions\<turnId>.json  每轮会话记录（扩展用）
│   ├── stickers.json / sticker-images\
│   └── <扩展id>\          扩展自己的数据
├── logs\heartecho-YYYY-MM-DD.log  运行日志（14 天）
├── logs\protocol.out.log  协议端 spawn 输出
├── logs\tray.log          托盘脚本日志
├── logs\relaunch.log      重启日志
├── backups\               数据库快照（保留最近 10 份）
├── cache\  media\  exports\  state\
└── panel-token            面板访问令牌（64 hex，勿外传）
```

---

## 6. 配置与路径

### 6.1 路径优先级（`lib/paths.mjs`）

```
APP_DIR：HEARTECHO_APP_DIR > （打包 exe 的所在目录）> 源码仓库根
SETTINGS：HEARTECHO_SETTINGS > <APP_DIR>\心语设置.json
DATA_DIR：HEARTECHO_DATA_DIR > settings.dataDir > 默认
          默认：源码模式 <APP_DIR>\data；打包模式 %LOCALAPPDATA%\心语
LOG_DIR：HEARTECHO_LOG_DIR > settings.logDir > <DATA_DIR>\logs
SNOWLUMA_DIR：HEARTECHO_SNOWLUMA_DIR > settings.snowlumaDir > <APP_DIR>\protocol
```

`心语设置.json` 字段（`DEFAULT_SETTINGS`）：

| 字段 | 作用 |
| --- | --- |
| `dataDir` / `logDir` | 数据/日志目录（留空用默认；相对路径相对 APP_DIR） |
| `snowlumaDir` | 协议端目录（留空用 `<APP_DIR>\protocol`） |
| `autoStartProtocol` | 启动时自动拉起协议端（默认 true） |
| `openPanelOnStart` | 启动时打开面板窗口（默认 true） |
| `closeWindowTo` | 关窗行为（ask/…） |
| `autostart` | 是否已登记开机自启（packaged 首次运行会写） |
| `instancesHome` / `instancesMainDataDir` | 多实例管理根/主数据目录（多实例启动时写入子实例设置） |

### 6.2 `config.json` 结构（`lib/config.mjs` 的 `DEFAULT_CONFIG`）

顶层键：`nextMemory`、`interaction`、`tb`、`configVersion`、`bot`、`activeCharacter`、`onboarding`、`llm`、`budget`、`chat`、`weather`、`group`、`memory`、`life`、`greet`、`qzone`。

重点子结构：

- `bot`：`selfId`（机器人 QQ）、`masterId/masterName`（主人）、`onebotWsUrl/httpUrl`、`accessToken`（本机随机生成）、`panelHost/panelPort`。
- `llm`：`activeProfile`、`profiles.<id>`（provider/baseUrl/apiKey/model/temperature/maxTokens/topP/contextTokens/vision/priceIn/priceOut/timeoutMs/maxConcurrency…）、`taskRoutes`（chat/moderation/summary/reflection/intent/qzone → profile）、`systemSuffix`、最近测试结果。
- `budget`：`enabled`、`globalDaily/Monthly`、`privateDaily`、`groupDaily`、`warnRatio`、`onExceeded`。
- `chat`：回复额度/条数/长度、合并窗口、防抖、静默时段、emoji、tools 开关与轮次、问候、抗卡壳、追话等。
- `group`：群白名单/触发策略/屏蔽词/警告/限流/成员策略。
- `memory` / `life` / `greet` / `weather` / `qzone` / `tb` / `nextMemory` / `interaction`：各子系统设置。
- `onboarding`：首次启动向导是否完成、步骤、snooze/reopen。
- 模型 API Key 在 `config.json`（明文，本地）里；面板 API 返回时会打码。

### 6.3 角色卡（`characters/<id>.json`）

字段（`CHARACTER_FIELDS`）：`name/title/worldview/persona/appearance/personality/speechStyle/habits/relations/boundaries/user/greeting/exampleDialogue/extras` + `locked`、`version`、`updatedAt`、私人档案绑定 `userOwnerId/userAccountId`。

- id 规则：`^[a-zA-Z0-9_\u4e00-\u9fa5-]{1,40}$`（`lib/config.mjs:486`）；
- `newCharacterId()` 当前按大小写区分去重（Windows 上会静默覆盖，见 §18 P0-2）；
- `activeCharacterId()` 找不到时回退到第一张卡或 `"example"`；
- `saveCharacter` 支持 `bumpVersion`、锁定字段保护、`user` 深合并。

### 6.4 环境变量

| 变量 | 用途 |
| --- | --- |
| `HEARTECHO_APP_DIR` | 程序目录（安装模式/多实例） |
| `HEARTECHO_DATA_DIR` / `HEARTECHO_LOG_DIR` / `HEARTECHO_SETTINGS` | 数据/日志/设置文件覆盖（测试必用） |
| `HEARTECHO_SNOWLUMA_DIR` | 协议端目录 |
| `HEARTECHO_EDITION` | `tb` 表示领航员终端（由 `--tb` 设置） |
| `HEARTECHO_BUNDLED` / `HEARTECHO_INSTALLED` | 打包/安装模式标记（后者为 v1.3.0 计划新增） |
| `HEARTECHO_INSTANCES_HOME` / `HEARTECHO_INSTANCES_MAIN_DATA_DIR` / `HEARTECHO_CLAIM_DIR` | 多实例/账号占位隔离（测试用） |
| `HEARTECHO_API_KEY` / `DEEPSEEK_API_KEY` | 首次启动自动发现模型 Key |
| `HEARTECHO_NODE_LICENSE` | `package-tb` 离线构建时指定 Node 许可证 |
| `HEARTECHO_PANEL_TOKEN` | 供 `check-pages` 等工具访问面板 |
| `HEARTECHO_TOOLS_DIR` | 打包时指定 esbuild/postject 所在目录 |

---

## 7. 数据模型（SQLite，`lib/db.mjs`）

`SCHEMA_VERSION = 3`；`migrate()` 在版本落后时先备份（`backups/pre-migrate-*`）再执行迁移。所有连接通过 `getDb()` 复用；事务用 `tx()`。

主要表（按域）：

- **角色/账号/会话**：`characters`、`qq_accounts`、`sessions`、`contacts`、`group_members`、`member_policies`。
- **消息**：`messages` + `messages_fts`（FTS5 trigram）+ `message_origins`（消息与角色/账号/代次关联）。
- **记忆**：`memories`（六类+来源+状态+supersede）、`memory_tokens`（倒排/关键词索引）、`memory_sources`（证据）、`reflections`、`relationships`、`memory_grants`（跨群/跨会话授权）。
- **数字生命**：`life_state`、`goals`、`reflections`（也在此域）、日记型 memories。
- **规则/审核**：`moderation_events`、`blocklist`、`warn_counts`、`rate_events`、`quota_exemptions`。
- **调度**：`scheduled_jobs`、`reminders`、`anniversaries`。
- **出站/空间**：`outgoing`（幂等键/状态 pending→sent→unknown）、`qzone_actions`、`qzone_capabilities`。
- **费用/审计**：`llm_usage`（request_id/任务/模型/token/费用/延迟/状态）、`budgets`、`audit_logs`。
- **清空/隔离**：`scope_resets`、`role_scope_resets`、`meta`（schema/迁移标记）。
- **扩展记忆（Hindsight）**：`hindsight_records`、`hindsight_deletions`。

**作用域（scopeKey）是硬约束**：

| 形态 | 含义 | chatKey（扩展用） |
| --- | --- | --- |
| `private_<QQ>` | 与某人的私聊 | `private:<QQ>` |
| `group_<群号>_<QQ>` | 某群里某成员的上下文 | `group:<群号>` |
| `panel_sandbox` / `image_test` / `sandbox*` | 面板试聊/图片自检/沙箱 | — |

- 任何存储/记忆/检索都必须显式带 scopeKey，空值直接抛错（`storage.mjs assertScopeKey`）。
- 还有 `scopeGeneration`：清空会话/换角色/换机器人号后，正在生成中的旧任务会被丢弃，防止“清空后又被写回”。
- 时间戳统一毫秒；日期键用本地时区（`dayKey`）。

---

## 8. 一条消息的完整生命周期（核心流程）

> 入口：`ChatEngine.receive(event)`（`lib/chat.mjs:1834`）→ 合并/去抖 → `handle(event)`（1209）→ `generate()`（670）。

1. **事件到达与标准化**（`lib/onebot.mjs`）：WS/HTTP 事件 → `normalizeEvent(raw, selfId)` → 统一字段：`kind/groupId/senderId/selfId/accountId/scopeKey/text/images/files/segments/isMention/replyTo/messageId/eventId/timestampMs`。过滤自己发的、非本账号的事件。
2. **入站入口**：
   - 群聊：`GroupMergeBuffer`（默认窗口 8 秒 / 最多 8 条；`burst-merge` 扩展可续期）把同一人连发合并成一次；
   - 私聊：`#bufferPrivate` 防抖/静默等待（面板可配 1–15 秒），等待期间可继续收消息；新消息重置计时但总上限 15 秒；
   - 已经在缓冲里落过库的消息会带 `alreadyStored: true`，避免二次写入/重复事件被判丢。
3. **`handle()` 准入**（1209-1230）：
   - `#tagEvent` / `#current`：作用域代次校验；
   - `gate(event)`（`policy.mjs`）：按优先级 暂停 → 黑名单/合规 → 群策略 → 成员策略 → 限流/冷却 → 主动行为意图 → …；返回 `{action: reply|warn|silent|skip, reason, trace}`；
   - `#noteDecision()` 写面板“决策审计”；
   - **先入库再判断**：真实消息一律 `insertMessage`（`eventKey` 幂等），`ensureContact`；重复投递直接忽略；
   - `silent/skip`：记审计后返回（不进模型）；若被限流会补一句额度提示（同一个桶只提示一次）；然后尝试 `#judgeInterest()`（`context-chime` 能力的“是不是该插话”）——只在“没被叫到”时生效，黑名单/暂停/限流不被覆盖；
   - `warn`：走 `#handleModeration`（警告/拉黑，零模型费用）；
   - 天气反馈读取（`#readWeatherFeedback`）：用户说“我这边晴天/别再说天气”会写状态；
   - 「记住：xxx」快捷事实：`parseFactCommand` + `rememberQuick`，固定文案回复；
   - 主人私聊回复后清“未回复计数”等。
4. **`generate()` 组装上下文**（670-874）：
   - `buildContext()`（418）：历史消息（排除本轮正在回的那些 `eventId`）、记忆 `promptBlock`（scope 过滤+检索）、成员态度/备注/称呼、关系与场合、时间/深夜/生活状态、`llm.systemSuffix`、合并提示；天气按三档（正常/被纠正/关闭）；`facts` 长期事实；`userText`（图片/文件转成多模态内容）；
   - 可选 Hindsight 长期记忆召回（`nextMemory.enabled` 时），失败会加一句“记忆服务暂不可用，别编”；
   - TB 搜索（`tbSearch`）可能追加资料或直接要求澄清；
   - 扩展 `before-context` 钩子（好感度、跨会话人物卡、统计任务识别等）；
   - 文件上下文：最近读过的文件可保留几轮。
5. **生成**：`#speakTurn()`（1032）：
   - `extensions.promptSections()` → 注入系统提示词末尾【可用技能】；
   - `tools = extensions.toolDefinitions()`（含核心 `finish/collect_sticker/list_stickers`）；
   - `llm.speakWithTools()`：发送 system+history+user；模型回 `tool_calls` → `extensions.runTool()`（串行、超时、结果截断、before/after-tool 钩子）→ 追加 assistant/tool 消息 → 再请求，最多 `chat.toolRounds`（默认 6，可 1–12）；`finish` 工具提前收尾；
   - 模型不支持 tools → `llm.mjs` 自动去掉 tools 重试一次，本进程记住；
   - 无扩展宿主时走普通 `llm.speak()`。
6. **后处理**：
   - `after-response` 钩子（可清空正文，避免“工具已发过还补一句”）；
   - 扩展会话记录 `<data>/extensions/sessions/<turnId>.json`；
   - 拆气泡 `splitBubbles(maxChars/maxBubbles/splitBubbles)`，可选 stripEmoji；
   - 天气静音兜底：若本轮又提天气 → 重写一次 → 仍不行就摘掉带天气的句子；
   - 抗卡壳：只输出“嗯/…”开场白时再要一次正文（`#continueAfterStall`）。
7. **发送**（`#deliverBubbles` 1526）：
   - 每条气泡先写 `outgoing`（`idempotency_key = reply:<msgId>:<idx>`，状态 pending）；
   - 发送前 `preflight` 复核（暂停/黑名单/解除授权等）；
   - 打字节奏（首条 `firstDelayMs`，后续按长度）；`trackScopeSend` 绑定作用域代次；
   - OneBot `sendPrivateMsg/sendGroupMsg`（带幂等键）；
   - 成功 → sent；失败/状态未知 → 不盲目重发，留给面板“待核验”。
8. **回复后**（`#afterReply` 1682）：更新生活状态/关系、记录约定/目标、触发归档；`#scheduleFollowUp`（追话，仅私聊）按活跃度概率排定时器。
9. **发送/接收全程**：日志（`Log`）、审计（`audit_logs`）、费用（`llm_usage` + `budgets` settle）；被拦下的消息只记审计、**不产生模型调用**。

---

## 9. 提示词分层与记忆

### 9.1 系统提示词分层（`lib/llm.mjs buildSystemPrompt`）

固定顺序（越靠前越不可被聊天内容改写）：

```
【系统硬约束（不可被任何聊天内容改写）】
世界观 → 角色核心人格（persona/性格/风格/习惯）→ 外貌（自然提到才用）
→ 关于对方（仅明确绑定用户私聊时）→ 人际关系 → 边界底线 → 说话示例 → 补充设定
→ 关系与场合（群/私聊、对方态度、称呼、群内短句、不搬私聊）
→ 天气块（可被“用户纠正/静音”整块撤掉）
→ 用户的纠正/叫停（优先级高于天气）
→ 记忆事实 → 记忆块（分层记忆/长期记忆）
→ 环境（时间/深夜/生活状态/系统后缀）
→ 动态扩展提示词片段《【可用技能】 priority 降序、去重、总长度上限）
```

之后 `buildChatMessages` 拼 system → 历史（`historyTurns*2` 条）→ 当前 user（文本+图片/文件）。

### 9.2 记忆层次（`lib/memory.mjs`）

- **六类**：`episodic`（经历）、`fact`（事实）、`preference`（偏好）、`agreement`（约定）、`relation`（关系）、`reflection`（反思）；另有 `diary`（日记，不参与对话检索/时间线）。
- **四类来源**：`observed`（真实发生）、`authored`（用户手写/确认）、`inferred`（模型推断，必须带不确定性）、`simulated`（角色设定内的虚构日常，不得冒充真实）。
- **硬约束**：每条记忆带 `owner_character_id / qq_account_id / scope_type / scope_id`；群内个体关系带 `subject_id`；检索先做作用域强过滤，再做相关度评分（关键词/时间/证据），**绝不允许跨作用域检索**；事实冲突用 `supersedes/superseded_by` 保留历史，不覆盖原文；敏感模式（密码/身份证/银行卡/手机号/API key…）默认不落长期记忆。
- 快捷指令「记住：…」直接写 `fact`；面板可增删改/撤回；清空会话会级联清记忆与索引。
- **扩展记忆（Hindsight，`nextMemory`）**：默认关闭；开启需要明确同意（服务地址/下游模型/数据范围的指纹）；只上传“每日摘要 + 明确回忆请求 + 召回候选”，不自动上传历史与附件；不可用时本地能力继续，发一次角色化说明；删除/清空有水位与远端删除重试。
- **数字生命（`life.mjs`）**：动态状态（valence/energy/social_drive，事件驱动+衰减）、关系（familiarity/trust/affection/tension 有界变化）、经历/反思（多源证据+置信度，不覆盖原始经历）、目标/约定、每日日记（作为独立提示词段落）。模型无权直接发消息。

### 9.3 提示词里的“人味”细节

- 深夜自动软化语气；群聊要求短、不搬私聊私事；合并消息提示“当成一口气说完”；
- 天气三档：被纠正 → 只给“对方说那边是 X”的反馈；正常 → 给预报但明确“市级、别播报、今天已提过就不再提”；关闭 → 不给；
- 反卡壳与反重复：开场白续写、合并历史去重（排除本轮事件）、`context-chime` 插话冷却。

---

## 10. 规则、限流、预算与主动行为

### 10.1 Policy Gate（`lib/policy.mjs`）

优先级（低不能覆盖高）：**用户手动暂停 > 黑名单/合规 > 群策略 > 成员策略 > 预算与冷却 > 主动意图 > 模型偏好**。

- 动作：`reply / warn / silent / skip`；每条判定都写 trace，面板“决策审计”可回放“为什么回/不回”。
- 黑名单红线：命中的消息 **0 出站、0 模型调用**；屏蔽词按（规则,消息）去重；警告次数默认“警告 1 次、再犯拉黑”；支持 LLM 生成警告语。
- 限流/额度：按用户/群/全局、分钟/小时/24h 滚动窗口；额度桶耗尽只提示一次；@/戳/欢迎不扣普通额度但仍受冷却与预算约束。
- 暂停：面板一键暂停，最高优先级，暂停时所有主动与回复停止（但消息仍入库/可查）。

### 10.2 预算（`lib/budget.mjs`）

- 调用模型前**同步原子预留**（按估算 token/价格），调用结束按实际 usage 对账；超支不会突破硬额度。
- 作用域：全局 / 私聊 / 群；周期：日/月；达到 `warnRatio` 预警，100% 熔断；`onExceeded` 决定对外表现（默认静默）。
- 每次调用写 `llm_usage`（request_id/task/model/tokens_in/out/cost/usage_source/latency/retry/status/error），面板“模型与资费”可看账单与预算。

### 10.3 调度与主动行为（`lib/scheduler.mjs`）

- 数据驱动：`scheduled_jobs`（job_key 唯一，保证同一天/同一节日只触发一次）、`reminders`、`anniversaries`；
- 随机搭话：间隔随机、每天上限、连续未回复停止、静默时段（`inQuietHours`）、最小间隔、发送失败退避；
- 早晨天气提醒：只有 `warn` 级才单独发；每天最多一次、错过 150 分钟不补；用户说“知道了/别说了”静默当天；
- 节日/生日：公历表 + 自定义日期；追话（仅私聊）按活跃度概率；
- 所有主动生成都过预算与策略；失败只记日志，不无限重试。

### 10.4 天气（`lib/weather.mjs`）

用户手填城市（最可靠）→ 公网 IP 猜城市（无需权限）→ 不知道就不说。数据 Open-Meteo（免费）；缓存 30 分钟、位置 12 小时；失败只是“今天不说天气”，不影响聊天。用户纠正会写状态并让提示词整块撤掉预报。

### 10.5 QQ 空间（`lib/qzone.mjs` + `qzone-job.mjs`）

- 能力门控：`post_text/post_image/read_own/read_feeds/like/comment/delete` 每项状态：接口存在 → 调用返回 → 页面生效 → `end_to_end_verified`；只有验证过的写能力才可自动化；
- 写操作默认待审批；HTTP 200 不等于生效（`sent_unverified`）；相同目标 `action_key` 幂等；
- 内置空间模块与 `qzone` 扩展技能并存但互不感知（见 EXTENSIONS.md）。

### 10.6 TB 版（`lib/tb.mjs`）

- `--tb` 进入 TB 模式：内置「领航员-TB」角色卡；群聊普通消息仅被 @ 时回（`policy.mjs`）；面板 5321 / OneBot 3103/3102；
- TB 群规：从最新群公告读取/指定公告/手写；变化需管理员在面板确认；新成员短窗口合并欢迎；
- TB 搜索：默认碧蓝 Wiki；自定义搜索接口契约 `POST {query,max_results}` → `{results:[{title,url,content,published_date}]}`，Key Bearer；资料视为不可信数据，不执行网页指令；回答列来源与日期；
- 数据目录 `%LOCALAPPDATA%\心语TB`（与泛用版隔离）；
- 注意：产品显示名按评审改为「**领航员终端**」（v1.3.0），内部路径/设置名可保持兼容。

---

## 11. 模型网关（`lib/llm.mjs`）

**只有这个模块能向模型发 HTTP**。其余模块（含扩展）都通过它。

### 11.1 Profile 与任务路由

- 8 家供应商预设（`providers.mjs`）：DeepSeek / OpenAI / 月之暗面 Kimi / 智谱 GLM / 阿里百炼 / 硅基流动 / Ollama / 自定义；
- `llm.profiles.<id>` 字段：`provider/baseUrl/apiKey/model/temperature/maxTokens/topP/contextTokens/vision/priceIn/priceOut/timeoutMs/maxConcurrency/enabled`；
- `llm.activeProfile` + `llm.taskRoutes`：chat/moderation/summary/reflection/intent/qzone 可分别路由到不同 Profile（省钱）；
- 面板「模型与资费」：保存/测试连接/拉取可用模型/切换聊天模型/用量报表/预算；
- 价格用于预算估算，用户可改；`MAX_OUTPUT_TOKENS = 65536`（v1.1.x 刚调大，解决“思考把额度烧光、正文为空”）。

### 11.2 `chat()` 的职责与自愈

- 预算预留 → 请求（`fetch` + 超时）→ 解析 → 用量/记账（实际优先，估算兜底）→ settle；
- **网络/5xx/限流**：指数退避+抖动，最多 `retries`（默认 2）；
- **模型不存在/无权限**：`isModelError` 保守判定 → 拉模型列表 → 临时换可用模型重试（**只存内存，绝不写回配置**）；用户可在面板看到“临时顶替”；
- **只接受 temperature=1**：自动改成 1、记住并写配置（这是少数允许写回的自愈）；
- **接口不支持 tools**：去掉 tools 重试一次，本进程记住；
- **max_tokens 太大**（400）：自动降到报错里的上限或对半砍，记住该模型上限后重试；
- **思考型模型正文为空**：`reasoning_content` 非空而 content 空 → 按 ×4 逐级放大（最多 3 次，顶到 65536）重试；仍失败给可执行报错（区分 finish_reason=length 与否）；
- 记录 `llm_usage`；错误不吞（聊天层会得到可读中文错误）。

### 11.3 `speak / speakWithTools / json / testConnection / listModels / ensureUsableModel`

- `speak(character, userText, options)`：组装 system+history+user 后单次调用；
- `speakWithTools(...)`：工具循环（见 §8.5），支持 `onMessages`（扩展 before-llm-messages）、`requestPatch`（扩展 llm.request-params，可改本轮请求体）、`runTool`、`onToolEvent`；
- `json()`：要求纯 JSON 输出（summary/reflection 等），解析失败重试受限；
- `testConnection()`：最小请求+模型不存在时给可用列表；`ensureUsableModel()` 挑通用对话模型（避开 code/vision 专用）；
- `status()`：面板总览/模型页用（含 modelFallback、temperatureLocked、预算、最近测试）。

### 11.4 工具调用基础（`lib/tools.mjs`）

- 工具名：扩展工具 `<extensionId>__<toolId>`，sanitize 为 `[a-zA-Z0-9_-]{1,64}`；核心工具 `finish/collect_sticker/list_stickers`；
- schema：OpenAI `function` 格式；参数 JSON；
- 执行：**串行**（副作用安全）；单工具超时默认 30s，扩展可声明 `timeoutMs`（上限 180s）；结果默认 8000 字截断，可声明 `maxResultChars`（上限 30000）；
- `finish`：模型主动收尾，不再发正文；`tool_calls` 轮 content 允许为空；
- 模型不支持 tools 时整体降级纯聊天，不阻塞对话。

---

## 12. 扩展系统（插件 / 技能）

详见 `EXTENSIONS.md` 与 `docs/扩展宿主契约.md`（本地）。这里是给接手 AI 的浓缩版。

### 12.1 概念

- 目录：`extensions/plugins/<id>/{plugin.json,index.js,test.mjs,...}` 与 `extensions/skills/<id>/{skill.json,index.js,...}`；
- **插件与技能是同一套机制**（同一清单格式、`setup(api)`、hooks/providers/promptSections），只是约定：插件偏确定性规则/钩子，技能偏给模型工具+提示词；
- 清单字段：`id/name/version/apiVersion/category/description/author/entry/enabledByDefault+settings/configSchema/prompt/permissions/capabilities/requires`；
- 入口：`export function setup(api)`（注册工具）、`available()`（同步可用性）、`hooks`、`providers`、`promptSections(ctx)`、`activate/deactivate/dispose`；
- 数据：`<data>/extensions/<id>/`；设置：`<data>/extensions/state.json`；会话记录：`<data>/extensions/sessions/`；
- 打包：SEA 单文件无法从磁盘 import 扩展，构建前 `tools/gen-extensions.mjs` 生成静态注册表 `lib/extensions.generated.mjs`（gitignore）；源码模式走磁盘扫描；装好不热重载。

### 12.2 宿主 API（摘要）

`api.config/log/warn/error/registerTool/isSkillActive/capability/hasCapability/tools/utils{sleep,safeJsonParse}/fetch（仅 permissions:["web_fetch"]）/visionEnabled/model/baseUrl/dataDir/store/stickers/onebot/sender/emit`。

每轮 `ctx`：`chatKey`（`group:<群号>` / `private:<QQ>`）、`chatId/kind/selfId/sessionId(=turnId)/proactive/triggerEntries/recent/messages/session/store/stickers/onebot/sender/visionEnabled/tools/chatName/botName/selfNickname/model/provider/emit`。

钩子：`before-context`（可改 ctx / 注入）、`before-llm-messages`（可原地改 messages）、`before-tool`（可 block）、`after-tool`、`after-response`（可清空/改写正文）。能力 provider：`wake.burst-policy`、`reply.interest-judge`、`memory.person-card`、`llm.request-params`。

### 12.3 16 个内置扩展

- 6 插件：`affinity` 好感度、`burst-merge` 连发合并、`context-chime` 插话判定、`cross-chat-link` 跨会话人物卡、`group-cost-report` 群花费统计、`self-surf` 自己上网；
- 10 技能：`ledger` 小本本、`deai-flavor` 去 AI 味、`meme-taste` 表情品味、`reply-meme` 回复梗图、`smart-image` 智能配图、`search-image` 搜图、`qzone` 空间、`qq-self` 空间与资料、`api-beggar` 余额乞讨、`agent-reach` 网页/B站/RSS；
- 默认开启情况见 `EXTENSIONS.md` 表格（个别默认关：`search-image`、`qq-self`）；
- **来源/许可**：由用户提供的 QQ Agent 0.4 生态素材移植，原始素材无 LICENSE；分发前需确认作者授权（`EXTENSIONS.md` §6）。评审决定：安装包随附 16 个扩展，并在安装器/文档中列出来源与授权提醒。

### 12.4 安全边界（必须理解）

- 扩展是**进程内 ESM**，`permissions` 只控制 `api.fetch`，不是沙箱；`tools/security-test.mjs` 扫描 `child_process`/裸 `fetch(`/可执行文件等红线，只是回归检查；
- 网络只能走 `api.fetch`（SSRF 防护：禁内网/本机、20s 超时、8MB 上限、UA 大小写处理）；发送只能走 `ctx.sender`（当前会话，共用出站/幂等/发送前检查）；文件只能写自己数据目录；不读密钥；
- 钩子禁网禁发、单钩子 5 秒超时、异常隔离；工具串行。
- 只安装信任来源的扩展；不要盲目把陌生扩展丢进 `extensions/`。

### 12.5 加/改扩展的流程

1. 放目录 + 清单 + 入口（ESM，不要顶层 await、不要 `?v=` import、网络走 `api.fetch`、数据写 `DATA_DIR/<id>/`）；
2. 写 `test.mjs`（导出 `cases: [{name, run: async (t)=>{}}]`），跑 `node tools/extensions-test.mjs --only <id>`；
3. `node tools/gen-extensions.mjs` 重新生成注册表（打包 exe 时自动执行）；
4. 跑 `node tools/selftest.mjs`、`node --test tools/security-test.mjs`。

---

## 13. 控制面板（前端 + API）

### 13.1 后端 API（`lib/api.mjs`）

- 本地 HTTP server（默认 `127.0.0.1:5311`）；`panelHost/panelPort` 可配；
- 安全：`lib/panel-auth.mjs` 校验 Host、Origin、`sec-fetch-site`、Content-Type（写接口必须 `application/json`），Bearer token 或 HttpOnly cookie；token 文件在 `<data>/panel-token`；
- 路由很多，按域分组：`/api/status|health|config|providers`、`/api/characters/*`、`/api/conversations|conversation|chat/*`、`/api/groups*`、`/api/memory*`、`/api/life*`、`/api/schedule*`、`/api/weather*`、`/api/qzone*`、`/api/llm*`、`/api/extensions*`、`/api/protocol*|onebot/*`、`/api/instances*`、`/api/system/*`、`/api/logs*|logs/stream`（SSE）、`/api/panel/session`；
- `publicConfig()` 会打码 API Key；写接口先读 body 再 `saveConfig`；
- 面板 HTML 由 `GET /` 返回；`/api/logs/stream` 是 SSE 实时日志。

### 13.2 面板前端（`lib/ui-app.mjs`）

- 整页是一个巨型 `String.raw` 模板（`APP_JS`），**无运行时框架、无构建步骤**；`ui.mjs` 负责把 CSS、图标 JSON、脚本拼成 HTML；
- **硬性约束**：模板里不能出现反引号或未转义的 `${...}`（会导致外层模板断裂）；新增内容必须用字符串拼接 + `esc()`；改完跑 `node tools/check-ui-template.mjs`；
- 结构：`const S = {...}` 全局状态、`NAV` 导航（5 组 16 页）、`RENDERERS` 页面渲染函数、`TITLES`、`go(page)`、`render()`（带 `renderRevision` 丢弃过期结果）、`wire()`（绑定当前 DOM 事件）、`api()`（自动带 token/cookie、JSON、错误处理）、`toast()`、`esc()`；
- 页面：总览、角色工作室、试聊与对话、对话设置、群聊与审核、记忆、记忆与互动、数字生命、主动与日程、天气与位置、QQ 空间、插件与技能、QQ 账号、模型与资费、运行环境、日志；
- 面板授权流程：窗口以 `http://127.0.0.1:<port>/#panelToken=<token>` 打开 → 前端把 token 放 `sessionStorage` → `POST /api/panel/session` 种 cookie → 后续同源请求带 cookie；**裸 URL 打开会 401**（「请从托盘打开面板」）。
- 常见坑：重建 exe/改前端后，旧窗口仍加载旧 JS（看起来是新的但行为旧）——需刷新或重开窗口；无头检查用 `tools/check-pages.mjs`（要 `HEARTECHO_PANEL_TOKEN`）；`options` 面板 `window.prompt` 可用。

### 13.3 前端检查工具

- `tools/check-ui-template.mjs`：模板引号/结构检查；
- `tools/check-pages.mjs`：无头 Edge/Chrome 逐页打开 16 页，检查标题/文字/控件/空态/控制台错误（需要运行中的面板 + token）；
- `tools/browser-check.mjs`、`tools/shoot.mjs`：单页检查/截图；
- `tools/format-ui.mjs`：专门格式化 `APP_JS` 内部代码（`format`/`format:check` 会调用）。

---

## 14. 多实例、协议端与 TB（领航员终端）

### 14.1 多实例（`lib/instances.mjs`）

- 设计：**一个 QQ 号 = 一个实例 = 一个角色**；每个实例独立目录/数据/配置/端口/锁，避免作用域串台；
- 形态：`<instancesHome>/instances/<id>/`（含 `心语设置.json`、`data/`）；`<instancesHome>/instances.json` 登记表；
- `instancesHome` 默认 `paths.app`（程序目录）；测试/安装版可配到可写目录；
- 启动：`心语.exe --instance <目录>`（源码：`node index.mjs --instance …`）；`startInstance()` 会写共用协议端配置并拉起；
- **跨进程账号占位**：`%LOCALAPPDATA%\HeartEcho\accounts\<QQ>.json`（pid/数据目录/面板端口/启动时间），防止同号双开；崩溃留下的死占位（进程不在或 >7 天）自动忽略；
- 面板：`/api/instances*`（列出/创建/启动/删除/打开面板）；实例面板 URL 会自动带该实例 token；
- 限制：同一 QQ 同时只能一个实例；子实例第一次启动仍需人工在 QQ 客户端登录该号。

### 14.2 协议端（SnowLuma / NapCat）

- 为什么特殊：SnowLuma 不是普通 OneBot 服务端，它通过注入 `QQ.exe`（QQNT 客户端）hook 收发消息；**一个 QQ 进程只认一份 hook**，所以一台机器只该跑一份协议端；多实例共用主实例那份，每个实例只写自己的 `config/onebot_<QQ>.json`（各自端口/令牌）；
- 目录判定：`protocol.mjs` 找入口（`index.mjs/main.mjs/app.mjs/launcher.bat...`）+ `config/` 或 `native/`；
- 启动：`startProtocol()` detached + `windowsHide` + 日志到 `<data>/logs/protocol.out.log`；跨进程 spawn 锁；等待账号 WS 端口监听；有 WebUI 但还没接管该号时给“已运行未接管”状态；
- 诊断：`diagnoseProtocol()`/`ensureProtocol()`/`restartProtocol()`/`stopProtocol()`；`health.mjs` 只读检查配置与端口；
- 端口：OneBot WS/HTTP 默认 3101/3100（TB 3103/3102）；SnowLuma WebUI 默认 5099（`config/runtime.json`）；面板 5311/5321；
- **登录无法自动化**：QQ 扫码/登录只能人工；协议端启动后靠 `QQ.exe` hook 自动发现登录账号；
- **已知缺口（v1.3.0 要修）**：`findNode()` 只找系统安装的 node.exe，打包版没有 Node 就拉不起协议端；安装包将内置 `runtime\node.exe` 与干净 SnowLuma（计划）。

### 14.3 TB 版（将更名「领航员终端」）

- `--tb` 进入（`lib/boot-env.mjs`）：数据 `%LOCALAPPDATA%\心语TB`、设置 `心语TB设置.json`、面板 5321、OneBot 3103/3102；首次写入 TB 角色卡与默认配置；
- `lib/tb.mjs`：群规（最新公告/指定/手写，变化待确认）、新成员合并欢迎、碧蓝 Wiki 搜索与自定义搜索契约、TB 专属提示；
- 与泛用版隔离：不同数据/端口/角色；同一 QQ 不能同时跑两版；
- 命名决策：安装包/启动器/快捷方式显示为「**领航员终端**」；内部数据路径建议保持 `心语TB` 兼容旧数据（见 v1.1 任务书）。

---

## 15. 桌面壳、打包与分发

### 15.1 桌面壳（`lib/desktop.mjs`）

- 托盘：生成 PowerShell WinForms 脚本到 `<data>/cache/tray.ps1` + 图标；双击打开面板，右键重启/退出；与主进程通过退出码约定通信（42=重启等）；
- 面板窗口：找 Edge/Chrome，用 `--app=<url>` 打开独立窗口（带 token hash），profile 在 `<data>/cache/window-profile`；找不到 Chromium 退回默认浏览器；
- 开机自启：在启动目录建 `.lnk`（`心语机器人.lnk` / TB `心语TB.lnk`），SEA 打包版首次运行自动登记（`settings.autostart`）；可用 `--install-autostart/--remove-autostart/--autostart-status`；
- 重启自己：`relaunchSelf()` 优先 explorer 拉起自身，源码模式用 powershell 延时拉起 `node index.mjs --takeover`；
- 单实例：锁文件在 `%TEMP%`（按数据目录哈希），配合面板端口检测。
- 已知问题：源码模式 `启动心语.bat` 没带 `--tray` → 不弹窗口；裸 URL 无 token → 401（P0-1）。
- 安装版（v1.3.0）改由小启动器负责注入环境/拉起 node，`isSea` 判断将变为安装模式判断。

### 15.2 现有打包（SEA）

`tools/build-exe.mjs`：

1. `tools/gen-extensions.mjs` 生成 `lib/extensions.generated.mjs`；
2. esbuild 把整个项目打成单个 CJS（`build/bundle.cjs`）；
3. `node --experimental-sea-config` 生成 blob；
4. postject 把 blob 注入一份 `node.exe`；
5. 改 PE 子系统 3→2（GUI，双击不弹黑窗；`--console-subsystem` 可跳过）；
6. 写图标（`build/app.ico`）；
7. `--probe` 冒烟。

产物 `dist\心语.exe` ≈ 91 MB；目标机无需 Node。**注意**：SEA 里 `process.execPath` 是 exe 自己；`isSea` 为真时数据默认 `%LOCALAPPDATA%\心语`、桌面壳默认开启。

`tools/package-tb.mjs`：生成 TB 便携目录（源码 + `node.exe` + 16 扩展 + 许可/说明），**不含** protocol/data/登录态。

### 15.3 计划中的安装版（方案 A2，评审已选）

- 单一 Node 运行时：`app/`（源码）+ `runtime\node.exe` + `protocol\`（干净 SnowLuma）+ 小启动器 `心语.exe`（C# 编译，几十 KB）；TB 启动器 `领航员终端.exe`；
- 两个独立安装包（自研 C# 安装器，per-user 免管理员，默认开机自启但需弹窗说明，随附 16 扩展）；
- 需要改造：`paths.mjs` 安装模式默认数据目录、`desktop.mjs` 的 desktopMode/自启动/重启、`instances.mjs` 的 HOME/启动方式、`protocol.mjs` 的 findNode、`tools/build-installer.mjs` 新构建流水线、安装器/卸载器/迁移；
- 详细范围、决策、验收见 [实施任务书 v1.1](实施任务书-v1.1-已确认.md)。

---

## 16. 测试体系

### 16.1 工具与当前基线

| 工具 | 覆盖 | 当前基线 | 备注 |
| --- | --- | --- | --- |
| `tools/smoke.mjs` | 模块加载/对象创建/前端脚本语法 | 通过 | 最快 |
| `tools/selftest.mjs` | 100+ 用例（离线，临时数据目录） | **98/98** | 分组：角色配置、消息幂等、群策略、记忆、数字生命、调度、费用、提示词、对话设置、世界观、消息不丢、卡壳、模型可用性、天气、存储、群成员、扩展、多实例 |
| `tools/selftest.mjs --with-llm` | 额外 5 项联网模型用例 | 需 Key | 会花钱 |
| `tools/extensions-test.mjs` | 16 扩展包单测（每包独立子进程/数据目录） | **91/91** | 支持 `--only <id>` |
| `node --test tools/security-test.mjs` | 安全边界/URL/工具注册表/扩展红线扫描 | **22/22** | |
| `node --test tools/tooling-test.mjs` | 内嵌前端检查/格式化工具 | **6/6** | |
| `node --test tools/next-version-test.mjs` | 新版记忆/互动/TB | **31/31** | |
| `tools/conversation-flow-test.mjs` | 对话流程（桩） | **15/15** | |
| `tools/check-identifiers.mjs` | 导入名存在性 | 554 个全部存在 | |
| `tools/check-ui-template.mjs` | UI 模板结构 | 0 可疑行 | |
| `tools/backup-verify.mjs` | 备份恢复演练 | 通过 | |
| `tools/check-pages.mjs` | 16 页无头浏览器检查 | 16/16（需运行中的面板 + token） | `HEARTECHO_PANEL_TOKEN` |
| `tools/browser-check.mjs` / `shoot.mjs` | 单页/截图 | 人工 | |
| `tools/e2e-live.mjs` | 真实 QQ 端到端 | 需真实号/令牌/钱 | **不要擅自跑** |
| qzone-*verify | 真实空间读写 | 需授权/真实账号 | **不要擅自跑** |
| `npm run lint` | ESLint | **78 个既有 error（不绿）** | 不要全局“修复” |
| `npx prettier --check .` | 格式 | **114 文件有差异（不绿）** | 同上 |

### 16.2 加测试的约定

- 离线用例加到 `tools/selftest.mjs` 对应分组，用临时数据目录、合成 QQ 号；断言失败要有中文说明；用例编号不要与既有重复（先 grep）。
- 扩展测试：每个包 `test.mjs` 导出 `cases`，用 `node tools/extensions-test.mjs --only <id>` 迭代；测试数据通过 `tools/extension-harness.mjs` 隔离。
- 修改核心流程后，至少跑：smoke、selftest、extensions、security、tooling、next-version、conversation-flow；改前端加跑 check-ui-template/check-pages；改打包加跑 `node --test tools/exe-verify.mjs`（如果涉及）。
- 测试基线数字变化时同步 README/文档（当前 README 部分数字已过时，见 v1.0 §2.6）。

---

## 17. 代码规范与硬性约束（给接手 AI 的行为准则）

1. **零第三方运行时依赖**：不要新增 npm 运行时依赖；用 Node 内置（`node:sqlite`/`fetch`/`node:crypto`…）。开发依赖也尽量不增，构建工具（esbuild/postject）只在开发机。
2. **不改生成物**：`lib/extensions.generated.mjs` 是生成文件（gitignore），改扩展后跑 `node tools/gen-extensions.mjs`，不要手改。
3. **不提交**：`data/`、`dist/`、`protocol/`、`build/`、`docs/`、`node_modules/`、`心语设置.json`、`lib/extensions.generated.mjs`、`插件及SKILL/`（见 `.gitignore`）；不要提交任何 Key/token/聊天记录/QQ 号/角色卡。
4. **注释与错误信息用中文**，解释“为什么”而不只是“做了什么”；用户可见错误要能照着做（项目一贯风格）。
5. **UI 模板约束**：`lib/ui-app.mjs` 的 `APP_JS` 是 `String.raw` 模板；不得出现反引号/未转义 `${}`；用 `esc()` 转义输出；改完跑 `check-ui-template` 与（有面板时）`check-pages`。
6. **数据安全**：测试用 `HEARTECHO_DATA_DIR` 临时目录；不调用真实 e2e/空间写操作；不擅自重启/退出用户正在使用的实例；破坏性操作先问用户；升级/迁移先备份。
7. **作用域红线**：任何会话/记忆操作必须显式 scopeKey；不要写“全局检索”或跨会话读取；私人档案只在绑定私聊注入。
8. **费用红线**：模型调用必须走 `llm.mjs`（预算/记账/自愈都在里面）；不要直接 `fetch` 模型接口；被策略拦下的消息不能产生模型费用。
9. **发送红线**：发 QQ 消息必须走出站表/幂等/发送前检查（`chat.deliver*`/`sendExtensionMessage`）；扩展只能 `ctx.sender`；未知状态不盲目重发。
10. **安全红线**：面板默认只监听 127.0.0.1、token/cookie 校验不能绕过；扩展是信任代码（无沙箱）；`api.fetch` 的 SSRF 防护不要放宽；日志不要输出明文 Key/token。
11. **Git**：完成后跑测试再提交；提交信息中文、说明“为什么”；不要 force push；当前仓库相对 origin 领先 4 个提交且网络可能不通，推送失败先如实说明，不要强推/改写历史。
12. **风格基线**：lint/prettier 目前是红的（历史存量）。不要顺手全文件格式化/重构无关代码；保持新增代码风格一致即可（printWidth 120、双引号、分号、尾逗号）。
13. **改动后更新文档**：涉及安装/启动/配置/端口/目录结构的变化，同步 README 或 docs；测试数量变化同步数字。
14. **不确定就问**：安装器/方向/上传/真实 QQ 测试这类影响用户或花真钱的决策，先找用户确认。

---

## 18. 当前已知问题与下一步（P0 摘要）

详见 v1.0 调查任务书 §2 与 v1.1 实施任务书。接手 AI 先做 M1 热修（评审建议）：

| 问题 | 根因（摘要） | 修复方向 |
| --- | --- | --- |
| **P0-1 bat 不弹面板** | 源码模式 `node index.mjs` 无 `--tray`；裸 URL 无 `#panelToken` → 401 | bat 加 `--tray`；新增 `--open-panel`（读取 panel-token 打开）；README 同步 |
| **P0-2 新建角色失败/成功但没卡** | `newCharacterId` 大小写敏感 vs Windows 文件系统大小写不敏感 → 静默覆盖（已复现）；另有面板竞态/目录不可写风险 | id 生成小写折叠去重 + 保留名/尾点空格；创建语义禁止覆盖；失败可见；UI 本地插入+刷新；补测试 |
| **P0-3 SnowLuma 未打包** | `.gitignore` 排除 protocol；SEA 只打本体；`findNode` 只找系统 node；目标机没 Node 就拉不起协议端 | 安装包内置干净 SnowLuma + `runtime\node.exe`；`findNode` 优先随包 runtime（v1.3.0） |
| **P0-4 TB 版无法启动** | 首启 selfId=0 → `claimAccount` 拒绝 → `exit 1` → supervisor 每 5s 重启刷「机器人 QQ 号还没设置」 | 首次配置模式：缺 QQ/Key 不退出，开面板+引导；supervisor 配置错误不重启；TB 内置协议端 |
| P1 首启缺配置直接退出（泛用同病） | 同上 | 同上 |
| P1 文档不一致 | README 声称 protocol 内置/批处理开窗，实际没有 | v1.3.0 前先修 README |
| P1 双版本端口/登录态无规则 | 两版各自 SnowLuma 抢 5099/QQ 注入 | 端口规划（TB WebUI 5098）、启动检测、文档写明 |

**评审已确认的下一步**（用户回复映射，详见 v1.1 任务书 §0.2）：

- 发布范围：**小范围非商用**，安装包/文档标注来源；
- SnowLuma：用户提供官方干净包，**允许内置**（附 EULA/PRIVACY/来源说明）；
- 安装器：**自研 C#**（Windows 自带 .NET Framework csc，无外部构建依赖）；
- 运行时架构：**方案 A2 单运行时**（`runtime\node.exe` + app 源码 + 小启动器；不再以 SEA 作为安装版主形态）；
- 安装包：**两个独立安装包**；TB 版命名为「**领航员终端**」；
- 安装位置：默认 **per-user 免管理员**；
- 开机自启：**默认开启**，但安装/首启必须弹窗说明并可关闭；
- 扩展：随包附上 16 个；
- 代码签名：暂缓（v1 不签，文档说明 SmartScreen）。

尚未明确（按建议默认）：旧便携版数据迁移=检测+询问+不删原数据；自动更新=v1 不做；**先做 M1 热修**。

---

## 19. 本机环境与产物快照（编写时）

| 项 | 值 |
| --- | --- |
| 仓库 | `E:\心语`；HEAD `ff20321`；`main...origin/main [ahead 4]` |
| Node | v24.22.0（`C:\Program Files\nodejs\node.exe`，约 89.5 MB） |
| 构建工具 | `node_modules` 内有 esbuild/postject；7-Zip 26.01（含 `7z.sfx`）；.NET Framework `csc.exe`；dotnet SDK |
| 现有产物 | `dist\心语.exe` ≈ 91.3 MB；`dist\HeartEcho-TB` 便携包 91.6 MB（zip 35.2 MB） |
| SnowLuma | 1.14.22；干净运行时约 17.5 MB；用户目录里已装 QQ 客户端（SnowLuma 依赖它） |
| 运行状态 | 用户可能有一个常驻实例在跑；真实数据在 `dist\data`（勿动）；测试请用临时数据目录 |
| 测试基线 | selftest 98/98、extensions 91/91、security 22/22、tooling 6/6、next 31/31、flow 15/15、页面 16/16；lint 78 存量 error；prettier 114 文件差异 |
| 网络 | GitHub 时通时不通；`origin` 推送未完成，不要依赖推送成功 |

---

## 20. 上手检查清单（建议第一天）

1. **读文档**：本总览 → [实施任务书 v1.1](实施任务书-v1.1-已确认.md) → `README.md`（知道哪些过期）→ `EXTENSIONS.md` → `CONTRIBUTING.md` → `SECURITY-BOUNDARIES.md`。
2. **跑基线测试**（第 2.2 节命令），确认所有数字与 §16 一致；如果本机环境不同（Node 版本/依赖缺失），先修环境再改代码。
3. **隔离起一次实例**（第 2.3 节），用 token 打开面板，点一遍 16 个页面（或用 `check-pages`），建立“正常长什么样”的直觉；**不要碰真实数据目录**。
4. **按顺序读核心模块**：
   `paths/config → db/storage → onebot → policy/budget → llm → memory/life → chat → extensions/tools → api/ui-app → desktop/protocol/instances`.
5. **确认需求**：以 v1.1 任务书为准；先做 M1（bat/首启/TB/角色）并跑回归，再做安装器（A2 重构 + 自研 C# 安装器 + SnowLuma 内置）。
6. **改动前**：grep 既有用例编号、确认写作用域、避免与用户/其他 AI 并行改同一文件；改完跑测试并更新文档。
7. **不确定/涉及真实 QQ、模型费用、用户数据、重启用户实例 → 先问用户。**

---

## 附录 A：关键代码位置索引（以 ff20321 为准，行号可能随后续修改漂移）

| 主题 | 位置 |
| --- | --- |
| 入口/启动/退出 | `index.mjs`（启动顺序 §4） |
| TB 种子配置 | `index.mjs:191-196` |
| 账号占位/退出 | `index.mjs:406-437`、`lib/instances.mjs:339-356` |
| 桌面形态判定 | `index.mjs:678-700` |
| 自动开机自启 | `index.mjs:445-457`、`lib/desktop.mjs:334-398` |
| 路径/设置 | `lib/paths.mjs`、`lib/boot-env.mjs` |
| 默认配置/角色卡 | `lib/config.mjs`（normalize / characterPath / newCharacterId） |
| DB 表/迁移 | `lib/db.mjs`（SCHEMA_VERSION=3） |
| 消息生命周期 | `lib/chat.mjs:receive(1834)/handle(1209)/generate(670)/#speakTurn(1032)/#deliverBubbles(1526)` |
| 提示词分层 | `lib/llm.mjs buildSystemPrompt(47)`、`buildChatMessages(733)` |
| 工具循环 | `lib/llm.mjs speakWithTools(788)`、`lib/tools.mjs`、`lib/extensions.mjs runTool/toolDefinitions` |
| 扩展宿主 | `lib/extensions.mjs`、`EXTENSIONS.md`、`docs/扩展宿主契约.md` |
| 面板 API | `lib/api.mjs`、`lib/panel-auth.mjs` |
| 面板前端 | `lib/ui-app.mjs`（APP_JS/NAV/RENDERERS/wire） |
| 桌面壳 | `lib/desktop.mjs` |
| 协议端管理 | `lib/protocol.mjs`、`lib/health.mjs` |
| 多实例 | `lib/instances.mjs` |
| 打包 | `tools/build-exe.mjs`、`tools/package-tb.mjs`、`tools/gen-extensions.mjs` |
| 页面检查 | `tools/check-pages.mjs`、`tools/check-ui-template.mjs` |

## 附录 B：术语表

| 术语 | 含义 |
| --- | --- |
| scopeKey | 会话作用域：`private_<QQ>` / `group_<群号>_<QQ>` / `panel_sandbox` … |
| chatKey | 给扩展用的会话键：`private:<QQ>` / `group:<群号>`（宿主翻译） |
| 角色（character） | 一套人格设定卡，作用域数据的 owner；activeCharacter 当前使用 |
| 实例（instance） | 一个 QQ 号 + 一个角色 + 独立数据目录/端口 |
| Profile | 模型配置（供应商/Key/模型/价格/参数）；taskRoutes 按任务路由 |
| turnId / session | 一轮生成的 id；扩展会话记录按 turn 存 |
| 扩展（extension） | 插件（plugin）与技能（skill）的统称，同宿主机制 |
| 钩子（hook） | 扩展在对话关键节点的介入点 |
| 能力（provider） | 扩展向核心提供的某能力实现（如 wake/interest judge/request params） |
| SnowLuma | 第三方 QQ 协议端，通过注入 QQ.exe 提供 OneBot 接口 |
| OneBot 11 | QQ 机器人协议（WS/HTTP 事件与 API） |
| SEA | Node 单文件可执行（Single Executable Application） |
| TB / 领航员终端 | 特化版（`--tb`），独立数据/端口/角色 |
| Hindsight | 可选的扩展长期记忆服务（本地 Docker 或远程） |
| 决策审计 | 面板里每条消息“为什么回/不回”的可解释记录 |

## 附录 C：历史踩坑清单（改代码前值得看）

1. **先入库再判断**：消息要先进库再去重/准入，否则“被拦下的消息查不到”；合并队列消息带 `alreadyStored`，别重复写（曾因此丢消息/不回复）。
2. **历史里排除本轮消息**：先入库再生成会让同一句在提示词里出现两次（模型会问“你怎么说两遍”）；`buildContext` 按 eventKey 排除本轮。
3. **思考型模型空正文**：小 `max_tokens` 全花在 reasoning 上 → 正文空；现在会逐级放大到 65536；`finish_reason=length` 才代表额度用完。
4. **temperature 只接受 1 的模型**：不要误判为模型下线去换模型；已有 `temperatureLocked` 自愈（这条允许写回配置）。
5. **模型不可用自动切换**：临时顶替只存内存，**绝不写回用户配置**（曾把用户选的模型覆盖，用户“第二天开机变回去”）。
6. **面板旧窗口**：重建后旧页面仍跑旧 JS/旧导航——刷新或重开；别拿旧窗口的现象判断新代码坏了。
7. **面板裸 URL 401**：必须带 `#panelToken` 或 cookie；手动测试面板 API 时用 Bearer token（`<data>/panel-token`）且写接口要 `application/json`。
8. **扩展测试隔离**：扩展模块顶层会冻结 DATA_DIR，必须每个包独立子进程/独立数据目录跑（`extensions-test.mjs` 已做）。
9. **扩展工具结果/超时**：默认 30s/8000 字；长任务（如空间发图）要在 manifest 里声明 `timeoutMs`，否则会被宿主截断。
10. **表情收藏 scope 翻译**：扩展传 `chatKey`（`group:<群号>`），宿主内部要翻译成 scope 前缀再查库（曾按原样查不到）。
11. **UI 模板反引号**：`APP_JS` 是 `String.raw`；加模板字符串/`${}` 会破坏外层模板，必须拼接+`esc()`。
12. **bat 编码**：`启动心语.bat` 必须 GBK+CRLF（否则中文乱码/命令失效）；修改时用 ANSI 保存，别让编辑器转 UTF-8。
13. **PE 子系统**：双击不弹黑窗靠改 exe 的 PE Subsystem（3→2）；改完 `--probe` 仍应有输出（管道重定向）。
14. **协议端不能双开**：SnowLuma 抢 QQ hook，一台机器只能一份；多实例共用主实例 protocol 目录。
15. **账号占位**：同号双开会互相顶下线；`%LOCALAPPDATA%\HeartEcho\accounts\<QQ>.json` 是跨实例/跨版本共享的。
16. **预算预留**：模型调用必须先原子预留再发请求；结算用实际 usage；被拦下的消息不能产生费用。
17. **发送状态未知**：不要盲目重发；出站表 `unknown` 留给面板核验。
18. **清空/换角色代次**：生成中的旧任务要能被丢弃（`scopeGeneration`/`assertCurrentScope`），否则清空后又被写回。
19. **隐私档案**：只有明确绑定 `userOwnerId/userAccountId` 的私聊才能注入私人档案；群聊/其他联系人不能。
20. **打包数据目录**：源码模式默认 `data\`，SEA 默认 `%LOCALAPPDATA%\心语`；测试务必用 `HEARTECHO_DATA_DIR` 隔离。

---

*本文档用于交接；实现细节以代码与 v1.1 任务书为准。任何涉及真实 QQ 账号、模型费用、用户数据、用户正在运行的实例的操作，先征得用户确认。*

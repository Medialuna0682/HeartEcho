# 插件与技能（扩展）

心语 1.2 起内置了一套扩展系统：把「插件 / 技能」包放进 `extensions/`，它们就能：

- 在系统提示词里加一段自己的规矩（**提示词片段**）
- 在每轮对话的关键节点插一脚（**钩子**）
- 给模型注册可以自己调用的能力（**工具**，function calling）
- 向核心提供某个能力实现（**能力提供者**，例如「同一个人连发时要等他说完」）

这套系统是从公开的 **QQ Agent 0.4** 扩展生态移植/兼容过来的：`extensions/` 下的 16 个包
原本是给 QQ Agent 写的，已按心语的目录、发送通道与数据模型完成适配，行为、提示词、
工具 id/描述、设置项都保持原样。契约细节见代码注释与 `docs/扩展宿主契约.md`（本地文档）。

---

## 一、插件和技能有什么区别？

| | 插件（`extensions/plugins/`） | 技能（`extensions/skills/`） |
| --- | --- | --- |
| 判据 | 规则能写死、该不该发生不靠模型判断 | 需要理解人话，交不交给模型由它自己决定 |
| 能做什么 | 钩子、能力提供者、定时器、给模型注册工具 | 给模型注册工具 + 提示词片段 |
| 例子 | 好感度记账、连发合并、按群统计花费、自己上网 | 小本本、去 AI 味、搜图/配图、空间说说 |

两者在宿主眼里是同一套机制（同一份清单格式、同一个 `setup(api)`、同一套 hooks/providers），
区别只是约定俗成的目录语义。

## 二、面板里怎么用

控制面板左侧新增 **「插件与技能」**：

- 每个扩展一张卡片：名称、版本、作者、说明、工具列表、运行状态（运行中 / 不可用 / 已停用）。
- 右上角开关：**停用/启用即时生效**（不用重启心语）。停用会清掉它的工具、提示词片段、钩子和定时器。
- 展开「设置」按 manifest 的 `configSchema` 生成表单，保存即时生效（扩展每次执行时现读设置）。
- 页面顶部是全局开关：**允许模型调用扩展工具（function calling）** 和 **一轮最多几轮工具调用**。
  关掉工具调用后，提示词片段与钩子仍然生效，只是模型不能自己动手（记账/发图/查数据）。

扩展数据都在 `<数据目录>/extensions/<扩展id>/` 下，删掉对应目录就等于重置那个扩展。

## 三、内置的 16 个扩展

### 插件（6）

| id | 名称 | 做什么 | 默认 |
| --- | --- | --- | --- |
| `affinity` | 群友好感度 | 按发言/@/接话记分，等级 陌生→眼熟→熟人→老友→挚友；群友可查排行，主人可自然语言调设定 | 开 |
| `burst-merge` | 连发合并 | 同一个人连发多条时把响应倒计时往后推（封顶 4/6/8/12 秒或关），等他停了再一起看 | 开 |
| `context-chime` | 上下文插话判定 | 没被 @ 时用一次极短模型调用判断「这句该不该接」；带冷却/日上限/群黑白名单 | 开 |
| `cross-chat-link` | 跨会话认人 | 把她对同一个人的跨群/私聊印象汇总成一张人物卡带进提示词，并提示「私聊内容别在群里说」 | 开 |
| `group-cost-report` | 群友花费统计 | 群里有人要「金额统计」时按触发人分摊这个群的 token/花费，报告由代码生成、工具直接发群 | 开 |
| `self-surf` | 自己上网 | 没人说话时按随机间隔自己上网查点东西，再用自己的话发给指定会话；带静默时段/域名黑名单 | 开 |

### 技能（10）

| id | 名称 | 给模型的工具 | 默认 |
| --- | --- | --- | --- |
| `ledger` | 小本本（人情账） | `ledger__add_record/query_records/settle_records/remove_record` | 开 |
| `deai-flavor` | 去除 AI 味 | `deai-flavor__deai_check`（禁用词/套路句式/句长/密度分级） | 开 |
| `meme-taste` | 表情品味 | `meme-taste__collect_sticker/sticker_taste/sticker_my_stickers` | 开 |
| `reply-meme` | 回复配图·梗鲸 | `reply-meme__find_meme`（按语气/情绪从图库挑表情包并发出去） | 开 |
| `smart-image` | 智能配图 | `smart-image__find_image`（pixiv → 360 → 百度 → 必应 → 随机图兜底） | 开 |
| `search-image` | 搜图发图 | `search-image__search_image`（apihz 接口，需要自己填 ID/KEY） | 关 |
| `qzone` | QQ 空间 | `qzone__publish_qzone_post / qzone_check_comments / qzone_reply_comment / pick_qzone_meme / fetch_qzone_topics / qzone_status` | 开 |
| `qq-self` | 空间与个人资料 | `qq-self__get_self_state / publish_dynamic / update_profile / set_avatar` | 关 |
| `api-beggar` | API 余额告急乞讨 | `api-beggar__check_balance`（关键词触发，低于阈值才开口） | 开 |
| `agent-reach` | Agent Reach | `agent-reach__web_read/bili_search/rss_read/reach_doctor`（读网页/搜 B 站/读 RSS） | 开 |

> `qzone` 与心语自带的「QQ 空间」功能**并存但互不感知**：内置模块是草稿审核 + 定时任务
> （默认关闭，可见性默认 `1` 所有人），本技能是模型自主发/回（可见性写死好友 `4`）。
> 两个都开时建议把内置的 `autoPost.ugcRight` 设成 `4`，避免一个公开一个好友可见不一致。
> `qq-self` 的「发动态」与 `qzone` 技能功能重叠，二选一即可（默认只开 qzone）。

## 四、她的一轮对话现在多了什么

```
消息进来
  → 群聚批 / 私聊防抖（可被 burst-merge 续期）
  → 准入判定（没被叫到时问 context-chime「该不该接」）
  → 扩展 before-context 钩子（好感度记账、跨会话人物卡、统计任务识别）
  → 组提示词：静态/动态提示词片段按 priority 降序注入系统提示词末尾【可用技能】
  → before-llm-messages 钩子（可原地改写 messages，比如注入「这轮只做花费统计」）
  → 工具调用循环：模型 tool_calls → 宿主执行（before-tool/after-tool 钩子）→ 结果回填
       → 最多 6 轮，模型不支持 tools 时自动降级为纯聊天
  → after-response 钩子（可清空正文，避免「工具已经发过」再补一句）
  → 正常拆气泡发送
  → 会话记录落盘（data/extensions/sessions/<id>.json，供花费统计等扩展读）
```

额外约束（都是踩坑换来的）：

- 扩展钩子**禁网禁发**，单钩子 5 秒超时、异常隔离，一个扩展坏了不影响别人。
- 工具**串行**执行（扩展工具可能有副作用）；单工具默认 30 秒超时，扩展可声明 `timeoutMs`（上限 180 秒）。
- 工具结果默认 8000 字截断，扩展可声明 `maxResultChars`（上限 3 万字）。
- 扩展只能往**当前会话**发消息（`ctx.sender`），跨会话发送会被拒绝；自主发送（如 self-surf）
  必须走设置里填的目标会话并自己做格式校验。

## 五、安全边界（重要）

- **网络只走 `api.fetch`**：只对 manifest 声明了 `permissions:["web_fetch"]` 的扩展开放；
  宿主统一挡内网/本机地址（SSRF）、20 秒超时、响应体上限 8 MB、UA 大小写合并。
- **发送只走 `ctx.sender`**：与正常回复共用出站表、幂等键、发送前检查（黑名单/暂停）。
- **文件只写数据目录**：扩展只允许写 `data/extensions/<id>/` 下；不读环境变量里的密钥。
- **没有沙箱**：扩展是进程内 ESM 代码。`permissions` 只控制 `api.fetch` 这一个入口，
  它不能阻止 `import fs`、全局 `fetch` 或 `child_process`。`tools/security-test.mjs` 会扫描
  `extensions/` 下是否有 `child_process`、`require`、裸 `fetch(`、可执行文件等红线，
  但这只是**回归检查**，不是安全隔离。
- 因此：**只安装你信任来源的扩展**。不要把别人的扩展包直接丢进 `extensions/` 就启动。

## 六、来源与许可（请阅读）

- `extensions/` 下 16 个包由用户提供的「QQ Agent」扩展素材移植而来。QQ Agent 0.4 是公开项目
  （上游仓库 `K0nd1us/QQ-agent`，扩展文档在 `0.4/doc/extend_development/`），每个包的作者
  写在各自 manifest 的 `author` 字段里。
- **原始素材没有附带 LICENSE 文件**。这些包按「用户提供的素材」移植进本仓库，其版权仍归
  各自作者。**在公开分发（发布仓库、打包成 exe 给别人）之前，请先确认每个扩展作者的授权**；
  如果无法确认，删除 `extensions/plugins|skills/` 下对应目录即可（心语会照常启动，只是少了
  那部分能力），再把 `extensions/README.md` 里的对应行去掉。
- 心语本体（`lib/`、`index.mjs`、`tools/`、面板）仍是 AGPL-3.0；第三方扩展不在心语的
  AGPL 范围内。

## 七、目录与契约

```
extensions/
├── plugins/<id>/{plugin.json,index.js,test.mjs,lib/...}
├── skills/<id>/{skill.json,index.js,test.mjs,lib/...}
└── src/                      ← 兼容层（宿主提供）：扩展写 ../../src/config.js 等
    ├── config.js             DATA_DIR / getConfig / updateConfig
    ├── prompt.js             appendDynamicTail(messages, text)
    ├── llm.js                chatCompletion（判定类小模型调用）
    ├── model-prices.js       价格查询
    ├── tool-registry.js      工具可用性
    ├── skills/config.js      getSkillConfig(id)
    ├── safe-fetch.js         validateImageUrl / validateFetchUrl
    ├── sticker-manager.js    localStickerPath
    └── logger.js             logger(id)
```

扩展入口约定（详见每个包开头的注释）：

```js
export function setup(api) {           // 必须：在这里 registerTool
  api.registerTool({ id, name, description, parameters, async execute(ctx, args) {} });
}
export function available() { return { ok: true }; }   // 可选，同步
export const hooks = { 'before-context'(){}, 'before-llm-messages'(){}, ... };
export const providers = { 'wake.burst-policy'(){}, 'reply.interest-judge'(){}, ... };
export function promptSections(ctx) { return [{ id, title, priority, content }]; }  // 可选
export function activate() {} / export function deactivate() {}                     // 定时器插件
```

清单（`plugin.json` / `skill.json`）字段：`id / name / version / apiVersion / category /
description / author / enabledByDefault / entry / settings / configSchema / prompt / permissions /
capabilities / requires`。

## 八、加一个新扩展

1. 在 `extensions/plugins/<id>/` 或 `extensions/skills/<id>/` 放清单 + 入口（ESM `.js`，
   不要顶层 await、不要 `?v=` 的 import、网络走 `api.fetch`、数据写 `DATA_DIR/<id>/`）。
2. 源目录必须和清单 `id` 同名；入口默认 `index.js`（清单 `entry` 可改）。
3. 写 `test.mjs`（导出 `cases: [{ name, run: async (t) => {...} }]`），跑：
   `node tools/extensions-test.mjs --only <id>`。
4. 重新生成打包注册表：`node tools/gen-extensions.mjs`（打包 exe 时会自动执行）。
5. 运行 `node tools/selftest.mjs` 与 `node --test tools/security-test.mjs` 确认没破坏边界。

开发时直接 `node index.mjs` 启动即可（源码模式会扫描磁盘，改完重启生效）。
打包成 exe 后扩展会被打进单文件，运行时不依赖 `extensions/` 目录。

## 九、已知取舍

- 工具循环最多 6 轮（面板可调 1–12），模型犟着不肯收尾时按最后一次输出收尾。
- 模型接口不支持 function calling 时会自动去掉 tools 重试，本进程内不再尝试；
  面板会保留「工具调用」开关，但实际以接口能力为准。
- 没有热重载：改扩展代码/清单需要重启心语（打包版天然如此）。
- 会话记录文件按 3000 个滚动清理；花费统计默认只读最近 400 个会话。
- `ctx.session.sent` 没有实现（发送留档在消息表/出站表里），依赖它的少数展示会降级为 no-op。

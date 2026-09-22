# dsh-qq-bridge · QQ ↔ DSH 单插件桥接

> 在 QQ 里私聊机器人 = 坐在电脑前操作 DSH：接入任意历史会话、继续对话、只收到最终答复。
> **单插件方案**：QQ 客户端（WSS 长连接 + 私聊）与 DSH 会话驱动全部收进一个 DSH 插件，
> 无网关、无 HTTP 桥、无外部代码；配置从 DSH 设置页完成。
>
> 本机 DSH 为 **Windows 原生安装**（`$env:DSH_HOME\profiles\web\`），QQ 长连接直接在
> Windows 原生进程内运行，不经 WSL、无网络绕路。

## 特性

- **单插件、单进程**：QQ 官方机器人 API（WSS 长连接 + C2C 私聊）+ DSH 会话驱动全在插件内。
- **设置页配置（改动即自动保存）**：`设置 → QQ 桥接` 填写 `appId / appSecret`、切换沙箱、打开「启用」开关即启动；开关点完立刻生效、文本框停止输入 0.7s 生效、密文框失焦生效——不需要点保存按钮。
- **会话状态推送**：打开「QQ接受会话完成状态」后，任何主会话**跑完一轮**推 `[会话名]已完成`、**卡在等你选择/审批**推 `[会话名]在等你选择：…` / `[会话名]需要审批：…`（QQ 正在聊的那个会话不重复推，子会话不推）——人不在电脑前也知道任务跑完了、或卡在等你。
- **只回最终文本**：从最终 `assistant/message` 的 `content` 里过滤 `type==='text'` 的块，reasoning / tool-call 不外泄。
- **QQ 审批**：QQ 驱动的会话审批策略为 `'ask'`；需审批的操作（工具/原因/参数）会以 QQ 消息推送，回复 `/approve`（允许一次）或 `/deny`（拒绝）决定，超时自动拒绝；非 QQ 会话仍交给 Web UI answerer。
- **会话可达**：`/会话` 列出全部持久化会话（`sessionQuery.listSessions()`，零 zstd 手写解码），短 ID 接入。
- **会话模式**：`/new <工作区号> mode=<模式>` 直接建「创造模式」等指定 agent preset 的会话；`/new` 的提示里会列出可用模式与 id。
- **零依赖**：仅 Node 内置 + `@deepseek-ai/schemastery`（随 DSH 提供）。

## 环境要求

- DSH 当前版本（0.1.5-rc.1 服务层：`sessionController` / `sessionQuery` / `sessions` / `approval` / `settings`）。
- Node ≥ 22（全局 `fetch` / `WebSocket`）。
- QQ 开放平台机器人：已开通 **C2C 单聊 + WSS 长连接** 事件；机器人的外网 IP 已加入平台白名单（或先用 **沙箱** 环境联调）。

## 部署（原生 Windows，重启生效）

> ✅ **本次已代做前两步**：插件（宿主 + 客户端「QQ 桥接」设置分区）已拷贝到 `$env:DSH_HOME\profiles\web\node_modules\dsh-qq-bridge\`，
> `cordis.patch.yml` 已追加 insert 行（原文件已备份为 `cordis.patch.yml.bak-before-qq-bridge-*`）。
> **注意：设置分区由客户端半提供，宿主代码与客户端发现都需要实例重启 + 浏览器硬刷新（Ctrl+F5）才生效。**
> 你只需：**重启实例 + 硬刷新页面 + 填凭证开开关**。

完整步骤（供回滚/移植参考）：

1. **拷贝插件**到 profile 的 node_modules（Windows PowerShell）：
   ```powershell
   Copy-Item -Recurse -Force D:\DSH\design\DSHPlugin-0831\dsh-qq-bridge $env:DSH_HOME\profiles\web\node_modules\dsh-qq-bridge
   ```
2. **注册加载**：编辑 `$env:DSH_HOME\profiles\web\cordis.patch.yml`，末尾追加：
   ```yaml
   - insert:
       - id: dsh-qq-bridge
         name: dsh-qq-bridge
   ```
3. **重启 DSH web 实例**（通过 DshManager 或 `dsh web`），让插件随实例加载。

## 配置（设置页）

重启后，打开 DSH **设置** → **QQ 桥接** 分区：

| 字段 | 说明 |
|---|---|
| `enabled`（开关） | 打开即启动 QQ 长连接；关闭即断开 |
| `appId` | QQ 开放平台机器人的 AppID |
| `appSecret` | 机器人的 AppSecret（设置页以密文输入框呈现） |
| `sandbox`（开关） | 勾选走沙箱环境 `sandbox.api.sgroup.qq.com`（联调用） |
| `chatTimeoutMs` | 单轮超时（毫秒），默认 300000（5 分钟） |
| `steer`（开关） | 开：工作期间的消息直接插话进当前会话；关：排队 |
| `notifyOnComplete`（开关） | **QQ接受会话完成状态**：打开后「会话完成 / 等你选择 / 等你审批」都推一条 QQ 通知（详见下节） |

> 没有「新建会话工作区」这个设置了。
> 兜底新建（QQ 里直接说话、还没接入任何会话）落在**最近活跃的工作区**——与 `/new` 列表同源
> （`workspaceList()`：从历史会话取 cwd、排除已删与目录已不存在的、按最近创建倒序），并记账进
> Workspace Registry 让 Web UI 能归组；**一个可用工作区都没有时**才交给 DSH 默认
> （`session-controller`：`cwd = workspace?.path ?? request.cwd ?? defaultCwd`，`defaultCwd = process.cwd()`；
> 本机启动器没给子进程指定 cwd，所以那是启动器安装目录 `D:\Program Files\dsh-launcher`）。
> 想明确指定项目就用 `/new` 选工作区。

#### 消息推送内容（4 个勾选框）

设置页里一个独立的框，逐类控制哪些**过程消息**推到 QQ（最终回复不受影响，始终推）：

| 勾选项 | key | 推什么 | 默认 |
|---|---|---|---|
| 待办清单 | `pushTodo` | `📋 待办 2/9 · 正在做：…` + ✅/▶/⬜ 逐条 | ✅ |
| 交付清单 | `pushDeliverable` | `📎 交付 3 个文件` + 文件名（末三段）+ 说明（**只有清单，不含文件本体**） | ✅ |
| 工具调用 | `pushToolCall` | 每次工具调用一行 `🔧 名称 + 参数`（最吵的一项） | ✅ |
| 旁白 | `pushNarration` | 动手前的过场话 `💬 …`（中间结论常在这里） | ✅ |

- 只推给**接入该会话的那个 QQ 用户**（`openidForSession`），别的会话/别人不受影响。
- 取消勾选立刻生效（设置页改动即自动保存），不需要重启实例、也不会断 QQ 连接。
- **勾选项之间互不影响，也都不管文件本体**：以「交付清单」为例 —— 勾上只多一条 `📎` 文本，
  取消勾选只是少了这条文本；文件发不发跟它无关（见下节，只由"你点名要 + 模型调 `qq_send_file`"决定）。
- **文件本体不在这个框里**：只有你点名要文件时才会发（见下节）。

### 按需发文件：`qq_send_file` 工具（不自动发）

**语义**：`present` 只负责"声明这是本次交付物"（GUI 交付区 + 一条 📎 清单），**插件不会把文件推给 QQ**。
只有当你**明确要求**（"把这份报告发我 QQ"）时，模型才调 `qq_send_file({ paths: [...] })` 把**指定文件**发出去。
这样插件开发的中间产物（源码、测试、字段探针）不会往手机上灌。

- **接口链路**：`POST /v2/users/{openid}/upload_prepare`（带 file_type / file_size / file_name / md5 / sha1 / md5_10m）
  → 逐片 `PUT` 到预签名 URL → `POST .../upload_part_finish` → `POST /v2/users/{openid}/files`（带 `upload_id` 合并拿 `file_info`）
  → `POST .../messages` 以 `msg_type=7` + `media.file_info` 发送。
- **为什么用分片**：官方文档明说分片路径"适用于大文件或**本地文件**"——不要求文件有公网 URL（我们实例在 127.0.0.1，URL 直传那条路走不通）。
- **类型与限额**（官方 2026-07 概述页）：`1 图片`(png/jpg/gif/webp/bmp，软限 20MB)、`2 视频`(mp4，30MB)、
  `3 语音`(silk/mp3/wav/ogg，20MB)、`4 文件`(任意格式，200MB)；**硬限统一 200MB**，超过软限官方会自动降级为文件。
  发图片/视频/语音在 QQ 里直接展示，其余是文件卡片。
- 一次最多 **5 个**文件；超过 200MB 的不发，工具结果里会说明（文件仍在电脑上）。
- 发送结果逐条回报（`✓ 文件名（大小）` / `✗ 原因`），官方错误码也会写进日志。
- **两个实测坑**（已修，官方文档没写清）：合并那一步**必须带 `srv_send_msg` 和 `file_name`**；分片 `index` 是
  **1 基**（预签名 URL 是 `part_1`），不能拿它当字节偏移（否则切出空分片 → `part_finish` 报 40093001 → 合并 40093006）。

### 通路自觉：用户说"发给我"时怎么选路

**插件不替模型决定通路**（也不自动外发任何产物）。判断权在模型，依据是插件落盘的一个事实：

```
%DSH_HOME%\bridge\qq-last-inbound.json
{ "sessionId": "session-…", "channel": "qq" | "web", "at": 1790…, "text": "消息前 40 字" }
```

- 每来一条**用户消息**（`user/message` 且 `source.kind === 'user'`）就刷新一次；
- `channel` 的判据是 `source.clientTimeZone`：**浏览器 prompt 必带**（harness 的 per-prompt 时区采样），
  QQ 桥接的 `sessionController.prompt()` 不带 → `web` / `qq`；
- 于是模型在收到"把 X 发我"时读一次这个文件：`sessionId` 与当前会话一致且 `channel === 'qq'`
  → 调 `qq_send_file`（文件）/ `qq_send`（文本）；否则（GUI）→ `present` + 路径链接。
- **为什么不用 openid 绑定判断**：绑定是持久关系，用户在 GUI 里打字时 QQ 照样绑着这个会话 ——
  绑定 ≠ 当前通路，这条路走错过。

### 主动发消息：`qq_send` 工具

模型侧多了一个工具 `qq_send({ text })`：你说「给我发条 QQ 消息 / 提醒我一下」时，模型**直接调用它**，
插件把消息推给**本会话接入的那个 QQ 用户**（就是你）——不用模型自己判断"该走哪条通路"。
发**文件**用同族的 `qq_send_file({ paths })`（见上节：同一条收件人解析与限额规则）。

- 注册方式：官方 `@deepseek-ai/dsh-tools` 的 `defineTool` + `ctx.tools.register()`（context-global，模板见 `dsh-tool-present`）；
  用**动态 import + catch**，万一该包缺失，只是少一个工具，桥接照常工作。
- 收件人解析三级：① 本会话接入的 QQ 用户 → ② 沿 `parentSession` 上溯（子会话/子代理里调用）→
  ③ 只有一个已知用户时兜底用他；**有多个已知用户且本会话未接入时直接拒绝**，绝不乱发。
- 防线：桥接未启用（`BOT.running === false`）/ 内容为空 → 明确报错；超过 **2000 字**自动截断。
- 发送走桥接自己的 `sendText`（统一 token 缓存与日志），日志里会留一行 `qq_send → <openid前8位>…（N 字，来源）`。
- 注意：它发的是**主动消息**，占用 QQ 的主动消息频次（和"会话完成"通知同一类额度）。

### 会话状态推送（`QQ接受会话完成状态`）

打开后，三种「这个会话需要你知道」的情况都会推给 QQ，文本统一是 `[会话名]<状态>`：

| 情况 | 推送文本 | 触发点 |
|---|---|---|
| 跑完一轮 | `[会话名]已完成` | `turn/end` 且 `reason.kind === 'completed'` |
| 卡在等你选 | `[会话名]在等你选择：<问题前 40 字>` | `ask_user_question`（`user-questions/request`） |
| 卡在等你批 | `[会话名]需要审批：<工具名>（<原因>）` | 审批请求（`approval/request`） |

- **中断 / 报错 / 超时不推**：只有 `reason.kind === 'completed'` 才算完成；`aborted` / `interrupted` / `error`
  在 Web UI 里有明确状态，不需要手机提示。
- **QQ 正在聊的那个会话不推**：那个用户已经被告知了——完成时正文由回复观察器直接回，
  问答/审批时问题/审批本身就是直接发到 QQ 让他答的；其他 QQ 用户、其他会话照常推。
- **子会话 / subagent 不推**：带 `parentSession`、`origin === 'subagent'` 或 `delegationDepth >= 1` 的会话
  一律跳过，否则一个 workflow 能刷出几十条。
- **等待类通知只是"喊你去电脑前"**：问答/审批的作答仍然只能在 Web UI 里做 ——
  QQ 里能直接作答的只有你当前接入的那个会话（老功能）。通知先到、你再到电脑前处理。
- **会话名**取 `session/title` 事件（DSH 自动生成的首问标题），取不到时退到标题快照 →
  `工作区 <目录名>` → 会话短 ID。
- 通知串行发送（不并发，避免触发 QQ 频控）；机器人未运行时直接丢弃、不排队。

### 定时推送：`qq_schedule` 工具 + `/提醒` 命令

模型侧有 `qq_schedule` 工具，QQ 侧有 `/提醒` 命令 —— 于是"以后每天 8 点提醒我喝水"这类要求可以真正落地。
落盘在 `%DSH_HOME%\bridge\qq-schedule.json`，**跨实例重启保留**。

| 用法 | 说明 |
|---|---|
| `qq_schedule({ action: 'create', text: '喝水', inMinutes: 30 })` | N 分钟后推一次固定文本（一次性） |
| `qq_schedule({ action: 'create', text: '该睡了', atTime: '23:30' })` | 每天 23:30 推（`repeat` 可 `daily` / `weekdays` / `once`，默认 `daily`） |
| `qq_schedule({ action: 'create', prompt: '总结今天的待办', atTime: '08:00' })` | 到点**让 agent 干活**：默认在**一次性无头会话**里跑（落在创建任务的工作区并归组），答案由回复观察器推回 QQ |
| `qq_schedule({ action: 'create', prompt: '…', session: 'current' })` | 同上，但回到**创建它的那个会话**里跑（需要那边的上下文时才用） |
| `qq_schedule({ action: 'list' })` / `/提醒` | 列出任务（含下次触发时间、无头/当前会话标记） |
| `qq_schedule({ action: 'cancel', id: 'a1b2' })` / `/提醒 删 a1b2` | 取消任务 |

**执行落点（prompt 任务）**：默认 `session: 'new'` —— 每次触发**新建一个一次性无头会话**，cwd 取
**创建任务时所在会话的工作区**，并记账进 Workspace Registry（Web UI 里归到那个工作区）。这样任务
**不依赖你的对话会话**（那份会话归档/删掉也不影响），代价是每次空白起步、会多一条会话记录。
需要延续上下文时用 `session: 'current'`。配套：交付文件、审批、问答的收件人都回退到「本轮 run 的 openid」
（`ownerOpenidForSession`），所以无头会话里 `present` 的文件、甚至需要审批的操作，都会找到你。

- **触发方式**：插件内 20s 扫一次（`setInterval`），任务先排下一次/摘除再执行 —— 触发中崩了也不会重复刷。
- **漏发补发**：实例当时没开 → 启动时补发一次；一次性任务过期超过 **24h** 就丢弃，免得开机刷出一堆过期提醒。
- **上限与校验**：最多 50 个任务；`inMinutes` ≥ 1；文本 ≤ 2000 字；`text` 与 `prompt` 二选一；`atTime` 必须 `"HH:MM"`。
- 前提：**到点那一刻实例在运行**（插件活在实例里）。要"实例关着也发"，得挂系统计划任务（本机沙箱里我建不了，见下）。
- 定时推送同样是**主动消息**，吃 QQ 的主动消息频次。

### 收图：从 QQ 发图片给我

QQ 单聊事件里图片在 `attachments[]`（`content_type` / `url` / `size` / `width` / `height`），**纯图片消息的文本 `content` 是空的**
—— 旧代码只看 `content`，于是**静默丢弃**（连日志都不打）。现在：

- `pickImageAttachments()` 挑出可用的图片（`png`/`jpeg`/`webp`/`gif`，单个 ≤ **10MB**），其余（语音/视频/文件/超限/缺链接）
  归类成一句说明并进 prompt 文本 —— 不再有"什么都没发生"的情况；
- 图片**下载成 base64**（QQ 的 CDN 链接有时效，收到就下），作为 DSH prompt 的 `image` 内容块提交
  （`{ type:'image', mediaType, data, name }`），所以我能在会话里真的看见它、也能用 `read_image` 细看；
- 下载失败会**明确回一条 QQ 消息**（`⚠️ 图片没收到（原因）…`），而不是静默；
- 纯图片消息（没有文字）现在会正常触发一轮对话。

### QQ 文本排版

实测（2026-09-22，本机机器人 `1905522138`，两条探针截图确认）：单聊 **`msg_type=2` markdown 不只被 API 接受（HTTP 200），在手机 QQ 上正常渲染**：

| 语法 | 实测 | 备注 |
|---|---|---|
| `#` / `##` 标题 | ✅ 加粗放大 | |
| `**加粗**` / `_斜体_` / `~~删除线~~` | ✅ | |
| `1.` 有序、`-` 无序列表 | ✅ | |
| `> 引用块`、`***` 分割线 | ✅ | |
| `[文字](url)` 链接 | ✅ 蓝色可点 | |
| **表格** `\| a \| b \|` | ✅ **渲染成带边框/对齐的表格** | 官方语法清单里没写，实测可用 |
| 行内代码 `` `x` `` | ✅ 灰底高亮 | |

- 文本消息没有 1024 那种硬限制：实测 1199 字、3215 字都被接受；插件按空行分片（每片 ≤ **8000 字**），
  某片若仍被接口拒（"太大"）会**自动二分重试**（下限 500 字），**绝不整条丢**。
- **未实测**：代码围栏 ```` ``` ````（要确认可发一条探针）、图片 `![](url)`（文档说支持，需公网可访问 URL）。
- 排版**内置生效**（没有开关）：所有回复都走 `msg_type=2` + `markdown.content`，
  **发送失败自动降级纯文本重发**（不会因为某个机器人没开通 markdown 就丢回复）。
- 长文本**按空行分片**（每片 ≤ 8000 字；被拒则二分重试）分多条发，**不截断**；`msg_id` 只挂第一条（被动回复的
  `msg_id`+`msg_seq` 组合不能重复）。
- 旁白（`💬`）**不做任何字数限制**（按用户要求，原样透传；超长由上面那套分片/二分兜底）。
- 我在 QQ 通路上写回复时的自我约束：
    - 排版一直可用：`##` 小标题、`**加粗**`、列表、**表格**、行内代码（路径/命令）都可用 ——
      表格优先用于"字段→值"这类结构化信息；代码围栏暂不用（未实测）；
    - 先给结论，再给细节；一条消息尽量控制在手机一两屏内，长的按段拆。

### 会话权限：`/权限` 命令

harness 的权限是**预设制**：一个预设 = `sandbox`（`read-only` / `workspace-write` / `danger-full-access`）
+ `approval`（`ask` / `never`）两个旋钮一起切，官方写入路径是 `ctx.permissionPresets.set(session, name)`。

| 用法 | 说明 |
|---|---|
| `/权限` | 显示当前会话的预设名 + 两个旋钮的实际值 + 可切换的预设列表 |
| `/权限 danger-full-access` | 切到完全访问（sandbox=danger-full-access，approval=never） |
| `/权限 重置` | 回默认预设 + `approval=ask`（审批推回 QQ） |

两个设计要点：

1. **只做人类指令，不做模型工具** —— 没给模型留任何"给自己提权"的调用口（测试里也断言了这一点）。
2. **不会被下一句话打回**：桥接原来每条 QQ 消息都把 `approval` 强制成 `ask`（fail-closed），那会让 `/权限`
   白做；现在改成**用户明确切过预设的会话不再覆盖**（记忆在 `state.permPreset`，`/权限 重置` 时清除）。
   新会话、以及没切过的老会话，仍然保持 `approval=ask`。

当前部署的预设（服务默认）：`workspace-write`（sandbox=workspace-write, approval=ask）、
`danger-full-access`（sandbox=danger-full-access, approval=never）；若还配了 auto 集成，`/权限` 会一并列出 `auto`。

### 自动保存（没有任何保存按钮）

| 控件 | 提交时机 |
|---|---|
| 开关 / 勾选框（启用 / 沙箱 / 插话 / 完成通知 / 消息推送内容的四项） | 点击后**立刻**提交 |
| 文本框、数字框（`appId` / `chatTimeoutMs`） | 停止输入 **700ms** 后提交；失焦或回车立即提交 |
| `appSecret` | **失焦或回车**提交（避免半截密文写进宿主、触发无谓重启） |

- 只提交**真正变化的键**：值改回原样不会发请求，避免无谓重启。
- 提交成功后状态行显示「已自动保存 HH:MM:SS」；失败会自动重试两次（2s / 5s），仍失败则红字提示，改动留在待提交队列，继续编辑或让输入框失焦会再次提交。
- **没有保存按钮**：整个分区只有自动保存这一条路（失败也有自动重试兜底）。
- 提交在飞时又有改动 → 本轮结束后自动续传；分区被卸载（切走设置页 / 客户端半热更）时也会把未提交的改动送出去。

其中**只有连接参数**（`enabled` / `appId` / `appSecret` / `sandbox`）变化才启停/重启 QQ 长连接；
`chatTimeoutMs` / `steer` / `notifyOnComplete` / `pushTodo` / `pushDeliverable` / `pushToolCall` / `pushNarration`
都是运行时 `readCfg()` 实时读取的，改它们不会再断一次 QQ 连接。（这条免重启判断在宿主半 `lib/index.js`，需要实例重启一次才生效。）

### 过程推送：旁白（`💬`）/ 待办（`📋`）/ 交付（`📎`）/ 工具行（`🔧`）

接入 QQ 的那个会话会把过程实时发到 QQ（只推给接入它的那个 QQ 用户）。**每一类都由「消息推送内容」里对应的勾选框控制**：

| 事件 | QQ 上看到 | 控制它的勾选项 |
|---|---|---|
| `assistant/message`（有正文 + 在调工具） | `💬 明白了，我用提问工具发给你…` | 旁白 `pushNarration`（**不截断**；中间结论/判断一般在这里） |
| `todo/write` | `📋 待办 2/9 · 正在做：…` + `✅/▶/⬜` 逐条 | 待办清单 `pushTodo`（最多 15 条，单条截 50 字；清单没变不重复推） |
| `deliverables/presented` | `📎 交付 3 个文件` + `· 末三段路径 — 说明` | 交付清单 `pushDeliverable`（最多 12 个） |
| `tool/call` | `🔧 grep {"path": …}` | 工具调用 `pushToolCall`（参数截 120 字） |
| `tool/call`（`todo_write` / `present`） | 不推 `🔧` 那行 | — 上面两条 `📋`/`📎` 已经说清楚了，不重复刷 JSON |
| `assistant/message`（只有正文，没有工具调用） | 不单独推 | — 那是本轮最终正文，由回复观察器在轮末发一次，避免同一段话发两遍 |

（消息按 0.6s 串行发送防频控；旁白/清单不进「本轮已执行的工具调用」清单，超时/中断回放时不会混进去。）

## 用法（QQ 私聊机器人）

| 输入 | 效果 |
|---|---|
| 普通消息 | 发给当前接入的会话；未接入则**自动新建会话**并返回结果 |
| `/帮助` | 指令帮助 |
| `/profile` | 查看运行中的 DSH 实例（本插件绑定当前实例） |
| `/会话` | 列出会话（按工作区、创建时间倒序，标题/提问轮数/预设）；会话用 **4 位短 ID** |
| `/会话 <4位ID>` | 接入某个会话，之后消息续聊该会话（ID 固定，跨重启不变） |
| `/实例 <端口>` | 查看实例；跨实例对话请回 Web UI |
| `/状态` | 全链路体检（插件/QQ 连接/实例/会话数） |
| `/new` | 列出工作区 + 可用会话模式（序号/显示名/id）→ 回数字选工作区，新建会话并接入 |
| `/new <工作区号> mode=<模式>` | 在该工作区新建**指定模式**的会话（模式写序号或 id，如 `mode=4` / `mode=cordis`；不填 = 默认模式） |
| `/approve` | 允许当前会话的待审批请求（需审批操作会推送 `🔐` 详情） |
| `/deny` | 拒绝待审批请求 |
| `/跳过` | 跳过待回答的问题 |
| `/提醒` | 列出定时推送任务（`/提醒 删 <ID>` 取消） |
| `/权限` | 查看当前会话权限；`/权限 <预设名>` 切换（如 `danger-full-access`）；`/权限 重置` 回默认 |

等待期间 QQ 会显示「正在输入…」（`msg_type:6`，5 秒续发），不占消息配额。
指令（`/` 开头）**立即处理**，不会被正在进行的对话串行阻塞（审批/问答/状态等可在对话中途响应）。

**会话模式**（= DSH 的 agent preset，与 Web UI 的「Agent 模式」同一份名单）：`/new` 的提示会列出
「序号 + 显示名 + id」，序号与 Web UI 选择器一致（由各 preset 的 `order` 决定，自定义 preset 排在末尾），
也可以直接写 id（如 `mode=cordis`）。序号越界 / 未知 id / 拼错选项都会回一条带可用清单的错误，不会静默失败。

## 午休后验收清单（重启后照此核对）

1. **启动日志**：实例日志出现
   `[qq-bridge] 已加载（web:3080）…`、`[qq-bridge] 启动：正式/沙箱环境`、
   `[qq-bridge] WS 已连接 <gateway-url>`、`[qq-bridge] WS READY…`。
   若没有，先到设置页确认「启用」已打开且 appId/appSecret 已填。
2. **QQ 发 `/状态`**：应回 `QQ: 已连接 ✓`、实例、liveAgents、会话数。
3. **QQ 发 `/帮助`**：应回指令列表。
4. **QQ 发普通消息**（未接入会话）：应「正在输入…」后返回最终答复；
   回到 Web UI，新会话应在列表里。
5. **接入历史会话**：`/会话` → 挑一条 → `/会话 <ID>` → 追问，应能继续原上下文。
6. **信息纯度**：回复里不应出现思考过程、工具调用痕迹。
7. **QQ 审批**：让模型做一件需审批的事（如删除文件），QQ 应收到 `🔐 需要你的审批` 推送（含工具/原因/参数）；回 `/approve` 后操作应继续，回 `/deny` 应被拒绝；超时（默认 5 分钟）自动拒绝。
8. **QQ 问答**：让模型问一个问题（计划评审/选择类），QQ 应收到 `❓ 需要你回答` 推送（题面+编号选项）；**直接输入任意文本**即作为自由回答提交，回 `/跳过` 跳过。
9. **会话模式**：`/new` 应列出工作区 + 模式清单（`1 标准模式 standard ←默认` …）；`/new 1 mode=4` 的回执里应出现「（创造模式）」；`/new 1 mode=bogus` 应回「未知模式 + 可用清单」；`/new 1 foo=1` 应回「暂不支持的选项」。

### 常见问题

- **设置页没有「QQ 桥接」分区**：确认插件已加载（步骤 1 的日志）；设置分区由客户端半注册（需实例重启 + 浏览器硬刷新 Ctrl+F5）。
- **发普通消息导致整个 DSH 进程退出**：0.3.0 漏传 `sessionController.prompt(request, signal)` 的 `signal`（AbortSignal），DSH 服务边界判为 fatal load failure 直接退出；0.3.1 已修复（prompt 必传 `controller.signal`）。若再现，查实例日志 `dsh: fatal load failure: …` 定位。
- **WS 反复重连**：检查 appId/appSecret 是否正确、机器人是否开通 C2C、是否命中 IP 白名单/沙箱。
- **发消息无回复**：`/状态` 看 QQ 连接与插件状态；再看实例日志 `[qq-bridge] chat 失败: …`。
- **QQ 直接说话新建的会话落在哪儿**：落在**最近活跃的工作区**（`/new` 列表里的第一个）并归组；一个可用工作区都没有时才落到实例进程目录（本机是启动器安装目录 `D:\Program Files\dsh-launcher`）。想明确指定就用 `/new` 选工作区，或在 Web UI 建好后 `/会话 <4位ID>` 接入。
- **回滚**：删掉 `cordis.patch.yml` 末尾 dsh-qq-bridge 的 insert 段（或恢复备份 `cordis.patch.yml.bak-before-qq-bridge-*`），删除 `node_modules\dsh-qq-bridge\`，重启实例。

## 与旧版（双进程）的差异

| 维度 | 旧版（gateway.mjs + 插件，WSL 时代） | 本版（单插件，Windows 原生） |
|---|---|---|
| 进程 | Windows 网关 + WSL 插件 | 仅 DSH 进程（Windows 原生） |
| QQ 长连接 | 在网关 | 在插件（随实例在线） |
| 会话驱动 | 经 HTTP `/v1/chat` | `sessionController` 进程内直连 |
| 会话枚举 | 手写 zstd 解码 | `sessionQuery`（零 zstd） |
| 审批 | `session.append('approval/policy')` | `approval.setPolicy(agent,'ask')` + `approval/request` 瀑布 answerer（QQ 通知，/approve /deny） |
| 配置 | `config.json` + `manage.ps1` | DSH 设置页（appId/secret/启停） |
| 多实例切换 | 支持（registry+HTTP） | 绑定当前实例；跨实例回 Web UI |

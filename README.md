# dsh-qq-bridge · QQ ↔ DSH 单插件桥接

> 在 QQ 里私聊机器人 = 坐在电脑前操作 DSH：接入任意历史会话、继续对话、只收到最终答复。
> **单插件方案**：QQ 客户端（WSS 长连接 + 私聊）与 DSH 会话驱动全部收进一个 DSH 插件，
> 无网关、无 HTTP 桥、无外部代码；配置从 DSH 设置页完成。
>
> 本机 DSH 为 **Windows 原生安装**（`$env:DSH_HOME\profiles\web\`），QQ 长连接直接在
> Windows 原生进程内运行，不经 WSL、无网络绕路。

## 特性

- **单插件、单进程**：QQ 官方机器人 API（WSS 长连接 + C2C 私聊）+ DSH 会话驱动全在插件内。
- **设置页配置**：`设置 → QQ 桥接` 填写 `appId / appSecret`、切换沙箱、打开「启用」开关即启动；改凭证/参数自动重启生效。
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
| `createCwd` | 新建会话的工作区路径（Windows 路径，如 `D:\DSH\design`）；留空则使用 DSH 默认 |

保存设置即触发启停/重启（无需再重启实例，除非首次安装）。

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
- **新建会话不在期望目录**：到设置页填 `createCwd`（Windows 路径）。
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

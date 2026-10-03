// QQ message catalog; sourced from installed dsh-qq-bridge/lib/index.js.
// Pending entries retain stable IDs but are not yet callable, preventing false migration claims.
const catalog = Object.create(null);
const source = { R: 1190, P: 503, N: 1623, I: 2318, T: 1521, A: 388, C: 1688, X: 442 };
for (const [prefix, count] of Object.entries({ R: 7, P: 7, N: 4, I: 13, T: 6, A: 5, C: 80, X: 11 })) {
  for (let n = 1; n <= count; n++) {
    const id = prefix + String(n).padStart(2, '0');
    catalog[id] = { id, category: prefix, channel: prefix === 'X' ? 'diagnostic' : 'direct', sourceLine: source[prefix], description: 'Legacy message not migrated', template: null, migration: 'pending' };
  }
}
for (const id of ['C06a', 'C06b']) catalog[id] = { ...catalog.C06, id, description: 'Legacy message not migrated' };
function put(id, template, sourceLine, description = '', extras = {}) {
  if (!Object.hasOwn(catalog, id)) throw new Error(`Unregistered QQ message ID ${id}`);
  catalog[id] = Object.freeze({ ...catalog[id], template, sourceLine, description,
    migration: template === null ? 'pending' : 'cataloged', ...extras });
}
function add(id, template, sourceLine, description = '') {
  if (Object.hasOwn(catalog, id)) throw new Error(`Duplicate QQ message ID ${id}`);
  catalog[id] = Object.freeze({ id, category: id[0], channel: 'direct', sourceLine, description, template, migration: 'cataloged' });
}
put('R01', null, 1207, 'Model-generated final response', { channel: 'non-template', migration: 'passthrough' });
put('R02', '（空回复）', 1207);
put('R03', '❌ {error}', 1191);
put('R04', '⏹️ 已停止当前工作。', 1194);
put('R05', '⚠️ 处理超时（>{minutes} 分钟）\n本轮可能仍在运行，完成后会自动补发正文。', 1195);
put('R06', ({ steps }) => {
  const lines = [`本轮已执行的工具调用（共 ${steps.length} 步）：`];
  steps.slice(0, 30).forEach((step, i) => lines.push(`  ${i + 1}、${step}`));
  if (steps.length > 30) lines.push(`  …（其余 ${steps.length - 30} 步略）`);
  return lines.join('\n');
}, 1198, 'Tool digest', { required: ['steps'] });
put('R07', ({ body }) => `已完成的部分输出：\n${body || '（无产出）'}`, 1204, 'Partial output; empty body falls back to （无产出）', { optional: ['body'] });
put('P01', '💬 {body}', 382);
put('P02', ({ done, total, current }) => `📋 待办 ${done}/${total}${current ? ` · 正在做：${current}` : ''}`, 512, 'Todo heading, optional current', { required: ['done', 'total'], optional: ['current'] });
put('P03', '{mark} {index}. {content}', 515, 'Todo row; mark is ✅ ▶ ⬜');
put('P04', '…（其余 {count} 项略）', 518);
put('P05', '📎 交付 {count} 个文件', 523);
// Per-file delivery row and overflow remain separate so callers can compose safely.
catalog.P05a = Object.freeze({ id: 'P05a', category: 'P', channel: 'direct', sourceLine: 526, description: 'Deliverable file row', template: ({ path, description }) => `· ${path}${description ? ` — ${description}` : ''}`, migration: 'cataloged', required: ['path'], optional: ['description'] });
put('P06', '…（其余 {count} 个略）', 529);
put('P07', ({ name, preview }) => `🔧 ${name}${preview ? ` ${preview}` : ''}`, 984, 'Tool name and optional truncated preview', { required: ['name'], optional: ['preview'] });
put('N01', '[{sessionName}]已完成', 1623);
put('N02', ({ sessionName, toolName, reason }) => `[${sessionName}]需要审批：${toolName}${reason ? `（${reason}）` : ''}`, 2408, '', { required: ['sessionName', 'toolName'], optional: ['reason'] });
put('N03', ({ sessionName, question, count }) => `[${sessionName}]在等你选择：${question}${count > 1 ? `（共 ${count} 题）` : ''}`, 2500, '', { required: ['sessionName', 'question'], optional: ['count'] });
put('I01', '🔐 需要你的审批（{sessionLabel}）', 2356);
catalog.I02a = Object.freeze({ id: 'I02a', category: 'I', channel: 'direct', sourceLine: 2360, description: 'Approval tool row', template: '工具：{toolName}', migration: 'cataloged' });
catalog.I02b = Object.freeze({ id: 'I02b', category: 'I', channel: 'direct', sourceLine: 2361, description: 'Approval reason row', template: '原因：{reason}', migration: 'cataloged' });
catalog.I02c = Object.freeze({ id: 'I02c', category: 'I', channel: 'direct', sourceLine: 2362, description: 'Approval arguments row', template: '参数：{arguments}', migration: 'cataloged' });
put('I03', '回复 /approve 允许执行一次，/deny 拒绝；桌面原始审批卡也可直接处理（QQ 操作需保持桌面页面打开）。', 2378);
put('I04', ({ summary }) => `✅ QQ 操作已在桌面卡片提交${summary ? `：${summary}` : ''}`, 2324, '', { optional: ['summary'] });
put('I05', ({ summary }) => `✅ 桌面端已处理${summary ? `：${summary}` : ''}`, 2324, '', { optional: ['summary'] });
put('I06', '❓ 需要你回答（{sessionLabel}）', 2452);
put('I07', ({ index, question, detail }) => `${index}、${question}${detail ? `\n　${detail}` : ''}`, 2454, '', { required: ['index', 'question'], optional: ['detail'] });
put('I08', ({ index, label, description }) => `　${index}) ${label}${description ? `（${description}）` : ''}`, 2461, '', { required: ['index', 'label'], optional: ['description'] });
catalog.I08m = Object.freeze({ id: 'I08m', category: 'I', channel: 'direct', sourceLine: 2464, description: 'Multiple-choice hint', template: '　多选：选项号用逗号分隔', migration: 'cataloged' });
put('I09', '　（自由回答：直接输入文本）', 2465);
put('I10', '直接输入答案即可；多题用「题号+分隔符」开头（如 1. 2 / 2、1），后续行算该题续行（可多行作答）；多选可用 , 、 | / \\ 分隔；/跳过 跳过。', 2471);
put('I11', '📨 已解析回答并排队，等待桌面原始卡片执行。', 2586);
put('I12', '📨 回答已排队，等待桌面原始卡片执行。', 2586);
put('I13', '📨 跳过指令已排队，等待桌面原始卡片执行。', 2524);
put('C06', '{detail}', 1800, 'Session attach composite detail; use C06a/C06b for concrete branches');
put('C01', '当前没有检测到运行中的 DSH 实例（registry 为空）。', 1692);
put('C03', '❌ 拿不到会话列表：{error}', 1723);
put('C04', '该实例上没有持久化的会话（可能所有会话都还在运行的 agent 内存中）。', 1777);
put('C06a', '找不到会话 [{shortId}]。用 /会话 查看列表。', 1803);
put('C06b', '✅ 已接入会话 [{shortId}]。后续消息都会继续这个会话。', 1807);
put('C07', '（当前实例没有可用的会话模式）', 1863);
put('C09', '❌ mode= 后面没写模式（见 /帮助）。', 1874);
put('C10', '❌ 当前实例没有可用的会话模式（agentPresets 未挂载）；/new 只支持选工作区。', 1876);
put('C12', '❌ 模式 "{modeId}" 当前不可用：{reason}', 1887);
put('C13', '❌ 未知模式 "{modeId}"。\n\n{modeList}', 1891);
put('C14', '❌ mode= 写了两次，只给一个。', 1901);
put('C16', '❌ 新建失败：{error}', 1958);
put('C17', '❌ 新建失败：未返回会话 ID。', 1961);
put('C18', '会话已创建并保留在桌面端，但QQ已断开，本次不再自动接入。', 1963);
put('C20', '❌ 无法识别的参数：{argument}。\n工作区号直接写数字，模式写 mode=<模式>（见 /帮助）。', 1975);
put('C21', '❌ 暂不支持的选项：{key}（当前 /new 支持 mode=<模式>）。', 1978);
put('C22', '当前没有任何已知工作区（还没有历史会话）。', 1987);
put('C26', '单插件模式已绑定当前实例，不支持经 QQ 跨实例切换。跨实例对话请在 Web UI 操作.', 2019);
put('C27', '❌ DSH 实例管理插件未启用。未执行任何关闭操作。请先启用实例管理插件并安装后台启动器。', 2026);
put('C28', '❌ 未受理重启：{error}。当前实例保持运行。', 2031);
put('C29', '♻️ 后台启动器已受理重启，约 5 秒后开始。请保存工作；它会检查新实例是否就绪，结果见「DSH 实例管理」。', 2032);
put('C33', '❌ 当前没有接入会话。先用 /会话 <ID> 接入，或发送普通消息自动新建会话。', 2058);
put('C44', '✅ 已断开QQ会话绑定。会话与正在运行的任务保留，结果仅在桌面端显示；所有会话推送到QQ已暂停。用 /会话 <ID> 或 /new 重新接入。', 2187);
put('C74', '当前未接入会话。请用 /会话 <ID> 或 /new 重新接入。', 2688);
put('C43', [
  'QQ-DSH 桥接（单插件版）', '只回复最终结果，思考过程与工具调用不展示。', '指令：',
  '  /profile        查看实例', '  /会话           列出会话（按工作区）',
  '  /断开           清空QQ会话绑定，停止所有会话推送（不删除/停止任务）',
  '  /会话 <4位ID>    接入某个会话（ID 固定，跨重启不变）',
  '  /new            新建会话（可带 mode=<模式>；模式清单见 /new 提示）',
  '  /模型           先选供应商，再选模型（两步均可输入 0 取消）',
  '  /restart        重启整个 DSH 实例', '  /实例 <端口>     查看实例（跨实例请回 Web UI）',
  '  /状态           全链路体检', '  /approve        允许当前会话的待审批请求',
  '  /deny           拒绝待审批请求', '  /跳过           跳过待回答的问题',
  '  /stop           停止当前会话正在执行的工作', '  /提醒           列出计划任务（官方 schedule；新增直接说「每天8点提醒我」）',
  '  /提醒 删 <ID>   取消某个计划任务（ID 见 /提醒 列表）',
  '  /权限           查看当前会话权限（sandbox + approval）',
  '  /权限 <预设名>    切换当前会话权限（如 danger-full-access）',
  '  /权限 重置       回默认权限 + 审批推 QQ', '  /帮助           本帮助',
  '普通消息：发给当前接入的会话；未接入则自动新建会话。',
].join('\n'), 2143, 'Exact installed /帮助 full reply');
// Remaining fixed catalog entries (complex lists are split into stable row IDs).
put('N04', ({ workspace, shortId }) => workspace ? `工作区 ${workspace}` : `会话 ${shortId}`, 1640, '', { required: ['shortId'], optional: ['workspace'] });
// T01-T05 retired: the bridge no longer schedules or fires reminders itself.
for (const id of ['T01', 'T02', 'T03', 'T04', 'T05']) put(id, null, 1521, 'Retired with the official schedule plugin', { migration: 'retired' });
// One row of the official schedule catalog (record fields + locally rendered next time).
put('T06', ({ id, title, kind, everySeconds, time, weekdays, expression, timeZone, next, session, active, current }) => {
  const clock = (value) => String(value ?? '').slice(0, 5);
  const weekdayNames = ['一', '二', '三', '四', '五', '六', '日'];
  let rule;
  if (kind === 'after' || kind === 'at') rule = '一次性';
  else if (kind === 'every') rule = Number(everySeconds) % 60 === 0 && Number(everySeconds) >= 60 ? `每 ${Number(everySeconds) / 60} 分钟` : `每 ${everySeconds} 秒`;
  else if (kind === 'daily') rule = `每天 ${clock(time)}（${timeZone ?? '?'}）`;
  else if (kind === 'weekly') rule = `每周${(weekdays ?? []).map((d) => weekdayNames[d - 1] ?? d).join('、')} ${clock(time)}（${timeZone ?? '?'}）`;
  else rule = `cron ${expression}（${timeZone ?? '?'}）`;
  return `🕒 ${id} ${title} · ${rule}（下次 ${next}）[会话 ${session}${current ? ' ←当前' : ''}]${active === false ? '（已停止）' : ''}`;
}, 430, 'One official schedule row', { required: ['id', 'title', 'kind', 'next', 'session'], optional: ['everySeconds', 'time', 'weekdays', 'expression', 'timeZone', 'active', 'current'] });
put('A01', null, 391, 'Agent-provided text passthrough', { channel: 'non-template', migration: 'passthrough' });
put('A02', null, 613, 'Native QQ media card passthrough', { channel: 'non-template', migration: 'passthrough' });
put('A03', '已发往 QQ（{count} 字，{destination}）：{preview}', 1404, '', { channel: 'agent-only' });
put('A04', null, 1333, 'File transfer result assembled by caller', { channel: 'agent-only', migration: 'passthrough' });
put('A05', null, 1490, 'Retired with the qq_schedule tool', { migration: 'retired', channel: 'agent-only' });
const remaining = {
 C02: '📡 运行中的 DSH 实例：\n{instances}\n本插件已绑定当前实例（web:{webPort}）。跨实例对话请在 Web UI 操作。',
 C05: '💬 会话列表（web:{webPort}，按工作区）：\n{rows}\n用 /会话 <4位ID> 接入对应会话（ID 固定，跨重启不变）；不带 ID 发消息将新建会话。',
 C08: '可用模式（不填 mode= 则用默认模式；也可写模式 id）：\n{rows}',
 C11: '❌ 模式序号超范围（1-{count}）。\n\n{modeList}',
 C15: '📂 选择工作区（回复数字即可在其下新建会话）：\n{rows}\n{modeList}\n回复 1-{count}；也可直接 /new <工作区号> mode=<模式>。',
 C19: '✅ 已在工作区 [{workspace}] 新建会话 [{shortId}]{modeName} 并接入（之后的普通消息都发到这里；/会话 可看列表）。',
 C23: '❌ 编号超范围（1-{count}）。\n\n{workspaceList}', C24: '❌ 编号超范围（1-{count}）。\n\n{workspaceList}',
 C25: '❌ 新建失败：{error}', C30: '❌ 无法联系后台启动器：{error}。未执行关闭操作。',
 C31: '请选择供应商（回复编号，输入 0 取消）：\n{rows}', C32: '供应商：{providerName}\n请选择模型（回复编号，输入 0 取消）：\n{rows}',
 C34: '❌ 当前宿主不支持模型目录查询，请升级 DSH 后重试。', C35: '❌ 当前没有可选的模型供应商。', C36: '❌ 获取模型供应商失败：{error}', C37: '已取消模型选择。',
 C38: '❌ 供应商编号超范围，请输入 1-{count}，或输入 0 取消。\n\n{providerList}', C39: '❌ 模型编号超范围，请输入 1-{count}，或输入 0 取消。\n\n{modelList}',
 C40: '✅ 当前会话模型已切换为 {providerId}/{modelId}。其他会话不受影响。', C41: '❌ 当前会话模型切换失败：{error}',
 C42: '📊 状态检查：\n{status}', C45: '未知指令 {command}。用 /帮助 查看指令。',
 C46: '✅ {result}', C47: '{approval}', C48: '[{sessionName}]需要审批：{toolName}（{reason}）', C49: '当前没有待审批的请求。',
 C50: '有待审批请求，但它属于会话 [{shortId}]，不是当前接入的会话（同意的指令只对当前会话生效）。请先 /会话 切换到对应会话。',
 C51: '📨 指令已排队，等待桌面端原始卡片执行（请保持桌面页面打开）。', C52: '{question}', C53: '[{sessionName}]在等你选择：{question}（共 {count} 题）', C54: '当前没有待回答的问题。',
 C55: '有待回答的问题，但它属于会话 [{shortId}]，不是当前接入的会话。请先 /会话 切换到对应会话。', C56: '📨 跳过指令已排队，等待桌面原始卡片执行。', C57: '📨 已解析回答并排队，等待桌面原始卡片执行。', C58: '📨 回答已排队，等待桌面原始卡片执行。',
 C59: '当前没有接入任何会话。', C60: '⏹️ 该会话当前未附着（{error}）。', C61: '⏹️ 已停止当前会话的工作，并丢弃了队列中未处理的消息。', C62: '⏹️ 当前会话没有正在运行的工作（{error}）。',
 C63: '当前没有接入任何会话。用 /会话 <ID> 接入，或直接发一条普通消息自动新建。', C64: '❌ 当前实例没有 permissionPresets 服务，无法切换权限。', C65: '❌ 会话 [{shortId}] 当前未附着，先发一条消息把它唤起来再切权限。',
 C66: '🔐 当前会话权限：{preset}\n　sandbox：{sandbox}\n　approval：{approval}\n可切换：{available}\n用法：/权限 <预设名>；/权限 重置（回默认 + approval=ask）', C67: '✅ 已重置为默认权限「{preset}」（approval=ask，审批推给 QQ）。', C68: '❌ 没有「{preset}」这个预设。可选：{names}', C69: '✅ 当前会话权限已切到「{preset}」（sandbox={sandbox}，approval={approval}）。',
 C70: '找不到计划任务 [{id}]。用 /提醒 查看列表。', C71: '✅ 已取消计划任务 [{id}]（还剩 {count} 个）。', C72: '当前没有计划任务。直接跟我说「每天 8 点提醒我喝水」这类话即可添加（官方 schedule 插件创建）。', C73: '🕒 计划任务（{count} 个，按下次触发排序）：\n{rows}', C75: '⚠️ 图片没收到（{error}），你可以改用文字描述，或重发一次。', C76: '❌ {error}'
};
for (const [id, template] of Object.entries(remaining)) put(id, template, source.C, 'Cataloged command template');
// Composite messages keep every fixed label and line in this file; callers supply facts, not copy.
put('C02', ({ instances, webPort }) => {
  const lines = ['📡 运行中的 DSH 实例：', ''];
  for (const row of instances) {
    lines.push(`${row.index}、web:${row.webPort}  bridge:${row.bridgePort}  pid:${row.pid}${row.current ? '  ←当前' : ''}`);
    lines.push(`   启动: ${row.startedAt}   cwd: ${row.cwd}`);
  }
  lines.push('', `本插件已绑定当前实例（web:${webPort}）。跨实例对话请在 Web UI 操作。`);
  return lines.join('\n');
}, 1693, '', { required: ['instances', 'webPort'] });
put('C05', ({ webPort, groups }) => {
  const lines = [`💬 会话列表（web:${webPort}，按工作区）：`, ''];
  for (const group of groups) {
    lines.push(`工作区[${group.workspace}]`);
    for (const row of group.sessions) {
      lines.push(`[${row.shortId}] ${row.title}${row.current ? '  ←当前' : ''}`);
      lines.push(`     ${row.time} · ${row.userMsgs}问 · ${row.preset}`);
    }
    lines.push('');
  }
  lines.push('用 /会话 <4位ID> 接入对应会话（ID 固定，跨重启不变）；不带 ID 发消息将新建会话。');
  return lines.join('\n');
}, 1784, '', { required: ['webPort', 'groups'] });
put('C08', ({ rows }) => ['可用模式（不填 mode= 则用默认模式；也可写模式 id）：', ...rows.map(row => `  ${row.index}  ${row.name}   ${row.id}${row.isDefault ? '   ←默认' : ''}`)].join('\n'),
  1864, '', { required: ['rows'] });
put('C15', ({ workspaces, modeName, modeId, modeList }) => {
  const lines = ['📂 选择工作区（回复数字即可在其下新建会话）：', ''];
  for (const ws of workspaces) lines.push(`${ws.index}、[${ws.name}]  ${ws.path}`);
  lines.push('');
  if (modeName) lines.push(`将使用模式：${modeName}（${modeId}）`, '');
  lines.push(modeList, '', `回复 1-${workspaces.length}；也可直接 /new <工作区号> mode=<模式>。`);
  return lines.join('\n');
}, 1915, '', { required: ['workspaces', 'modeList'], optional: ['modeName', 'modeId'] });
put('C19', ({ workspace, shortId, modeName }) => `✅ 已在工作区 [${workspace}] 新建会话 [${shortId}]${modeName ? `（${modeName}）` : ''} 并接入（之后的普通消息都发到这里；/会话 可看列表）。`,
  1968, '', { required: ['workspace', 'shortId'], optional: ['modeName'] });
put('C31', ({ groups }) => ['请选择供应商（回复编号，输入 0 取消）：', ...groups.map((row, i) => `${i + 1}、${row.name ?? row.id}（${row.id}）`)].join('\n'),
  2050, '', { required: ['groups'] });
put('C32', ({ provider, models }) => [`供应商：${provider.name ?? provider.id}`, '请选择模型（回复编号，输入 0 取消）：', ...models.map((row, i) => `${i + 1}、${row.name ?? row.id}（${row.id}）`)].join('\n'),
  2053, '', { required: ['provider', 'models'] });
put('C42', ({ pid, profile, running, connected, ws, webPort, liveAgents, sessionCount, instances }) => {
  const lines = ['📊 状态检查：', '', `插件: 已加载 pid=${pid} profile=${profile}`];
  lines.push(`QQ: ${running ? (connected ? '已连接 ✓' : '连接中…') : '未启用 ✗（设置页打开"启用"开关）'}`);
  if (ws) lines.push(`   WS: ${ws}`);
  lines.push(`实例: web:${webPort}${liveAgents === undefined ? '' : `  liveAgents:${liveAgents}`}`);
  if (sessionCount !== undefined) lines.push(`会话: ${sessionCount} 个`);
  if (instances !== undefined) {
    lines.push(`存活实例: ${instances.length} 个${instances.length > 1 ? ' ⚠️ 多实例同时在跑，QQ 回复可能重复' : ''}`);
    for (const row of instances) lines.push(`  pid:${row.pid}${row.current ? ' ←本实例' : ''}  ${row.cwd}`);
  }
  lines.push('', '指令: /profile /会话 /会话 <ID> /new /模型 /断开 /restart /权限 /提醒 /实例 <端口> /状态 /帮助');
  return lines.join('\n');
}, 2115, '', { required: ['pid', 'profile', 'running', 'connected', 'webPort'], optional: ['ws', 'liveAgents', 'sessionCount', 'instances'] });
put('C66', ({ preset, sandbox, approval, chosen, names }) => [
  `🔐 当前会话权限：${preset}`, `　sandbox：${sandbox}`, `　approval：${approval}`,
  chosen ? `　（你在 QQ 里指定过「${chosen}」，桥接不再自动改回 ask）` : '　（未指定：桥接会保证 approval=ask，审批推给 QQ）',
  '', `可切换：${names}`, '用法：/权限 <预设名>；/权限 重置（回默认 + approval=ask）',
].join('\n'), 2631, '', { required: ['preset', 'sandbox', 'approval', 'names'], optional: ['chosen'] });
put('C73', ({ count, rows }) => [`🕒 计划任务（${count} 个，按下次触发排序）：`, ...rows, '',
  '取消：/提醒 删 <ID>', '新增：直接说「每天 8 点提醒我喝水」这类话（官方 schedule 插件创建）。'].join('\n'),
  2674, '', { required: ['count', 'rows'] });
// Official-schedule management replies.
put('C77', '❌ 当前实例没有官方计划任务服务（@deepseek-ai/dsh-schedule），无法管理计划任务。', 2795, '/提醒 无法访问 schedule 服务');
put('C78', ({ shortId }) => `这条计划任务属于其他会话（[${shortId}]），不能用这个 QQ 账号取消。`, 2795, 'Task bound outside this QQ account', { required: ['shortId'] });
put('C79', ({ prefix }) => `有多个计划任务以 [${prefix}] 开头，请给出更长的 ID。`, 2795, 'Ambiguous schedule id prefix', { required: ['prefix'] });
put('C80', ({ error }) => `⚠️ 读取计划任务失败：${error}`, 2795, 'Schedule catalog read failure', { required: ['error'] });
// I02/C46/etc. are assembled from smaller templates, not alternate user-facing copies.
put('C46', null, 2318, 'Alias of I04 and I05', { migration: 'composite', channel: 'non-template' });
put('C47', null, 2356, 'Composite of I01, I02a-c, I03', { migration: 'composite', channel: 'non-template' });
put('C48', null, 2408, 'Alias of N02', { migration: 'composite', channel: 'non-template' });
put('C52', null, 2452, 'Composite of I06-I10', { migration: 'composite', channel: 'non-template' });
put('C53', null, 2500, 'Alias of N03', { migration: 'composite', channel: 'non-template' });
for (const [id, template] of [['X01','QQ 桥接未启用：请到设置页打开「启用桥接」'],['X02','消息内容为空'],['X03','paths 不能为空'],['X04','还没有任何 QQ 用户和机器人说过话，无法推送'],['X05','QQ 已断开会话，禁止文件推送'],['X09','图片下载失败 HTTP {status}'],['X10','文件为空或不是 Buffer'],['X11','gateway HTTP {status}']]) put(id, template, source.X, 'Diagnostic template', { channel: 'diagnostic' });
for (const id of ['X06', 'X07', 'X08']) put(id, null, source.X, 'Retired with the qq_schedule tool', { migration: 'retired', channel: 'diagnostic' });
// Values are substituted once, never re-parsed (injected brace text remains literal).
export const QQ_MESSAGES = Object.freeze(catalog);
export const MESSAGES = QQ_MESSAGES;
export function qqText(id, values = {}) {
  if (!Object.hasOwn(QQ_MESSAGES, id)) throw new RangeError(`Unknown QQ message ID: ${id}`);
  const entry = QQ_MESSAGES[id];
  if (entry.template === null) throw new RangeError(`QQ message ${id}: ${entry.migration}`);
  if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new TypeError(`${id}: values must be an object`);
  const required = entry.required ?? (typeof entry.template === 'string'
    ? [...new Set([...entry.template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m => m[1]))] : []);
  const allowed = new Set([...required, ...(entry.optional ?? [])]);
  for (const name of required) if (!Object.hasOwn(values, name) || values[name] == null)
    throw new TypeError(`${id}: missing variable ${name}`);
  for (const name of Object.keys(values)) if (!allowed.has(name)) throw new TypeError(`${id}: unexpected variable ${name}`);
  return typeof entry.template === 'function' ? entry.template(values)
    : entry.template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name) => String(values[name]));
}
export const text = qqText;

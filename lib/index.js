/** * dsh-qq-bridge — host half of the QQ bridge, single-plugin edition. * * One DSH plugin that is BOTH the QQ bot client and the DSH driver: *   - connects to the QQ official robot platform (WSS long connection) and *     handles C2C direct messages, with reconnect backoff and heartbeat; *   - drives DSH sessions in-process via current-version services *     (sessionController / sessionQuery / sessions / approval) — no gateway, *     no HTTP bridge, no registry-dependent routing; *   - configured from the DSH settings page ("qq-bridge" namespace): *     appId / appSecret / sandbox / enabled toggle / chat timeout / steer / *     notifyOnComplete（会话状态推送）/ 消息推送内容（pushTodo / pushDeliverable / *     pushToolCall / pushNarration 四个勾选项）. *     QQ 回复排版（msg_type=2 markdown）内置生效，没有开关：失败自动降级纯文本。 *     新建会话的工作目录不在设置里：兜底新建走 DSH 默认（实例进程目录），要指定项目用 /new 选工作区。 * * Only the final assistant text is sent back to QQ: reasoning / tool-call / * tool-result are separate content-block types and are filtered out, so the * user never sees thinking or tool traces. * * 会话状态推送（notifyOnComplete）：任何主会话一轮正常结束时给 QQ 推「[会话名]已完成」； * 等你选择 / 等你审批也推；QQ 用户当前正接入的那个会话不推，子会话不推。 * * * QQ-driven sessions run with approval policy 'ask', bridged to QQ: the pending approval is delivered as a QQ message and the user answers /approve or /deny; timeout auto-rejects. Web-UI sessions are unaffected. * * Requirements: DSH current version (0.1.5-rc.1 service layer), Node >= 22 * (global fetch / WebSocket). Zero npm dependencies — only node builtins and * @deepseek-ai/schemastery (ships with DSH) for the settings schema. */
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
export const name = 'dsh-qq-bridge';

// ── settings schema (renders as a form on the DSH settings page) ───────────
const SCHEMA = z.object({
	enabled: z.boolean().default(false),
	appId: z.string().default(''),
	appSecret: z.string().role('secret').default(''),
	sandbox: z.boolean().default(false),
	chatTimeoutMs: z.number().default(300000),
	steer: z.boolean().default(false),
	notifyOnComplete: z.boolean().default(false), // 会话一轮正常完成时推「[会话名]已完成」（QQ 正在聊的那个会话除外）
	// 「消息推送内容」：设置页 4 个勾选框，逐类控制过程消息推不推（最终正文始终推）
	pushTodo: z.boolean().default(true), // 📋 待办清单（todo/write）
	pushDeliverable: z.boolean().default(true), // 📎 交付清单（deliverables/presented）
	pushToolCall: z.boolean().default(true), // 🔧 工具调用行（tool/call）
	pushNarration: z.boolean().default(true), // 💬 动手前的旁白（assistant/message 带 text + tool-call）
});
const QQ_INTENTS = 1 << 25; // C2C_MESSAGE_CREATE + GROUP_AT_MESSAGE_CREATE
const SESSION_LIST_CAP = 30; // /会话 最多展示条数（按创建时间倒序）
const BOT = { running: false, connected: false, retry: 0, ws: null, heartbeat: null, retryTimer: null, lastSeq: null, msgSeq: 0, chains: new Map(), sockets: new Set() };
/** 已处理的 QQ 消息 id：QQ 事件可能重复投递（重连重发等），同一 id 只处理一次。 */
const seenMsgIds = new Set();
const apiBase = (cfg) => (cfg.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com');
const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
function argvValue(flag) {
	const argv = process.argv ?? [];
	const i = argv.indexOf(flag);
	return i !== -1 && i + 1 < argv.length && !String(argv[i + 1]).startsWith('-') ? argv[i + 1] : undefined;}
function json(res, status, data) {
	const body = JSON.stringify(data);
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
	res.end(body);}
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});}
let log = (...a) => console.log(`[qq-bridge] ${a.join(' ')}`);

// ── state: short-ID map + per-openid current session ───────────────────────
const stateFile = () => join(dshHome(), 'bridge', 'qq-bridge-state.json');
const SHORT_BASE = 1000; // 4 位短 ID 起点；state.next 自增并落盘 → 跨重启固定
const freshState = () => ({ next: SHORT_BASE, map: {}, openids: {}, permPreset: {} });
let state = freshState();
void loadState(); // 模块加载即恢复落盘的 state（openids/短ID 映射）；失败则保持 fresh
async function loadState() {
	try {
		const raw = JSON.parse(await readFile(stateFile(), 'utf8'));
		state = { ...freshState(), ...(raw && typeof raw === 'object' ? raw : {}) };
	} catch {
		state = freshState();
	}
	migrateShortIds();
}
/** 短 ID 迁移/计数修正：旧 6 位 ID 按原顺序重编为 4 位自增；next 恒大于 map 最大值。有变更才落盘。 */
function migrateShortIds() {
	let changed = false;
	if (Object.keys(state.map).some((k) => k.length > 4)) {
		const nextMap = {};
		let n = SHORT_BASE;
		for (const sid of Object.values(state.map)) nextMap[String(n++)] = sid;
		state.map = nextMap;
		changed = true;
	}
	let max = SHORT_BASE - 1;
	for (const k of Object.keys(state.map)) {
		const num = Number(k);
		if (Number.isInteger(num) && num > max) max = num;
	}
	if (typeof state.next !== 'number' || state.next < max + 1 || state.next >= 100000) {
		state.next = max + 1;
		changed = true;
	}
	if (changed) void saveState();
}
async function saveState() {
	try {
		const dir = join(dshHome(), 'bridge');
		await mkdir(dir, { recursive: true });
		const file = stateFile();
		await writeFile(file + '.tmp', JSON.stringify(state, null, 2), 'utf8');
		await rename(file + '.tmp', file);
	} catch {
		/* best-effort */
	}}
// ── 通路标记落盘（qq-last-inbound.json）────────────────────────────────────
// 用途：模型在用户说"发给我"时要判断**当前这轮是哪条通路**——
//   浏览器 prompt 一定带 source.clientTimeZone，QQ 桥接的 prompt 不带（实测结论）。
// 绑定关系（openid↔会话）不等于当前通路：用户可能在 GUI 里打字，而 QQ 仍绑着这个会话。
const lastInboundFile = () => join(dshHome(), 'bridge', 'qq-last-inbound.json');
let lastInbound = null;
async function saveLastInbound() {
	try {
		await mkdir(join(dshHome(), 'bridge'), { recursive: true });
		const file = lastInboundFile();
		await writeFile(file + '.tmp', JSON.stringify(lastInbound, null, 2), 'utf8');
		await rename(file + '.tmp', file);
	} catch {
		/* best-effort */
	}}
// ── 定时任务落盘（qq-schedule.json）────────────────────────────────────────
const scheduleFile = () => join(dshHome(), 'bridge', 'qq-schedule.json');
let schedule = { tasks: [] };
void loadSchedule(); // 与 state 同样：模块加载即恢复
async function loadSchedule() {
	try {
		const raw = JSON.parse(await readFile(scheduleFile(), 'utf8'));
		schedule = { tasks: Array.isArray(raw?.tasks) ? raw.tasks.filter((t) => t && typeof t === 'object' && t.id && t.at) : [] };
	} catch {
		schedule = { tasks: [] };
	}}
async function saveSchedule() {
	try {
		const dir = join(dshHome(), 'bridge');
		await mkdir(dir, { recursive: true });
		const file = scheduleFile();
		await writeFile(file + '.tmp', JSON.stringify(schedule, null, 2), 'utf8');
		await rename(file + '.tmp', file);
	} catch {
		/* best-effort */
	}}
function perUser(openid) {
	if (!state.openids[openid]) state.openids[openid] = { sessionId: null };
	return state.openids[openid];}
/** 4 位短 ID：已有则复用，否则分配（自增 state.next 并落盘，跨重启固定）。 */
function shortIdFor(sessionId) {
	for (const [short, sid] of Object.entries(state.map)) if (sid === sessionId) return short;
	const short = String(state.next++);
	state.map[short] = sessionId;
	return short;}

// ── 审批桥接状态：openid -> 待审批队列（FIFO）────────────────────────────
const pendingApprovals = {};
/** 待回答问题队列：openid -> array（条目见 userQuestionListener）。 */
const pendingQuestions = {};
/** 该会话是否有挂起的用户问答：问答等答案期间，回复观察器不得把这段等待算作超时。 */
function hasPendingQuestion(sid) {
	if (!sid) return false;
	for (const arr of Object.values(pendingQuestions)) {
		if (!Array.isArray(arr) || arr.length === 0) continue;
		for (const entry of arr) {
			if (entry && !entry.done && (entry.sessionId === sid || entry.ownerSessionId === sid)) return true;
		}
	}
	return false;
}
/** 展示用短 ID：已有映射则复用，否则取 UUID 末 8 位（不落盘、不新建映射）。 */
function displayShort(sessionId) {
	if (!sessionId) return '?';
	for (const [short, sid] of Object.entries(state.map)) if (sid === sessionId) return short;
	return String(sessionId).slice(-8);
}

// ── registry (仅用于 /profile 展示实例；单插件模式不依赖它路由) ─────────────
const registryPath = () => join(dshHome(), 'bridge', 'registry.json');
function registerInstance(entry) {
	try {
		mkdirSync(join(dshHome(), 'bridge'), { recursive: true });
		let data = { updatedAt: Date.now(), instances: {} };
		try {
			data = JSON.parse(readFileSync(registryPath(), 'utf8'));
		} catch {
			/* first write */
		}
		data.updatedAt = Date.now();
		data.instances[String(process.pid)] = entry;
		writeFileSync(registryPath() + '.tmp', JSON.stringify(data, null, 2), 'utf8');
		renameSync(registryPath() + '.tmp', registryPath());
	} catch (e) {
		log(`registry write failed: ${e?.message ?? e}`);
	}}
function unregisterInstance() {
	try {
		const data = JSON.parse(readFileSync(registryPath(), 'utf8'));
		delete data.instances[String(process.pid)];
		data.updatedAt = Date.now();
		writeFileSync(registryPath() + '.tmp', JSON.stringify(data, null, 2), 'utf8');
		renameSync(registryPath() + '.tmp', registryPath());
	} catch {
		/* ignore */
	}}
async function readRegistry() {
	try {
		const data = JSON.parse(await readFile(registryPath(), 'utf8'));
		return (data && data.instances) || {};
	} catch {
		return {};
	}}

// ── QQ 入站附件（图片）─────────────────────────────────────────────────────
// QQ 单聊事件里图片在 `attachments[]`（content_type/url/width/height/size），文本 `content` 往往是空的。
// 旧代码只看 content → 纯图片消息被静默丢弃。这里挑出可用的图片交给 DSH 的 image 内容块（模型能看见）。
const QQ_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const QQ_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']; // 与 harness 的 ImageMediaType 一致
/**
 * 从附件里挑图片、归类其余（纯函数，便于测试）。
 * @returns { images: [{mediaType,url,name,size}], others: [{contentType,name,size,reason}] }
 */
function pickImageAttachments(attachments) {
	const images = [];
	const others = [];
	for (const a of Array.isArray(attachments) ? attachments : []) {
		const contentType = String(a?.content_type ?? '').toLowerCase();
		const size = Number(a?.size) || 0;
		const name = String(a?.filename ?? '').trim();
		const url = a?.url ? String(a.url) : '';
		if (QQ_IMAGE_TYPES.includes(contentType) && url) {
			if (size > QQ_IMAGE_MAX_BYTES) {
				others.push({ contentType, name, size, reason: `超过 ${QQ_IMAGE_MAX_BYTES / 1048576}MB` });
				continue;
			}
			const ext = contentType.split('/')[1];
			images.push({ mediaType: contentType, url, name: name || `qq-image-${images.length + 1}.${ext}`, size });
			continue;
		}
		others.push({ contentType: contentType || '(未知类型)', name, size, reason: url ? '暂不支持该类型' : '缺少下载链接' });
	}
	return { images, others };
}
/** 非图片附件的说明文案（并进 prompt 文本，避免静默丢弃）。 */
function attachmentNote(others) {
	if (!Array.isArray(others) || others.length === 0) return '';
	const parts = others.map((o) => `${o.contentType}${o.name ? ` ${o.name}` : ''} — ${o.reason}`);
	return `（收到 ${others.length} 个桥接暂不支持的附件：${parts.join('；')}）`;
}

// ── formatting helpers ─────────────────────────────────────────────────────
/** 单条 QQ 消息的目标分片上限（实测 3215 字仍可；若被拒会自动二分重试，见 sendText）。 */
const QQ_CHUNK_CHARS = 8000;
/** 二分重试下限：小于它就认为不是"太大"导致的失败，直接抛出。 */
const QQ_SPLIT_FLOOR = 500;
/**
 * 长文本切片：优先在空行处切（保住段落/markdown 块），否则退到换行，再不行硬切。
 * 保证每片 ≤ max，且拼接后除新增分隔外不丢内容。
 */
function chunkText(text, max = QQ_CHUNK_CHARS) {
	const s = String(text ?? '');
	if (s.length <= max) return [s];
	const out = [];
	let rest = s;
	while (rest.length > max) {
		let cut = rest.lastIndexOf('\n\n', max);
		if (cut <= 0) cut = rest.lastIndexOf('\n', max);
		if (cut <= 0) cut = max;
		out.push(rest.slice(0, cut).replace(/\s+$/, ''));
		rest = rest.slice(cut).replace(/^\s+/, '');
	}
	if (rest) out.push(rest);
	return out;
}
function fmtTime(ts) {
	if (!ts) return '?';
	const d = new Date(ts);
	return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;}
/** cwd → 可读工作区名：/home/administrator 系列显示 ~，其余取末两段（兼容 Windows 反斜杠） */
function cwdLabel(cwd) {
	if (!cwd) return '未指定';
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	if (parts.length <= 1) return cwd;
	if (parts[0] === 'home' && parts[1] === 'administrator') {
		return '~' + (parts.length > 2 ? '/' + parts.slice(2).join('/') : '');
	}
	return parts.slice(-2).join('/');}
function textOfEvent(e) {
	const msg = e?.data?.message ?? e?.data;
	const blocks = (msg?.content ?? []).filter((b) => b && b.type === 'text');
	const text = blocks.map((b) => String(b.text ?? '')).join('').replace(/\s+/g, ' ').trim();
	return text ? text.slice(0, 80) : null;}
function extractFinalText(assistantEvents) {
	let best = '';
	for (const e of assistantEvents) {
		const blocks = e?.data?.message?.content ?? [];
		const text = blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text ?? '')).join('\n').trim();
		if (text) best = text;
	}
	return best;}
/**
 * 「过程旁白」：assistant/message 里**既有正文、又在调工具**的那一类内容块。
 * DSH 里这一轮可以有多个 assistant/message（每个 step 一条）：
 *   - `reasoning+text`            → 本轮的最终正文（回复观察器负责发，别重复）
 *   - `reasoning+text+tool-call`  → 模型动手前的过场话（"我看一下…"、"明白了，我用提问工具发给你"）
 *   - `reasoning+tool-call`       → 纯工具步骤，没有正文
 * 中间那种既不是最终正文、也不产生 tool/call 事件 —— 原来的两条通道（最终回复 / 🔧 工具行）
 * 都不覆盖它，所以 QQ 上永远收不到。这里把它取成一行 `💬 …`（无正文/纯工具步骤返回 null）。
 */
function narrationLine(event) {
	const blocks = event?.data?.message?.content;
	if (!Array.isArray(blocks)) return null;
	if (!blocks.some((b) => b?.type === 'tool-call')) return null; // 没调工具 → 本轮最终正文，交给回复观察器
	const text = blocks
		.filter((b) => b?.type === 'text')
		.map((b) => String(b.text ?? ''))
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return null;
	return `💬 ${text}`;}
/** 路径 → 末三段（`D:\a\b\c\d.js` → `b/c/d.js`），QQ 上一行读得下又能认出是哪个包。 */
function shortPath(p) {
	const parts = String(p ?? '').split(/[\\/]/).filter(Boolean);
	if (parts.length === 0) return '?';
	return parts.length <= 3 ? parts.join('/') : parts.slice(-3).join('/');}
/** 单行化 + 截断（待办/交付说明共用）。 */
function oneLine(s, n) {
	return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);}
/** `qq_send` 的消息体：trim + 2000 字截断；空内容返回 null（调用方报错）。 */
function qqSendBody(text) {
	const s = String(text ?? '').trim();
	if (!s) return null;
	return s.length > 2000 ? s.slice(0, 2000) + '…' : s;}
/** 可用的权限预设名（含可用的 auto）；服务缺失时返回 []。 */
function permissionPresetNames(service) {
	if (!service || typeof service !== 'object') return [];
	const names = Object.keys(service.presets ?? {});
	if (service.autoAdmit !== undefined) names.push('auto');
	return names;}

// ── 定时推送（qq_schedule）：纯逻辑放模块级，便于测试 ─────────────────────
const SCHED_MAX_TASKS = 50;
const SCHED_MIN_MINUTES = 1; // 一次性任务最早 1 分钟后
const SCHED_MIN_EVERY = 5; // 循环间隔下限（分钟），防刷主动消息频次
/** "HH:MM" → 当天的分钟数；非法返回 null。 */
function parseHHMM(s) {
	const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
	if (!m) return null;
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return null;
	return h * 60 + min;}
/**
 * 下一次触发时刻（epoch ms）：`hhmm` 本地时间 + repeat（once/daily/weekdays）。
 * from 当天该时刻已过则顺延（once 也顺延到明天）；weekdays 跳过周六周日。
 */
function nextAtTime(hhmm, repeat, fromMs) {
	const mins = parseHHMM(hhmm);
	if (mins === null) return null;
	const d = new Date(fromMs);
	const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(mins / 60), mins % 60, 0, 0);
	if (target.getTime() <= fromMs) target.setDate(target.getDate() + 1);
	if (repeat === 'weekdays') {
		while (target.getDay() === 0 || target.getDay() === 6) target.setDate(target.getDate() + 1);
	}
	return target.getTime();}
/** 任务展示成一行：`🕒 a1b2 每天 08:00（下次 09-23 08:00）→ ⏰ 喝水`。 */
function scheduleLine(task, nowMs) {
	const when = task.inMinutes ? `一次 +${task.inMinutes}min` : task.repeat === 'weekdays' ? `工作日 ${task.atTime}` : task.repeat === 'once' ? `一次 ${task.atTime}` : `每天 ${task.atTime}`;
	const d = new Date(task.at ?? nowMs);
	const pad = (n) => String(n).padStart(2, '0');
	const next = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	const what = task.prompt ? `🤖 ${oneLine(task.prompt, 40)}` : `⏰ ${oneLine(task.text, 40)}`;
	const where = task.prompt ? (task.mode === 'new' ? '🆕无头会话' : '📍当前会话') : '';
	return `🕒 ${task.id} ${when}（下次 ${next}）${where ? `[${where}] ` : ''}→ ${what}`;}
/**
 * 校验并构造一条定时任务（纯函数，便于测试）。
 * @returns { ok: true, task } | { ok: false, error }
 */
function buildScheduleTask(args, nowMs, sid, openid) {
	const a = args ?? {};
	const text = String(a.text ?? '').trim();
	const prompt = String(a.prompt ?? '').trim();
	if (!text && !prompt) return { ok: false, error: '要给出 text（固定文本）或 prompt（到点让 agent 干活）' };
	if (text && prompt) return { ok: false, error: 'text 和 prompt 只能给一个' };
	if (text.length > 2000) return { ok: false, error: 'text 超过 2000 字' };
	const inMinutes = Number(a.inMinutes);
	const hasIn = Number.isFinite(inMinutes) && inMinutes > 0;
	const atTime = a.atTime === undefined ? null : String(a.atTime);
	if (hasIn && atTime) return { ok: false, error: 'inMinutes 和 atTime 只能给一个' };
	if (!hasIn && !atTime) return { ok: false, error: '要给出 inMinutes（N 分钟后）或 atTime（"HH:MM"）' };
	let repeat = String(a.repeat ?? (hasIn ? 'once' : 'daily'));
	if (!['once', 'daily', 'weekdays'].includes(repeat)) return { ok: false, error: `repeat 只能是 once/daily/weekdays（收到 ${repeat}）` };
	let at;
	if (hasIn) {
		if (inMinutes < SCHED_MIN_MINUTES) return { ok: false, error: `inMinutes 至少 ${SCHED_MIN_MINUTES}` };
		at = nowMs + Math.round(inMinutes) * 60000;
		repeat = 'once';
	} else {
		at = nextAtTime(atTime, repeat, nowMs);
		if (at === null) return { ok: false, error: `atTime 需要 "HH:MM" 格式（收到 ${atTime}）` };
	}
	if (!sid) return { ok: false, error: '拿不到当前会话 ID，无法定时' };
	// 执行落点：prompt 任务默认走「一次性无头会话」（落在创建任务的工作区，与对话会话解耦）；
	// session:'current' 才回到创建它的会话里跑（需要那边上下文时用）。
	const mode = prompt ? (String(a.session ?? 'new') === 'current' ? 'current' : 'new') : 'current';
	const id = Math.random().toString(36).slice(2, 6);
	return {
		ok: true,
		task: {
			id,
			at,
			repeat,
			inMinutes: hasIn ? Math.round(inMinutes) : null,
			atTime: hasIn ? null : atTime,
			text: text || null,
			prompt: prompt || null,
			mode,
			cwd: mode === 'new' ? (a.cwd ? String(a.cwd) : null) : null,
			sessionId: sid,
			openid: openid ?? null,
			createdAt: nowMs,
			lastFiredAt: null,
		},
	};}
/**
 * 「消息推送内容」勾选项是否打开：`pushTodo` / `pushDeliverable` / `pushToolCall` / `pushNarration`。
 * 未显式设置时按「推」处理（与设置页默认勾选一致）；显式 false 才不推。
 */
function pushEnabled(cfg, key) {
	return cfg?.[key] !== false;}
/**
 * 兜底新建会话该用哪个工作区：`workspaceList()` 已按最近活跃排序，取第一个即可。
 * 没有可用工作区（空列表 / 异常值）返回 null —— 交给 DSH 默认（session-controller 的 defaultCwd，
 * 本机是实例进程目录；启动器没给子进程指定 cwd，所以那是启动器安装目录）。
 */
function preferredNewCwd(workspaces) {
	if (!Array.isArray(workspaces)) return null;
	const first = workspaces.find((w) => typeof w === 'string' && w.trim() !== '');
	return first ?? null;}
/**
 * `todo/write` → 📋 一条待办清单：`📋 待办 2/9 · 正在做：…` + ✅/▶/⬜ 逐条。
 * 这份清单是模型自己的进度表，比 `🔧 todo_write {…}` 那行 JSON 可读得多，所以工具行会跳过这两个工具。
 */
function todoLine(todos) {
	if (!Array.isArray(todos) || todos.length === 0) return null;
	const done = todos.filter((t) => t?.status === 'completed').length;
	const cur = todos.find((t) => t?.status === 'in_progress');
	const curText = oneLine(cur?.content, 50);
	const lines = [`📋 待办 ${done}/${todos.length}${curText ? ` · 正在做：${curText}` : ''}`];
	const MAX = 15;
	todos.slice(0, MAX).forEach((t, i) => {
		const mark = t?.status === 'completed' ? '✅' : t?.status === 'in_progress' ? '▶' : '⬜';
		lines.push(`${mark} ${i + 1}. ${oneLine(t?.content, 50)}`);
	});
	if (todos.length > MAX) lines.push(`…（其余 ${todos.length - MAX} 项略）`);
	return lines.join('\n');}
/** `deliverables/presented` → 📎 一条交付清单：文件名（末两段）+ 说明。 */
function deliverableLine(files) {
	if (!Array.isArray(files) || files.length === 0) return null;
	const lines = [`📎 交付 ${files.length} 个文件`];
	const MAX = 12;
	files.slice(0, MAX).forEach((f) => {
		const desc = oneLine(f?.description, 40);
		lines.push(`· ${shortPath(f?.path)}${desc ? ` — ${desc}` : ''}`);
	});
	if (files.length > MAX) lines.push(`…（其余 ${files.length - MAX} 个略）`);
	return lines.join('\n');}

// ── QQ 富媒体（发文件）──────────────────────────────────────────────────────
// 官方 2026-07 起单聊支持「分片上传」，file_type=4 可发任意格式文件（硬限 200MB/个）：
//   upload_prepare → 逐片 PUT 预签名 URL → upload_part_finish → /files 合并拿 file_info
//   → 发消息 msg_type=7 + media.file_info（content 必须给个非空占位）
// 分片路径不要求文件有公网 URL，所以本机文件也能发。
const QQ_HEAD_HASH_BYTES = 10002432; // md5_10m 取前 ~9.54MB（官方秒传判断用）
const QQ_FILE_HARD_LIMIT = 200 * 1024 * 1024; // 超过硬限官方直接报错（850031）
/** 扩展名 → 富媒体类型：图片/视频/语音发送后在 QQ 里直接展示，其余按文件卡片。 */
function qqFileType(name) {
	const ext = String(name ?? '').split('.').pop().toLowerCase();
	if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 1;
	if (ext === 'mp4') return 2;
	if (['silk', 'mp3', 'wav', 'ogg'].includes(ext)) return 3;
	return 4;
}
/** upload_prepare 要的三个摘要：整文 md5 / sha1 + 前 10002432 字节 md5。 */
function fileDigests(buf) {
	const head = buf.subarray(0, Math.min(buf.length, QQ_HEAD_HASH_BYTES));
	return {
		md5: createHash('md5').update(buf).digest('hex'),
		sha1: createHash('sha1').update(buf).digest('hex'),
		md5_10m: createHash('md5').update(head).digest('hex'),
	};
}
/** QQ HTTP 调用：非 2xx 时把响应体里的 code/message 一起抛出来，便于日志定位。 */
async function qqFetch(url, options) {
	const res = await fetch(url, options);
	if (res.ok) return res.json().catch(() => ({}));
	const body = await res.text().catch(() => '');
	throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
}
/**
 * 本机文件 → QQ file_info（分片上传 + 合并）。
 * @param base  API 基址（正式/沙箱）
 * @param token 机器人 access token
 * @param openid 目标用户
 * @param file  { name: 文件名, buf: Buffer }
 * @returns { fileInfo, fileType, ttl }
 */
async function uploadQqFile(base, token, openid, file) {
	const name = basename(String(file?.name ?? 'file'));
	const buf = file?.buf;
	if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('文件为空或不是 Buffer');
	if (buf.length > QQ_FILE_HARD_LIMIT) throw new Error(`超过 QQ 硬限 200MB（${buf.length} 字节）`);
	const fileType = qqFileType(name);
	const user = encodeURIComponent(openid);
	const auth = { authorization: `QQBot ${token}`, 'content-type': 'application/json' };
	const prep = await qqFetch(`${base}/v2/users/${user}/upload_prepare`, {
		method: 'POST',
		headers: auth,
		body: JSON.stringify({ file_type: fileType, file_size: String(buf.length), file_name: name, ...fileDigests(buf) }),
	});
	const uploadId = prep?.upload_id;
	const blockSize = Number(prep?.block_size) || 5 * 1024 * 1024;
	const parts = Array.isArray(prep?.parts) ? [...prep.parts].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)) : [];
	if (!uploadId || parts.length === 0) throw new Error(`upload_prepare 响应异常: ${JSON.stringify(prep).slice(0, 200)}`);
	// 注意：服务端返回的分片 index 实测是 **1 基**（presigned URL 也是 part_1），
	// 所以字节偏移按「排序后的第几片」算，而 part_index 原样回传服务端的值。
	for (const [ordinal, part] of parts.entries()) {
		const partIndex = Number.isFinite(Number(part?.index)) ? Number(part.index) : ordinal + 1;
		const chunk = buf.subarray(ordinal * blockSize, Math.min((ordinal + 1) * blockSize, buf.length));
		if (chunk.length === 0) continue;
		const put = await fetch(String(part.presigned_url), { method: 'PUT', body: chunk });
		if (!put.ok) throw new Error(`分片 ${partIndex} PUT 失败 HTTP ${put.status}`);
		await qqFetch(`${base}/v2/users/${user}/upload_part_finish`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({
				upload_id: uploadId,
				part_index: partIndex,
				block_size: String(chunk.length),
				md5: createHash('md5').update(chunk).digest('hex'),
			}),
		});
	}
	const merged = await qqFetch(`${base}/v2/users/${user}/files`, {
		method: 'POST',
		headers: auth,
		// 官方示例：分片合并要带 file_name + srv_send_msg（false=只回 file_info，随后自己发消息）
		body: JSON.stringify({ file_type: fileType, srv_send_msg: false, file_name: name, upload_id: uploadId }),
	});
	if (!merged?.file_info) throw new Error(`合并响应缺少 file_info: ${JSON.stringify(merged).slice(0, 200)}`);
	return { fileInfo: String(merged.file_info), fileType, ttl: Number(merged.ttl) || 0 };
}
/** 发一条富媒体消息（msg_type=7；content 必须非空占位，官方已知行为）。 */
async function sendQqMedia(base, token, openid, fileInfo) {
	await postMessage(base, token, openid, { content: ' ', msg_type: 7, media: { file_info: fileInfo } });
}

// ── QQ client (WSS + HTTPS, zero deps, global fetch/WebSocket) ─────────────
let tokenCache = { token: null, expiresAt: 0 };
async function getAppToken(appId, appSecret) {
	const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ appId, clientSecret: appSecret }),
	});
	if (!res.ok) throw new Error(`getAppAccessToken HTTP ${res.status}`);
	const j = await res.json().catch(() => ({}));
	if (!j || !j.access_token) throw new Error('getAppAccessToken: 响应缺少 access_token');
	return { token: String(j.access_token), expiresIn: Number(j.expires_in) || 7200 };}
async function ensureToken(appId, appSecret) {
	if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
	const { token, expiresIn } = await getAppToken(appId, appSecret);
	tokenCache = { token, expiresAt: Date.now() + expiresIn * 1000 };
	return token;}
async function getGatewayUrl(token, base) {
	const res = await fetch(`${base}/gateway`, { headers: { authorization: `QQBot ${token}` } });
	if (!res.ok) throw new Error(`gateway HTTP ${res.status}`);
	const j = await res.json().catch(() => ({}));
	if (!j || !j.url) throw new Error('gateway: 响应缺少 url');
	return String(j.url);}
async function postMessage(base, token, openid, body) {
	const res = await fetch(`${base}/v2/users/${encodeURIComponent(openid)}/messages`, {
		method: 'POST',
		headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const j = await res.json().catch(() => ({}));
		const detail = [j?.message, j?.code].filter(Boolean).join(' ');
		throw new Error(`QQ 发送失败 HTTP ${res.status}${detail ? ' ' + detail : ''}`);
	}}
function sendWs(obj) {
	try {
		BOT.ws?.send(JSON.stringify(obj));
	} catch (e) {
		log(`WS send 失败: ${e?.message ?? e}`);
	}}
function scheduleReconnect() {
	if (!BOT.running) return;
	if (BOT.retryTimer) clearTimeout(BOT.retryTimer);
	const delay = Math.min(1000 * 2 ** BOT.retry, 30000);
	BOT.retry += 1;
	log(`${delay}ms 后重连（第 ${BOT.retry} 次）`);
	BOT.retryTimer = setTimeout(() => connectLoop(), delay);
	BOT.retryTimer.unref?.();}
function handleWsFrame(data) {
	let msg;
	try {
		msg = JSON.parse(data);
	} catch {
		return;
	}
	const op = msg.op;
	if (op === 10) {
		// Hello → Identify + 心跳
		const hi = Number(msg.d?.heartbeat_interval);
		BOT.connected = true;
		BOT.retry = 0;
		if (BOT.heartbeat) clearInterval(BOT.heartbeat);
		sendWs({ op: 2, d: { token: `QQBot ${BOT.token}`, intents: QQ_INTENTS, shard: [0, 1] } });
		if (hi > 0) {
			BOT.heartbeat = setInterval(() => sendWs({ op: 1, d: BOT.lastSeq ?? null }), hi);
			BOT.heartbeat.unref?.();
		}
		log('WS READY（已 Identify，开始接收消息）');
		return;
	}
	if (op === 11) return; // Heartbeat ACK
	if (op === 1) {
		sendWs({ op: 1, d: BOT.lastSeq ?? null });
		return;
	}
	if (op === 0) {
		if (typeof msg.s === 'number') BOT.lastSeq = msg.s;
		const t = msg.t;
		if (t === 'C2C_MESSAGE_CREATE') onC2CMessage(msg.d);
		else if (t === 'GROUP_AT_MESSAGE_CREATE') onGroupAt(msg.d);
		return;
	}
	if (op === 7) {
		// 服务端要求重连
		log('收到 op7 重连指令');
		try {
			BOT.ws?.close();
		} catch {
			/* ignore */
		}
	}}

// ── message handlers (wired by apply) ──────────────────────────────────────
let handleUserText = null; // (openid, msgId, text) => Promise<void> 由 apply 注入
let answerPendingByText = null; // (openid, text) => boolean 由 apply 注入（普通消息 → 自由回答）
let handleNewPick = null; // (openid, text) => boolean 由 apply 注入（/new 选工作区：纯数字回复）
let onGroupAt = (d) => {
	const gid = d?.group_openid;
	if (gid) {
		// 群聊仅提示私聊；发送走群接口，单插件 v1 不实现
		log(`群聊 @ 暂不支持（group=${gid}）`);
	}};
function onC2CMessage(d) {
	const openid = d?.author?.id;
	const msgId = d?.id;
	const raw = String(d?.content ?? '').trim();
	const { images, others } = pickImageAttachments(d?.attachments);
	// 纯图片消息的 content 是空的 —— 旧代码在这里静默 return（图就丢了）
	if (!openid || (!raw && images.length === 0 && others.length === 0) || !handleUserText) return;
	if (!raw && images.length === 0 && others.length > 0) {
		log(`C2C ${openid.slice(0, 8)}…: 只有不支持的附件（${others.map((o) => o.contentType).join(', ')}）`);
	}
	const content = [raw, attachmentNote(others)].filter(Boolean).join(raw ? '\n' : '');
	log(`C2C ${openid.slice(0, 8)}…: ${raw.slice(0, 40)}${images.length ? ` [图片×${images.length}]` : ''}`);
	// 去重：QQ 可能重复投递同一事件；同 id 第二次直接丢弃（否则会插话两次/回答两遍）
	if (msgId) {
		if (seenMsgIds.has(msgId)) {
			log(`忽略重复消息 ${String(msgId).slice(0, 10)}…`);
			return;
		}
		seenMsgIds.add(msgId);
		if (seenMsgIds.size > 200) seenMsgIds.delete(seenMsgIds.values().next().value);
	}
	// 指令（/开头）立即处理：/approve /deny /答 /状态 等不能被正在进行的对话阻塞。
	if (content.startsWith('/')) {
		handleUserText(openid, msgId, content).catch(() => {});
		return;
	}
	// 有待回答的问题时，普通消息直接作为自由回答（立即处理，不排队）
	if (answerPendingByText && (pendingQuestions[openid]?.length ?? 0) > 0 && answerPendingByText(openid, content)) {
		return;
	}
	// /new 待选工作区：纯数字回复 → 在该工作区新建会话并接入
	if (handleNewPick && handleNewPick(openid, content)) {
		return;
	}
	// 普通消息：立即交给 handleUserText 提交给 DSH（图片作为 image 内容块一起带上）。
	// 排队/插话一律走 DSH 原生机制（prompt 的 mode: 'queue' | 'steer'），桥接不再自己扣消息：
	// 排队中的内容因此真实进入会话 inbox，在 Web UI 可见，顺序与取消也由 DSH 管理。
	handleUserText(openid, msgId, content, images).catch(() => {});}
async function connectLoop() {
	if (!BOT.running) return;
	try {
		const cfg = readCfg();
		const token = await ensureToken(cfg.appId, cfg.appSecret);
		const url = await getGatewayUrl(token, apiBase(cfg));
		BOT.token = token;
		BOT.url = url;
		// 连接接管策略：新 socket 收到 op10（Hello）才算握手成功，才替换 BOT.ws。
		// 旧连接在候选握手成功前继续处理消息，避免「BOT.ws 指向未握手成功的连接、
		// QQ 实际投递的旧连接被非当前 socket 守卫丢弃」导致的静默收不到消息。
		const socket = new WebSocket(url);
		BOT.sockets.add(socket);
		// 候选连接：只有收到 op10（Hello）并完成 Identify 后才接管当前 socket。
		// 若未握手成功就替换 BOT.ws，而 QQ 仍把消息投到旧连接上，会被
		// 「非当前 socket」守卫全部丢弃 → 表现为 QQ 收不到任何回复（本次故障根因）。
		// 现在：旧连接在候选握手成功前继续处理消息；候选超时无 Hello 则关闭重试。
		const handshakeTimer = setTimeout(() => {
			BOT.sockets.delete(socket);
			try {
				socket.close();
			} catch {
				/* ignore */
			}
			if (BOT.ws === socket) {
				BOT.connected = false;
				log('当前连接握手超时（未收到 Hello），关闭并重连');
			} else {
				log('候选连接握手超时（未收到 Hello），关闭并重试');
			}
			scheduleReconnect();
		}, 15000);
		handshakeTimer.unref?.();
		socket.onopen = () => {
			if (BOT.ws !== socket) return;
			log(`WS 已连接 ${url}`);
		};
		socket.onmessage = (ev) => {
			if (BOT.ws !== socket) {
				// 候选连接：仅当收到 op10（Hello）时接管；其余帧由旧连接继续处理
				try {
					const m = JSON.parse(ev?.data);
					if (m?.op === 10) {
						clearTimeout(handshakeTimer);
						const prev = BOT.ws;
						BOT.ws = socket;
						if (prev) {
							BOT.sockets.delete(prev);
							try {
								prev.close();
							} catch {
								/* ignore */
							}
						}
						log('新连接 READY，切换当前 socket');
						try {
							handleWsFrame(ev?.data);
						} catch (e) {
							log(`WS 帧处理异常: ${e?.stack ?? e}`);
						}
					}
				} catch {
					/* ignore */
				}
				return;
			}
			try {
				handleWsFrame(ev?.data);
			} catch (e) {
				log(`WS 帧处理异常: ${e?.stack ?? e}`);
			}
		};
		socket.onclose = () => {
			BOT.sockets.delete(socket);
			clearTimeout(handshakeTimer);
			if (BOT.ws !== socket) return; // 非当前 socket：不重置状态、不重连
			BOT.connected = false;
			if (BOT.heartbeat) {
				clearInterval(BOT.heartbeat);
				BOT.heartbeat = null;
			}
			log('WS 已关闭');
			scheduleReconnect();
		};
		socket.onerror = (e) => {
			if (!BOT.sockets.has(socket)) return;
			log(`WS 错误: ${e?.message ?? e}`);
		};
	} catch (e) {
		log(`连接失败: ${e?.message ?? e}`);
		scheduleReconnect();
	}}
// 启动/停止/重启（由 apply 与 settings/updated 驱动）
let readCfg = () => ({});
let startBot = () => {};
let stopBot = () => {};
let restartBot = () => {};
// 最近一次已应用到 QQ 连接的「连接参数」指纹。设置页改成"改动即自动保存"后保存会变频繁，
// 而 chatTimeoutMs / steer / notifyOnComplete / pushTodo / pushDeliverable / pushToolCall /
// pushNarration 都是运行时 readCfg() 实时读取的，
// 不需要为了它们重启 WS；只有凭证 / 开关 / 沙箱变了才重启（否则每次改超时都会断一次 QQ）。
let appliedConnKey = null;

/** QQ 连接参数指纹：只有它变了才需要启停 / 重启 WS。 */
function connKeyOf(cfg) {
	const c = cfg && typeof cfg === 'object' ? cfg : {};
	const shouldRun = !!(c.enabled && c.appId && c.appSecret);
	return JSON.stringify([shouldRun, c.appId ?? '', c.appSecret ?? '', !!c.sandbox]);
}

// ── 会话完成通知（设置开关 notifyOnComplete）纯判定 ─────────────────────────
// 两个判定函数放模块级：宿主半住在 node_modules 下不能被热更，测试脚本从真源码里把它们
// 抠出来直接跑（tests/qq-bridge/notify-on-complete.test.mjs），比"看代码"可靠。
/**
 * 该给这个会话推状态通知吗？返回要通知的 sessionId，或 null。
 * 条件：开关打开（notifyOnComplete —— 同一个开关同时管「完成」和「在等你输入」）+ 主会话。
 * 子会话 / subagent（带 parentSession、origin==='subagent' 或 delegationDepth>=1）不通知，
 * 否则一个 workflow 能刷出几十条。
 */
function noticeSidFor(session, cfg) {
	if (cfg?.notifyOnComplete !== true) return null;
	const sid = session?.id ?? session?.header?.id;
	if (!sid) return null;
	const header = session?.header;
	if (header?.parentSession) return null;
	if (header?.origin === 'subagent') return null;
	const depth = Number(header?.delegationDepth ?? session?.delegationDepth ?? 0);
	if (depth >= 1) return null;
	return sid;
}
/**
 * 这个 session/event 该不该产生一条「完成」通知？条件：noticeSidFor 通过 + 是 turn/end +
 * 正常完成（reason.kind === 'completed'）。中断 / 报错 / 超时都不推。
 */
function completionNoticeFor(session, event, cfg) {
	if (event?.type !== 'turn/end') return null;
	if (event?.data?.reason?.kind !== 'completed') return null;
	return noticeSidFor(session, cfg);
}
/**
 * 该会话完成时，哪些 QQ 用户要收到通知：所有已知 openid，**除了**当前正接入这个会话的那个
 * （它那一轮的正文已经由回复观察器直接回给 QQ，再推一条「已完成」就是重复）。
 */
function noticeTargets(state, sid) {
	const out = [];
	for (const [openid, per] of Object.entries(state?.openids ?? {})) {
		if (per?.sessionId === sid) continue;
		out.push(openid);
	}
	return out;
}

// ── plugin ─────────────────────────────────────────────────────────────────
export function apply(ctx) {
	log = (...a) => {
		const line = `[qq-bridge] ${a.join(' ')}`;
		try {
			ctx.logger?.info?.(line);
		} catch {
			console.log(line);
		}
	};
	const svc = { settings: null, sessionController: null, sessionQuery: null, sessions: null, approval: null, agentPresets: null };
	const webPort = (() => {
		const p = Number(argvValue('--port'));
		return Number.isFinite(p) ? p : null;
	})();
	const profile = argvValue('--profile') ?? 'web';
	const startedAt = Date.now();
	// 等待一轮结束：session/event 订阅 + 轮询兜底 + 超时
	const pending = new Map(); // sessionId -> waiter
	/**
	 * 每会话「回复观察器」：sessionId -> { openid, inTurn, stopTyping }。
	 * 只做一件事：把每一轮结束后的最终文本回给 QQ。
	 * 排队与插话都交给 DSH 原生机制（prompt 的 mode），桥接不再自己排队。
	 */
	const runs = new Map();
	// 过程推送：4 类内容各自勾选（设置页「消息推送内容」），只推给接入该会话的那个 QQ 用户
	const lastTodoBySession = new Map(); // 同一份待办清单重复写回时不重复推
	const RICH_TOOLS = new Set(['todo_write', 'present']); // 这两个工具有专门的 📋/📎 消息，跳过 🔧 那行 JSON
	ctx.on('session/event', (session, event) => {
		const sid = session?.id;
		const cfg = readCfg(); // 每类只读一次：勾选状态是实时的，改完立刻生效
		if (event?.type === 'assistant/message') {
			// 模型的过场话（有正文 + 在调工具）：原先被静默丢掉，这里补上。
			// 它跟最终正文不是一回事，通常带中间结论/判断，所以单独一个勾选项。
			if (!pushEnabled(cfg, 'pushNarration')) return;
			const line = narrationLine(event);
			if (!line) return;
			const openid = openidForSession(sid);
			if (openid) pushProgress(openid, line);
			return;
		}
		if (event?.type === 'todo/write') {
			if (!pushEnabled(cfg, 'pushTodo')) return;
			const line = todoLine(event.data?.todos);
			if (!line || lastTodoBySession.get(sid) === line) return; // 清单没变就不推
			lastTodoBySession.set(sid, line);
			const openid = openidForSession(sid);
			if (openid) pushProgress(openid, line);
			return;
		}
		if (event?.type === 'deliverables/presented') {
			// 只推一条 📎 清单（若勾选）；**不再自动发文件本体** —— 要发文件由用户点名，
			// 我这边调 qq_send_file。中间产物（源码/测试）就不该往手机上灌。
			const openid = ownerOpenidForSession(sid);
			if (!openid) return;
			if (pushEnabled(cfg, 'pushDeliverable')) {
				const line = deliverableLine(event.data?.files);
				if (line) pushProgress(openid, line);
			}
			return;
		}
		if (event?.type !== 'tool/call') return;
		let a = String(event.data?.arguments ?? '');
		if (a.length > 120) a = a.slice(0, 120) + '…';
		const line = `🔧 ${event.data?.name ?? '?'}${a ? ` ${a}` : ''}`;
		recordTool(sid, line); // 始终记录：供超时/中断时打包回放（旁白/清单不进这份工具清单）
		if (RICH_TOOLS.has(String(event.data?.name ?? ''))) return; // 📋/📎 已经说清楚了
		if (pushEnabled(cfg, 'pushToolCall')) {
			const openid = openidForSession(sid);
			if (openid) pushProgress(openid, line);
		}
	});
	// 中断监测：会话一旦被中断（含 Web UI 停止按钮），丢弃队列中未处理的消息。
	// DSH 的 cancel 默认 keepInbox:true，会把排队消息留到下次输入时被一起处理。
	ctx.on('session/event', (session, event) => {
		const reason = event?.type === 'turn/end' ? event.data?.reason : null;
		if (reason && (reason.kind === 'aborted' || reason.kind === 'interrupted')) clearQueuedSoon(session?.id);
	});
	ctx.on('session/event', (session, event) => {
		const w = pending.get(session?.id);
		if (!w) return;
		const turn = event?.data?.turn;
		if (typeof turn !== 'number') return;
		if (event.type === 'assistant/message' && turn > w.beforeTurn) {
			if (!w.assistantEvents.some((x) => x.seq === event.seq)) w.assistantEvents.push(event);
		} else if (event.type === 'turn/end' && turn > w.beforeTurn) {
			w.reason = event.data?.reason ?? null;
			w.endedTurn = turn;
			w.finish?.();
		}
	});
	function waitForTurn(sessionId, beforeTurn, timeoutMs, onTimeout) {
		let resolveTurn, rejectTurn;
		const promise = new Promise((res, rej) => {
			resolveTurn = res;
			rejectTurn = rej;
		});
		const w = { beforeTurn, assistantEvents: [], reason: null, timedOut: false, settled: false, endedTurn: null };
		let poll = null;
		let timer = null;
		// 超时语义：不是「总时长」，而是「活动空闲」+「无挂起问答」。
		// 模型持续产出事件（干活中）或问答挂起（等你回答）都不算超时——
		// 否则问答等答案超过 5 分钟会把观察器误杀，最终正文就永远发不出去（已实测复现）。
		let deadline = Date.now() + timeoutMs;
		let maxSeenSeq = 0;
		let suppressLeft = 6; // 问答挂起期间最多顺延窗口数（防御上限；问题自身也有超时，会自行收敛）
		const arm = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(fire, Math.max(0, deadline - Date.now()));
			timer.unref?.();
		};
		const fire = () => {
			if (w.settled) return;
			if (suppressLeft > 0 && hasPendingQuestion(sessionId)) {
				// 有问答在等答案：这段等待不算超时，顺延一个窗口；用户回答后事件恢复，活动续期自然接管。
				suppressLeft--;
				deadline = Date.now() + timeoutMs;
				arm();
				return;
			}
			w.timedOut = true;
			try {
				onTimeout?.();
			} catch {
				/* ignore */
			}
			w.finish();
		};
		const touch = () => {
			deadline = Date.now() + timeoutMs;
			arm();
		};
		w.finish = () => {
			if (w.settled) return;
			w.settled = true;
			if (poll) clearInterval(poll);
			if (timer) clearTimeout(timer);
			pending.delete(sessionId);
			const text = extractFinalText(w.assistantEvents);
			const error = w.reason?.kind === 'error' ? (w.reason.error?.message ?? 'agent turn error') : null;
			resolveTurn({ text, error, timedOut: w.timedOut, aborted: w.reason?.kind === 'aborted' || w.reason?.kind === 'interrupted', endedTurn: w.endedTurn });
		};
		pending.set(sessionId, w);
		// 轮询兜底：事件订阅万一不触发也能收敛；顺带做活动检测（本轮有新事件即续期）
		poll = setInterval(() => {
			const sess = svc.sessions?.get(sessionId);
			if (!sess) return;
			let events;
			try {
				events = sess.snapshotEvents();
			} catch {
				return;
			}
			let touched = false;
			for (const e of events) {
				const turn = e?.data?.turn;
				if (typeof turn !== 'number' || turn <= beforeTurn) continue;
				if (typeof e?.seq === 'number' && e.seq > maxSeenSeq) {
					maxSeenSeq = e.seq;
					touched = true;
				}
				if (e.type === 'assistant/message') {
					if (!w.assistantEvents.some((x) => x.seq === e.seq)) w.assistantEvents.push(e);
				} else if (e.type === 'turn/end') {
					w.reason = e.data?.reason ?? null;
					w.endedTurn = turn;
					w.finish();
					return;
				}
			}
			if (touched) touch();
		}, 500);
		poll.unref?.();
		arm();
		return {
			promise,
			cancel: (err) => {
				if (w.settled) return;
				w.settled = true;
				if (poll) clearInterval(poll);
				if (timer) clearTimeout(timer);
				pending.delete(sessionId);
				rejectTurn(err);
			},
		};
	}
	async function currentTurn(sessionId) {
		try {
			const sess = svc.sessions?.get(sessionId);
			const events = sess
				? sess.snapshotEvents()
				: (await svc.sessionQuery.readSession(sessionId)).events;
			let m = -1;
			for (const e of events) {
				const t = e?.data?.turn;
				if (typeof t === 'number' && t > m) m = t;
			}
			return m;
		} catch {
			return -1;
		}
	}
	/** 确保会话存在 + 审批策略 ask；返回 sessionId */
	async function ensureSession(per) {
		let sessionId = per.sessionId;
		if (!sessionId) {
			// 兜底新建（QQ 里直接说话、还没接入任何会话时）：落在**最近活跃的工作区**（与 /new 列表同源），
			// 并记账进 Workspace Registry 让 Web UI 能归组；一个可用工作区都没有时才交给 DSH 默认
			// （session-controller: cwd = workspace?.path ?? request.cwd ?? defaultCwd = 实例进程目录）。
			const cwd = await defaultCwdForNew();
			const created = await svc.sessionController.create(cwd ? { cwd } : {});
			sessionId = created?.sessionId ?? created?.id;
			if (sessionId && cwd) await attachToWorkspace(sessionId, cwd);
			per.sessionId = sessionId;
			saveState();
			log(`兜底新建会话 ${sessionId ? displayShort(sessionId) : '(失败)'}：工作区 ${cwd ?? '(DSH 默认)'}`);
		}
		try {
			const r = await svc.sessionController.resolveAgent(sessionId);
			// QQ 会话默认 fail-closed（审批走 QQ）。但用户一旦在 QQ 里用 /权限 明确切过预设，
			// 就不再每次覆盖他的选择（否则 approval=never 会被下一句话打回 ask）。
			if (r && r.agent && svc.approval && !state.permPreset?.[sessionId]) svc.approval.setPolicy(r.agent, 'ask');
		} catch {
			/* best-effort */
		}
		return sessionId;
	}
	/** 提交一条消息：插话开关开且有轮次在跑 → steer（并入当前轮）；否则 queue（DSH 原生排队） */
	async function submitPrompt(sessionId, text, images = []) {
		const r = runs.get(sessionId);
		const mode = readCfg().steer && r && r.inTurn ? 'steer' : 'queue';
		// 内容块：文本可空（纯图片消息），但至少要有一块（harness：至少一个非空文本块或附件）
		const content = [];
		if (String(text ?? '').trim()) content.push({ type: 'text', text: String(text) });
		for (const img of Array.isArray(images) ? images : []) {
			if (img?.mediaType && img?.data) content.push({ type: 'image', mediaType: img.mediaType, data: img.data, name: img.name });
		}
		if (content.length === 0) throw new Error('空消息（既没有文本也没有可用图片）');
		// prompt(request, signal)：signal 必传（AbortSignal）。缺省会抛 TypeError，
		// 且被 DSH 服务边界判为 fatal load failure 直接退出整个进程。
		await svc.sessionController.prompt(
			{ requestId: randomUUID(), sessionId, mode, content },
			new AbortController().signal,
		);
	}
	/** QQ 附件图片 → prompt 的 image 内容块（下载 + base64；失败抛出可读错误）。 */
	async function downloadQqImages(images) {
		const out = [];
		for (const img of Array.isArray(images) ? images : []) {
			const res = await fetch(img.url, { signal: AbortSignal.timeout(20000) });
			if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.length === 0) throw new Error('图片下载为空');
			if (buf.length > QQ_IMAGE_MAX_BYTES) throw new Error(`图片 ${(buf.length / 1048576).toFixed(1)}MB 超过上限`);
			log(`图片已接收：${img.name}（${buf.length} B, ${img.mediaType}）`);
			out.push({ mediaType: img.mediaType, data: buf.toString('base64'), name: img.name });
		}
		return out;
	}
	/**
	 * 一轮结果 → QQ 文本。
	 * 超时/中断时把本轮全部工具调用打包附上——只给最后一条文本看不到工作全貌。
	 */
	function formatTurn(result, digest) {
		if (result.error) return `❌ ${result.error}`;
		if (result.aborted || result.timedOut) {
			const head = result.aborted
				? '⏹️ 已停止当前工作。'
				: `⚠️ 处理超时（>${Math.round((readCfg().chatTimeoutMs || 300000) / 60000)} 分钟）\n本轮可能仍在运行，完成后会自动补发正文。`;
			const lines = [head];
			const list = digest ?? [];
			if (list.length) {
				const MAX = 30;
				lines.push('', `本轮已执行的工具调用（共 ${list.length} 步）：`);
				for (let i = 0; i < Math.min(list.length, MAX); i++) lines.push(`  ${i + 1}. ${list[i]}`);
				if (list.length > MAX) lines.push(`  …（其余 ${list.length - MAX} 步略）`);
			}
			lines.push('', '已完成的部分输出：', result.text || '（无产出）');
			return lines.join('\n');
		}
		return result.text || '（空回复）';
	}
	/** DSH 是否已在 afterTurn 之后开了新的一轮（被合并/排队的消息会紧接着开轮） */
	async function waitTurnStart(sessionId, afterTurn, ms) {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if ((await currentTurn(sessionId)) > afterTurn) return true;
			await new Promise((res) => setTimeout(res, 150));
		}
		return false;
	}
	/**
	 * 每会话一个「回复观察器」：把每一轮结束后的最终文本回给 QQ，直到没有后续轮次。
	 * 消息本身已由 handleUserText 提交给 DSH——排队与插话都是 DSH 原生行为。
	 */
	function ensureReplier(openid, sessionId, beforeTurn) {
		const existing = runs.get(sessionId);
		if (existing) {
			existing.openid = openid;
			return;
		}
		const state = { openid, inTurn: false, stopTyping: startTyping(openid) };
		runs.set(sessionId, state);
		(async () => {
			try {
				let base = beforeTurn;
				let warned = false; // 已发过超时提示：连续两次超时才真退出（长工具/慢收尾可能超过单个窗口）
				while (true) {
					state.inTurn = true;
					const waiter = waitForTurn(sessionId, base, readCfg().chatTimeoutMs || 300000, null);
					const result = await waiter.promise;
					state.inTurn = false;
					base = result.endedTurn ?? base;
					if (result.timedOut && warned) break; // 连续两次超时：本轮确实无进展，退出观察
					if (result.timedOut) warned = true;
					else warned = false;
					const digest = takeToolDigest(sessionId);
					await sendText(state.openid, formatTurn(result, digest));
					if (result.timedOut) continue; // 已提示超时：继续守同一轮（或其后排队的轮），正文到达即补发
					if (!(await waitTurnStart(sessionId, base, 1200))) break;
				}
			} catch (e) {
				log(`回复观察器异常: ${e?.message ?? e}`);
			} finally {
				state.stopTyping?.();
				if (runs.get(sessionId) === state) runs.delete(sessionId);
			}
		})();
	}
	/** 中断后清空该会话未处理的队列（延迟一拍，等 DSH 收尾） */
	function clearQueuedSoon(sessionId) {
		if (!sessionId) return;
		setTimeout(() => {
			try {
				const agent = svc.agents?.get?.(sessionId);
				if (!agent || !agent.inbox) return;
				const n = (agent.inbox.nextTurn?.length ?? 0) + (agent.inbox.nextStep?.length ?? 0);
				if (n > 0) {
					agent.inbox.clear();
					log(`中断后丢弃队列中未处理的消息 ${n} 条`);
				}
			} catch (e) {
				log(`清空队列失败: ${e?.message ?? e}`);
			}
		}, 50);
	}
	// ── 过程推送（设置页「消息推送内容」4 个勾选项：待办 📋 / 交付 📎 / 工具行 🔧 / 旁白 💬）──
	// 每条消息单独成一条 QQ 消息、实时发出（不合并、不丢弃）；
	// 仅保留 0.6s 最小间隔以防触发 QQ 频控。每日额度 1000 条，正常用量足够。
	const progressQueue = [];
	let progressBusy = false;
	const PROGRESS_BACKLOG_MAX = 200; // 防止异常刷屏：积压超限则丢弃并记日志
	function openidForSession(sid) {
		for (const [o, p] of Object.entries(state.openids)) if (p?.sessionId === sid) return o;
		return null;
	}
	/**
	 * 本会话该找谁：先看绑定（QQ 用户 /会话 接入的），再看本轮 run 的 openid ——
	 * 后者覆盖"无头定时会话"（没人绑定它，但它是替某个 QQ 用户跑的）。
	 */
	function ownerOpenidForSession(sid) {
		return openidForSession(sid) ?? runs.get(sid)?.openid ?? null;
	}
	/** 本轮工具调用记录（sessionId -> 行数组）：超时/中断时打包回放「工作全貌」 */
	const toolLog = new Map();
	function recordTool(sid, line) {
		if (!sid) return;
		const arr = toolLog.get(sid) ?? [];
		arr.push(line);
		if (arr.length > 100) arr.shift();
		toolLog.set(sid, arr);
	}
	function takeToolDigest(sid) {
		const arr = toolLog.get(sid);
		if (arr) toolLog.delete(sid);
		return arr ?? [];
	}
	function pushProgress(openid, line) {
		if (progressQueue.length >= PROGRESS_BACKLOG_MAX) {
			log(`进度积压超过 ${PROGRESS_BACKLOG_MAX} 条，丢弃：${line.slice(0, 40)}`);
			return;
		}
		progressQueue.push({ openid, line });
		if (progressBusy) return;
		progressBusy = true;
		(async () => {
			try {
				while (progressQueue.length) {
					const item = progressQueue.shift();
					try {
						await sendText(item.openid, item.line);
					} catch (e) {
						log(`进度推送失败: ${e?.message ?? e}`);
					}
					await new Promise((res) => setTimeout(res, 600));
				}
			} finally {
				progressBusy = false;
			}
		})();
	}
	// ── 按需发文件到 QQ（qq_send_file 工具）────────────────────────────────────
	// 官方 file_type=4 可发任意格式（硬限 200MB/个）；图片/视频/语音按对应类型发（QQ 里直接展示）。
	// **只在用户点名要文件时发**（模型调 qq_send_file）；present 的产物不再自动外发 ——
	// 插件开发的中间产物（源码/测试）不应该往手机上灌。
	const DELIVER_FILE_MAX = 5; // 一次最多发几个，防刷屏/防额度
	/** 把一批本机文件发到 QQ（分片上传 → 富媒体消息）；返回逐条结果供工具回报。 */
	async function sendFilesToQq(openid, files) {
		const list = (Array.isArray(files) ? files : []).slice(0, DELIVER_FILE_MAX);
		const results = [];
		for (const f of list) {
			const p = String(f?.path ?? '');
			try {
				if (!p) continue;
				const st = statSync(p);
				if (!st.isFile()) {
					results.push(`✗ ${shortPath(p)}：不是普通文件`);
					continue;
				}
				if (st.size > QQ_FILE_HARD_LIMIT) {
					results.push(`✗ ${basename(p)}：${(st.size / 1048576).toFixed(1)}MB 超过 QQ 硬限 200MB（文件仍在电脑上：${p}）`);
					continue;
				}
				const c = readCfg();
				const token = await ensureToken(c.appId, c.appSecret);
				const { fileInfo, fileType } = await uploadQqFile(apiBase(c), token, openid, { name: basename(p), buf: readFileSync(p) });
				await sendQqMedia(apiBase(c), token, openid, fileInfo);
				log(`文件已发到 QQ：${basename(p)}（${st.size} B, file_type=${fileType}）`);
				results.push(`✓ ${basename(p)}（${(st.size / 1024).toFixed(1)}KB）`);
			} catch (e) {
				log(`发文件失败 ${p}: ${e?.message ?? e}`);
				results.push(`✗ ${shortPath(p)}：${e?.message ?? e}`);
			}
		}
		return results;
	}
	// ── qq_send 工具：让我能主动往 QQ 发一条消息（默认发本会话接入的那个用户）─────
	// 用官方 @deepseek-ai/dsh-tools 的 defineTool 注册（模板见 dsh-tool-present）。
	// 动态 import + catch：万一这个包不在，只是少一个工具，桥接本身照常工作。
	/** 收件人：本会话（或沿 parentSession 上溯）接入的 QQ 用户；无头定时会话看本轮 run；只有一个已知用户时才兜底。 */
	function qqSendTarget(session) {
		let s = session ?? null;
		for (let hop = 0; hop < 4 && s; hop += 1) {
			const sid = s.header?.id ?? s.id;
			const openid = sid ? ownerOpenidForSession(sid) : null;
			if (openid) return { openid, how: '本会话接入的 QQ 用户' };
			const parent = s.header?.parentSession;
			s = parent ? (svc.sessions?.get?.(parent) ?? null) : null;
		}
		const known = Object.keys(state.openids ?? {});
		if (known.length === 1) return { openid: known[0], how: '唯一已知 QQ 用户（本会话未接入 QQ）' };
		throw new Error(
			known.length === 0 ? '还没有任何 QQ 用户和机器人说过话，无法推送' : '本会话未接入 QQ，且有多个已知用户，无法确定收件人',
		);
	}
	ctx.inject(['tools'], (toolCtx) => {
		import('@deepseek-ai/dsh-tools').then(({ defineTool }) => {
			toolCtx.tools.register(defineTool({
				name: 'qq_send',
				description: 'Send one plain-text QQ message to the user attached to this session, through the QQ bridge. Use it when the user asks you to send them a message / notify them on QQ (e.g. "发条消息给我", "提醒我一下"). Fails when the bridge is disabled, the text is empty, or no QQ recipient can be resolved.',
				parameters: {
					text: { type: 'string', required: true, description: 'Plain-text message body (≤2000 chars; longer text is truncated with …).' },
				},
				output: {
					schema: {
						type: 'object',
						additionalProperties: false,
						properties: {
							ok: { type: 'boolean', required: true },
							preview: { type: 'string', required: true },
						},
					},
					render: (_args, value) => [{ type: 'text', text: value.preview }],
				},
				async execute(args, exec) {
					if (!BOT.running) throw new Error('QQ 桥接未启用：请到设置页打开「启用桥接」');
					const body = qqSendBody(args?.text);
					if (body === null) throw new Error('消息内容为空');
					const target = qqSendTarget(exec?.agent?.session);
					await sendText(target.openid, body);
					log(`qq_send → ${String(target.openid).slice(0, 8)}…（${body.length} 字，${target.how}）`);
					return { ok: true, preview: `已发往 QQ（${body.length} 字，${target.how}）：${oneLine(body, 60)}` };
				},
			}));
			toolCtx.tools.register(defineTool({
				name: 'qq_send_file',
				description: 'Send one or more existing local files to the QQ user through the bridge (chunked upload → QQ file card; images/videos/voice render inline; 200MB per file, at most 5 files). Call this ONLY when the user explicitly asks you to send them a file (e.g. "把 X 发我"); never call it for ordinary task artifacts such as plugin sources or test files.',
				parameters: {
					paths: {
						type: 'array',
						required: true,
						items: { type: 'string', description: 'Path of an existing regular file (relative paths use the session working directory).' },
					},
				},
				output: {
					schema: {
						type: 'object',
						additionalProperties: false,
						properties: {
							ok: { type: 'boolean', required: true },
							message: { type: 'string', required: true },
						},
					},
					render: (_args, value) => [{ type: 'text', text: value.message }],
				},
				async execute(args, exec) {
					if (!BOT.running) throw new Error('QQ 桥接未启用：请到设置页打开「启用桥接」');
					const paths = (Array.isArray(args?.paths) ? args.paths : []).map((p) => String(p ?? '').trim()).filter(Boolean);
					if (paths.length === 0) throw new Error('paths 不能为空');
					if (paths.length > DELIVER_FILE_MAX) throw new Error(`一次最多发 ${DELIVER_FILE_MAX} 个文件（收到 ${paths.length}）`);
					const target = qqSendTarget(exec?.agent?.session);
					const results = await sendFilesToQq(target.openid, paths.map((path) => ({ path })));
					const okCount = results.filter((r) => r.startsWith('✓')).length;
					return { ok: okCount > 0, message: `发往 QQ（${target.how}）：\n${results.join('\n')}` };
				},
			}));
			toolCtx.tools.register(defineTool({
				name: 'qq_schedule',
				description: 'Schedule a QQ push through the bridge: either a fixed reminder text, or a prompt that the agent runs at that time (its answer goes back to QQ). Use action=create to add, action=list to show pending tasks, action=cancel with an id to remove one. One-shot: inMinutes. Recurring: atTime "HH:MM" (+ repeat daily|weekdays|once, default daily). Tasks persist across restarts; a task missed while the instance was down is fired once on startup.',
				parameters: {
					action: { type: 'string', required: true, description: "create | list | cancel" },
					text: { type: 'string', description: 'Fixed reminder text (create; give either text or prompt).' },
					prompt: { type: 'string', description: 'Prompt the agent runs at that time; its final answer is pushed to QQ (create; give either text or prompt).' },
					inMinutes: { type: 'integer', description: 'Fire once after N minutes (create; alternative to atTime).' },
					atTime: { type: 'string', description: 'Local "HH:MM" for recurring tasks (create; alternative to inMinutes).' },
					repeat: { type: 'string', description: 'once | daily | weekdays (create with atTime; default daily).' },
					session: { type: 'string', description: "Where a prompt runs: 'new' (default) = a fresh headless session created in this session's workspace; 'current' = run inside this session." },
					id: { type: 'string', description: 'Task id to cancel (action=cancel; see action=list).' },
				},
				output: {
					schema: {
						type: 'object',
						additionalProperties: false,
						properties: {
							ok: { type: 'boolean', required: true },
							message: { type: 'string', required: true },
						},
					},
					render: (_args, value) => [{ type: 'text', text: value.message }],
				},
				async execute(args, exec) {
					if (!BOT.running) throw new Error('QQ 桥接未启用：请到设置页打开「启用桥接」');
					const action = String(args?.action ?? '').trim();
					const now = Date.now();
					if (action === 'list') {
						if (schedule.tasks.length === 0) return { ok: true, message: '当前没有定时任务' };
						const lines = [...schedule.tasks].sort((a, b) => a.at - b.at).map((t) => scheduleLine(t, now));
						return { ok: true, message: `${schedule.tasks.length} 个定时任务：\n${lines.join('\n')}` };
					}
					if (action === 'cancel') {
						const id = String(args?.id ?? '').trim();
						const before = schedule.tasks.length;
						schedule.tasks = schedule.tasks.filter((t) => t.id !== id);
						if (schedule.tasks.length === before) throw new Error(`没有 id=${id} 的定时任务（用 action=list 看现有任务）`);
						await saveSchedule();
						log(`定时任务 ${id} 已取消`);
						return { ok: true, message: `已取消定时任务 ${id}` };
					}
					if (action !== 'create') throw new Error(`action 只能是 create/list/cancel（收到 ${action || '空'}）`);
					if (schedule.tasks.length >= SCHED_MAX_TASKS) throw new Error(`定时任务上限 ${SCHED_MAX_TASKS} 个，先取消一些`);
					const session = exec?.agent?.session;
					const sid = session?.header?.id ?? session?.id ?? null;
					let openid = null;
					try {
						openid = qqSendTarget(session).openid;
					} catch {
						/* 只在 create 时不必非要收件人：到点再解析 */
					}
					const built = buildScheduleTask({ ...args, cwd: session?.header?.cwd }, now, sid, openid);
					if (!built.ok) throw new Error(built.error);
					schedule.tasks.push(built.task);
					await saveSchedule();
					log(`新定时任务 ${built.task.id}（${scheduleLine(built.task, now)}）`);
					return { ok: true, message: `已排定：${scheduleLine(built.task, now)}` };
				},
			}));
		}).catch((e) => {
			log(`注册 qq_send / qq_schedule 工具失败（只是少工具，桥接不受影响）: ${e?.message ?? e}`);
		});
	});
	// ── 定时推送调度器：qq_schedule 工具 + /提醒 命令 ─────────────────────────
	// 任务落盘（qq-schedule.json），每 20s 扫一次；实例当时没开 → 启动后补发一次
	// （一次性任务超过 24h 就丢弃，避免开机刷出一堆过期提醒）。
	const SCHED_CATCHUP_MAX_MS = 24 * 60 * 60 * 1000;
	const SCHED_TICK_MS = 20000;
	let schedBusy = false;
	/** 收件人：任务指定 → 会话接入的用户 → 唯一已知用户。 */
	function schedTarget(task) {
		if (task.openid) return task.openid;
		return qqSendTarget(svc.sessions?.get?.(task.sessionId) ?? { header: { id: task.sessionId } });
	}
	/** 到点干活：先报一句"定时任务"，再按 text 发固定文本 / 按 prompt 让 agent 生成后回 QQ。 */
	async function fireTask(task, catchUp) {
		const openid = schedTarget(task);
		const tag = catchUp ? '⏰ 补发定时任务' : '⏰ 定时任务';
		try {
			if (task.text) {
				await sendText(openid, `${tag}：${task.text}`);
			} else {
				// 执行落点：无头会话（每次新建，落在创建任务的工作区并归组）或创建它的会话
				let sid = task.sessionId;
				if (task.mode === 'new') {
					const created = await svc.sessionController.create(task.cwd ? { cwd: task.cwd } : {});
					sid = created?.sessionId ?? created?.id;
					if (!sid) throw new Error('无头会话创建失败（未返回 sessionId）');
					if (task.cwd) await attachToWorkspace(sid, task.cwd);
					log(`定时任务 ${task.id} 起无头会话 ${displayShort(sid)}（${task.cwd ?? 'DSH 默认目录'}）`);
				}
				const before = await currentTurn(sid);
				await sendText(openid, `${tag}：${oneLine(task.prompt, 60)}`);
				await submitPrompt(sid, task.prompt);
				ensureReplier(openid, sid, before); // 结果由回复观察器发回 QQ
			}
			log(`定时任务 ${task.id} 已触发（${catchUp ? '补发' : '准点'}，${task.text ? '文本' : task.mode === 'new' ? '无头会话' : '当前会话'}）`);
		} catch (e) {
			log(`定时任务 ${task.id} 触发失败: ${e?.message ?? e}`);
			try {
				await sendText(openid, `⚠️ 定时任务 ${task.id} 触发失败：${e?.message ?? e}`);
			} catch {
				/* ignore */
			}
		}
	}
	/** 扫描并执行到期任务；catchUp=true 时把「已过期但≤24h」的也补发一次。 */
	async function schedulerTick(catchUp) {
		if (schedBusy) return;
		schedBusy = true;
		try {
			const now = Date.now();
			let changed = false;
			for (const task of [...schedule.tasks]) {
				if (!task?.at || task.at > now) continue;
				const overdue = now - task.at;
				const shouldFire = catchUp ? overdue <= SCHED_CATCHUP_MAX_MS : true;
				// 先排下一次（循环任务）或摘掉（一次性），再执行 —— 触发过程中崩了也不会重复刷
				if (task.repeat === 'once') {
					schedule.tasks = schedule.tasks.filter((t) => t.id !== task.id);
				} else {
					const next = nextAtTime(task.atTime, task.repeat, now);
					task.at = next ?? now + 24 * 3600 * 1000;
				}
				task.lastFiredAt = now;
				changed = true;
				await saveSchedule();
				if (shouldFire) await fireTask(task, catchUp && overdue > SCHED_TICK_MS * 2);
				else log(`定时任务 ${task.id} 过期 ${Math.round(overdue / 60000)} 分钟（>24h），丢弃`);
			}
			if (changed) await saveSchedule();
		} finally {
			schedBusy = false;
		}
	}
	ctx.effect(() => {
		void loadSchedule().then(() => schedulerTick(true)); // 启动时补发
		const timer = setInterval(() => void schedulerTick(false), SCHED_TICK_MS);
		timer.unref?.();
		return () => clearInterval(timer);
	}, 'qq-bridge: scheduler');
	// ── 通路标记：每条用户消息都记下"来自哪条通路"，供模型判断该用哪条路交付 ────
	ctx.on('session/event', (session, event) => {
		if (event?.type !== 'user/message') return;
		const src = event.data?.source ?? {};
		if (src.kind !== 'user') return; // 插件/skill 注入的不算用户消息
		const sid = session?.id ?? session?.header?.id;
		if (!sid) return;
		const text = (event.data?.content ?? []).map((b) => String(b?.text ?? '')).join(' ').replace(/\s+/g, ' ').trim();
		lastInbound = {
			sessionId: sid,
			channel: src.clientTimeZone ? 'web' : 'qq', // 浏览器 prompt 才带 clientTimeZone
			at: Date.now(),
			text: text.slice(0, 40),
		};
		void saveLastInbound();
	});
	// ── 会话状态推送：完成 / 等你选择 / 等你审批 → QQ ─────────────────────────
	// 开关：设置页「QQ接受会话完成状态」(notifyOnComplete)；QQ 正在聊的那个会话不推
	// （正文/问题/审批已经直接发给那个用户了），子会话不推。
	// 用途：人不在电脑前时，任务跑完或卡在等你输入，由 QQ 主动告知。
	const titleCache = new Map(); // sessionId -> 最近一次 session/title，推送取名不必读盘
	const noticeQueue = [];
	const NOTICE_BACKLOG_MAX = 50; // 防异常刷屏
	let noticeBusy = false;
	ctx.on('session/event', (session, event) => {
		if (event?.type === 'session/title') {
			const sid = session?.id ?? session?.header?.id;
			if (sid && event.data?.title) titleCache.set(sid, String(event.data.title));
			return;
		}
		if (event?.type !== 'turn/end') return; // 高频事件（消息/工具）直接返回，不查设置
		const sid = completionNoticeFor(session, event, readCfg());
		if (sid) queueSessionNotice(session, sid, async () => `[${await sessionLabel(session, sid)}]已完成`);
	});
	/** 会话名：session/title 缓存 → 标题快照 → 工作区名 → 短 ID。 */
	async function sessionLabel(session, sid) {
		const cached = titleCache.get(sid);
		if (cached) return cached;
		try {
			const trs = await svc.sessionQuery.readTitleSnapshots([sid]);
			const t = trs?.[0];
			const title = t?.status === 'fulfilled' ? t.value?.title?.title : null;
			if (title) {
				titleCache.set(sid, String(title));
				return String(title);
			}
		} catch {
			/* 取不到标题就退到兜底名 */
		}
		const cwd = session?.header?.cwd;
		return cwd ? `工作区 ${cwdLabel(cwd)}` : `会话 ${displayShort(sid)}`;
	}
	/**
	 * 「这个会话在等你输入」推送入口（选择题 / 审批都走这里）。
	 * tail 例：`在等你选择：要跑哪个方案？`、`需要审批：Bash`。
	 */
	function notifyWaiting(session, tail) {
		const sid = noticeSidFor(session, readCfg());
		if (!sid) return;
		queueSessionNotice(session, sid, async () => `[${await sessionLabel(session, sid)}]${tail}`);
	}
	/** 串行推送状态通知（一条 QQ 消息一个人一次；避免并发触发频控）。 */
	function queueSessionNotice(session, sid, buildLine) {
		if (!BOT.running) return;
		if (noticeQueue.length >= NOTICE_BACKLOG_MAX) {
			log(`状态通知积压超过 ${NOTICE_BACKLOG_MAX} 条，丢弃：${sid}`);
			return;
		}
		noticeQueue.push({ session, sid, buildLine });
		if (noticeBusy) return;
		noticeBusy = true;
		(async () => {
			try {
				while (noticeQueue.length) {
					const item = noticeQueue.shift();
					try {
						const targets = noticeTargets(state, item.sid);
						if (!targets.length) continue; // 唯一用户在聊这个会话 → 无需通知
						const line = await item.buildLine(item.session, item.sid);
						for (const openid of targets) {
							try {
								await sendText(openid, line);
							} catch (e) {
								log(`状态通知发送失败（${String(openid).slice(0, 8)}…）: ${e?.message ?? e}`);
							}
						}
						log(`状态通知已推送：${line}（${targets.length} 人）`);
					} catch (e) {
						log(`状态通知异常: ${e?.message ?? e}`);
					}
				}
			} finally {
				noticeBusy = false;
			}
		})();
	}
	// ── 命令 ──────────────────────────────────────────────────────────────
	async function cmdProfile() {
		const insts = await readRegistry();
		const keys = Object.keys(insts);
		if (!keys.length) return '当前没有检测到运行中的 DSH 实例（registry 为空）。';
		const lines = ['📡 运行中的 DSH 实例：', ''];
		keys
			.sort((a, b) => (insts[a]?.webPort ?? 0) - (insts[b]?.webPort ?? 0))
			.forEach((pid, idx) => {
				const e = insts[pid] || {};
				const cur = String(e.webPort) === String(webPort) ? '  ←当前' : '';
				lines.push(`${idx + 1}. web:${e.webPort ?? '?'}  bridge:${e.bridgePort ?? '?'}  pid:${pid}${cur}`);
				lines.push(`   启动: ${fmtTime(e.startedAt)}   cwd: ${e.cwd ?? '?'}`);
			});
		lines.push('', `本插件已绑定当前实例（web:${webPort}）。跨实例对话请在 Web UI 操作。`);
		return lines.join('\n');
	}
	/**
	 * 已删除但尚未从持久化清除的会话 ID（DSH 两阶段删除：先入 trash/pendingPurge，稍后才真正 purge）。
	 * listSessions() 走持久化层，因此这些会话仍会被返回——必须在此显式排除。
	 */
	function deletedSessionIds() {
		try {
			const file = join(dshHome(), 'profiles', profile, 'dsh-session-manager.json');
			const raw = JSON.parse(readFileSync(file, 'utf8'));
			return new Set([...Object.keys(raw?.trash ?? {}), ...Object.keys(raw?.pendingPurge ?? {})]);
		} catch {
			return new Set();
		}
	}
	async function cmdSessions(openid) {
		let records;
		try {
			records = await svc.sessionQuery.listSessions();
		} catch (e) {
			return `❌ 拿不到会话列表：${e?.message ?? e}`;
		}
		// 只列主会话（与 Web 左侧一致）：排除子会话/subagent——子会话带 parentSession 或 origin==='subagent'
		records = records.filter((r) => !r?.header?.parentSession && r?.header?.origin !== 'subagent');
		// 排除已删除（待清除）的会话
		const deleted = deletedSessionIds();
		if (deleted.size) records = records.filter((r) => !deleted.has(r?.header?.id));
		const picked = [...records].sort((a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0)).slice(0, SESSION_LIST_CAP);
		// 标题（批量）+ 轮数/预览（readSurface）
		let titles = new Map();
		try {
			const trs = await svc.sessionQuery.readTitleSnapshots(picked.map((r) => r.header.id));
			for (const tr of trs) {
				if (tr?.status === 'fulfilled' && tr.value?.title) titles.set(tr.sessionId, tr.value.title.title);
			}
		} catch {
			/* 标题失败不影响列表 */
		}
		const rows = await Promise.all(
			picked.map(async (r) => {
				const h = r.header;
				let userMsgs = 0;
				let lastActive = null;
				let lastUserPreview = null;
				let lastAssistantPreview = null;
				try {
					const surf = await svc.sessionQuery.readSurface(h.id);
					const ue = surf.events.filter((e) => e.type === 'user/message');
					const ae = surf.events.filter((e) => e.type === 'assistant/message');
					userMsgs = ue.length;
					lastUserPreview = textOfEvent(ue.at(-1));
					lastAssistantPreview = textOfEvent(ae.at(-1));
					const lastEv = surf.events.at(-1);
					if (lastEv && typeof lastEv.time === 'number') lastActive = lastEv.time;
				} catch {
					/* 单条失败跳过 */
				}
				return {
					id: h.id,
					cwd: h.cwd ?? null,
					agentPreset: h.agentPreset ?? null,
					createdAt: h.createdAt ?? null,
					title: titles.get(h.id) ?? null,
					userMsgs,
					lastActive,
					lastUserPreview,
					lastAssistantPreview,
				};
			}),
		);
		// 按最近活跃排序（显示时间同步为最近活跃）：正在用的会话排前面
		rows.sort((a, b) => (b.lastActive ?? b.createdAt ?? 0) - (a.lastActive ?? a.createdAt ?? 0));
		// 空壳会话（无标题且无任何用户消息）不展示
		const visible = rows.filter((r) => r.title || r.userMsgs > 0);
		if (!visible.length) return '该实例上没有持久化的会话（可能所有会话都还在运行的 agent 内存中）。';
		const groups = new Map();
		for (const s of visible) {
			const key = s.cwd ?? '(未指定)';
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(s);
		}
		const lines = [`💬 会话列表（web:${webPort}，按工作区）：`, ''];
		for (const [cwd, sesses] of groups) {
			lines.push(`工作区[${cwdLabel(cwd)}]`);
			sesses.forEach((s) => {
				const short = shortIdFor(s.id);
				const title = s.title || s.lastUserPreview || s.lastAssistantPreview || s.id.slice(8, 20);
				const cur = perUser(openid).sessionId === s.id ? '  ←当前' : '';
				lines.push(`[${short}] ${String(title).slice(0, 26)}${cur}`);
				lines.push(`     ${fmtTime(s.lastActive ?? s.createdAt)} · ${s.userMsgs}问 · ${s.agentPreset ?? 'standard'}`);
			});
			lines.push('');
		}
		saveState();
		lines.push('用 /会话 <4位ID> 接入对应会话（ID 固定，跨重启不变）；不带 ID 发消息将新建会话。');
		return lines.join('\n');
	}
	function cmdAttach(openid, arg) {
		const short = String(arg || '').trim();
		const sid = state.map[short];
		if (!sid) return `找不到会话 [${short}]。用 /会话 查看列表。`;
		perUser(openid).sessionId = sid;
		saveState();
		return `✅ 已接入会话 [${short}]。后续消息都会继续这个会话。`;
	}
	// ── /new：列出工作区 → 回数字即在该工作区新建会话并接入 ────────────────
	const pendingNew = {}; // openid -> { list: string[], at: number, mode: { id, name } | null }
	const NEW_TTL_MS = 10 * 60 * 1000;
	/** 已知工作区（取自历史会话的 cwd，按最近使用排序；排除已删会话与目录已不存在的旧路径） */
	async function workspaceList() {
		const records = await svc.sessionQuery.listSessions();
		const deleted = deletedSessionIds();
		const byCwd = new Map();
		for (const r of records) {
			const h = r?.header;
			const cwd = h?.cwd;
			if (!cwd || h.parentSession || h.origin === 'subagent') continue;
			if (deleted.has(h.id)) continue;
			let ok = false;
			try {
				ok = existsSync(cwd);
			} catch {
				/* 访问失败按已删除处理 */
			}
			if (!ok) continue;
			const t = h.createdAt ?? 0;
			if (!byCwd.has(cwd) || t > byCwd.get(cwd)) byCwd.set(cwd, t);
		}
		return [...byCwd.entries()].sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd);
	}
	// ── /new 的会话模式（agent preset）支持 ─────────────────────────────────────
	// 「模式」= DSH 的 agent preset，Web UI 里叫「Agent 模式」，与那份名单同源。
	// 序号 = roster 顺序（各 preset 的 preset.yml order，缺省排末尾），与 Web UI 选择器
	// 完全一致；broken 的 preset 不进清单。mode= 既接受序号，也接受 preset id。
	/** 可用模式清单 { rows: [{ id, name }], defaultId }；roster 未挂载时返回 null */
	async function modeCatalog() {
		const presets = svc.agentPresets;
		if (!presets || typeof presets.list !== 'function') return null;
		try {
			const rows = (await presets.list())
				.filter((p) => p && typeof p.id === 'string' && p.broken === undefined)
				.map((p) => ({ id: p.id, name: p.name ?? p.id }));
			if (!rows.length) return null;
			let defaultId = null;
			try {
				defaultId = presets.defaultId ?? null; // 只影响「←默认」标记，读不到不算错
			} catch {
				/* ignore */
			}
			return { rows, defaultId };
		} catch (e) {
			log(`模式清单读取失败（/new 退化为只选工作区）: ${e?.message ?? e}`);
			return null;
		}
	}
	/** 模式清单文本（序号可直接写进 mode=） */
	function modeListText(catalog) {
		if (!catalog || !catalog.rows.length) return '（当前实例没有可用的会话模式）';
		const lines = ['可用模式（不填 mode= 则用默认模式；也可写模式 id）：'];
		catalog.rows.forEach((p, i) => {
			const mark = p.id === catalog.defaultId ? '   ←默认' : '';
			lines.push(`  ${i + 1}  ${p.name}   ${p.id}${mark}`);
		});
		return lines.join('\n');
	}
	/** 解析 mode= 的值：纯数字 → 序号；否则按 preset id 精确匹配。返回 { id, name } 或 { error } */
	async function resolveMode(token) {
		const raw = String(token ?? '').trim();
		if (!raw) return { error: '❌ mode= 后面没写模式（见 /帮助）。' };
		const catalog = await modeCatalog();
		if (!catalog) return { error: '❌ 当前实例没有可用的会话模式（agentPresets 未挂载）；/new 只支持选工作区。' };
		if (/^\d+$/.test(raw)) {
			const hit = catalog.rows[Number(raw) - 1];
			if (!hit) return { error: `❌ 模式序号超范围（1-${catalog.rows.length}）。\n\n${modeListText(catalog)}` };
			return { id: hit.id, name: hit.name };
		}
		const hit = catalog.rows.find((p) => p.id === raw);
		if (hit) return { id: hit.id, name: hit.name };
		// 不在可用清单里：区分「不认识这个 id」与「认识但 discovery 判为 broken」
		try {
			const broken = (await svc.agentPresets.list()).find((p) => p && p.id === raw && p.broken !== undefined);
			if (broken) return { error: `❌ 模式 "${raw}" 当前不可用：${broken.broken}` };
		} catch {
			/* ignore：按未知模式处理 */
		}
		return { error: `❌ 未知模式 "${raw}"。\n\n${modeListText(catalog)}` };
	}
	/** /new 参数解析：位置参数（纯数字）= 工作区号；k=v = 选项（当前仅 mode） */
	function parseNewArgs(arg) {
		const out = { workspaceNo: undefined, modeToken: undefined, unknownKeys: [], stray: [] };
		for (const tok of String(arg ?? '').trim().split(/\s+/).filter(Boolean)) {
			const eq = tok.indexOf('=');
			if (eq > 0) {
				const key = tok.slice(0, eq).trim().toLowerCase();
				if (key === 'mode') {
					if (out.modeToken !== undefined) return { error: '❌ mode= 写了两次，只给一个。' };
					out.modeToken = tok.slice(eq + 1).trim();
				} else {
					out.unknownKeys.push(key);
				}
			} else if (/^\d+$/.test(tok)) {
				if (out.workspaceNo === undefined) out.workspaceNo = Number(tok);
				else out.stray.push(tok);
			} else {
				out.stray.push(tok);
			}
		}
		return out;
	}
	function newListText(list, catalog, mode) {
		const lines = ['📂 选择工作区（回复数字即可在其下新建会话）：', ''];
		list.forEach((cwd, i) => lines.push(`${i + 1}. [${cwdLabel(cwd)}]  ${cwd}`));
		lines.push('');
		if (mode) lines.push(`将使用模式：${mode.name}（${mode.id}）`, '');
		lines.push(modeListText(catalog), '');
		lines.push(`回复 1-${list.length}；也可直接 /new <工作区号> mode=<模式>。`);
		return lines.join('\n');
	}
	/**
	 * 把会话记账进 Workspace Registry（Web UI 左侧分组依据）；失败只记日志。
	 * 光有 cwd 不算归组：先按路径登记工作区（幂等），再 attachSession。
	 * attachSession 内部会校验 realpath(会话 cwd) === 工作区 path，不匹配会抛错。
	 */
	async function attachToWorkspace(sid, cwd) {
		try {
			const reg = svc.workspaceRegistry;
			if (!reg || typeof reg.resolveByPath !== 'function') return;
			let ws = await reg.resolveByPath(cwd);
			if (!ws && typeof reg.create === 'function') ws = await reg.create(cwd);
			if (ws && typeof ws.attachSession === 'function') await ws.attachSession(sid);
		} catch (e) {
			log(`workspace 记账失败（会话已建，仅影响 Web UI 分组）: ${e?.message ?? e}`);
		}
	}
	/** 兜底新建的 cwd：最近活跃的工作区；取不到（无历史/查询失败）返回 null，交给 DSH 默认。 */
	async function defaultCwdForNew() {
		try {
			return preferredNewCwd(await workspaceList());
		} catch (e) {
			log(`取最近工作区失败（兜底新建退回 DSH 默认目录）: ${e?.message ?? e}`);
			return null;
		}
	}
	/** 在指定工作区新建会话并接入（并把它记账进 Workspace Registry，供 Web UI 分组） */
	/** 在指定工作区新建会话并接入；opts.mode 非空时指定 agent preset（会话模式）。 */
	async function makeSessionIn(openid, cwd, opts) {
		const mode = opts?.mode ?? null;
		let created;
		try {
			created = await svc.sessionController.create(mode ? { cwd, agentPreset: mode.id } : { cwd });
		} catch (e) {
			return `❌ 新建失败：${e?.message ?? e}`;
		}
		const sid = created?.sessionId ?? created?.id;
		if (!sid) return '❌ 新建失败：未返回会话 ID。';
		await attachToWorkspace(sid, cwd);
		perUser(openid).sessionId = sid;
		const short = shortIdFor(sid);
		saveState();
		const modeLabel = mode ? `（${mode.name}）` : '';
		return `✅ 已在工作区 [${cwdLabel(cwd)}] 新建会话 [${short}]${modeLabel} 并接入（之后的普通消息都发到这里；/会话 可看列表）。`;
	}
	async function cmdNew(openid, arg) {
		const parsed = parseNewArgs(arg);
		if (parsed.error) return parsed.error;
		if (parsed.stray.length) {
			return `❌ 无法识别的参数：${parsed.stray.join(' ')}。\n工作区号直接写数字，模式写 mode=<模式>（见 /帮助）。`;
		}
		if (parsed.unknownKeys.length) {
			return `❌ 暂不支持的选项：${parsed.unknownKeys.join(' ')}（当前 /new 支持 mode=<模式>）。`;
		}
		let mode = null;
		if (parsed.modeToken !== undefined) {
			const r = await resolveMode(parsed.modeToken);
			if (r.error) return r.error;
			mode = r;
		}
		const list = await workspaceList();
		if (!list.length) return '当前没有任何已知工作区（还没有历史会话）。';
		if (parsed.workspaceNo !== undefined) {
			if (parsed.workspaceNo > list.length) {
				return `❌ 编号超范围（1-${list.length}）。\n\n${newListText(list, await modeCatalog(), mode)}`;
			}
			return makeSessionIn(openid, list[parsed.workspaceNo - 1], { mode });
		}
		pendingNew[openid] = { list, at: Date.now(), mode };
		return newListText(list, await modeCatalog(), mode);
	}
	// 纯数字回复 → 消费待选工作区（返回 true 表示已消费该消息）
	handleNewPick = (openid, text) => {
		const pend = pendingNew[openid];
		if (!pend) return false;
		if (Date.now() - pend.at > NEW_TTL_MS) {
			delete pendingNew[openid];
			return false;
		}
		const n = Number(String(text ?? '').trim());
		if (!Number.isInteger(n) || n <= 0) return false;
		delete pendingNew[openid];
		if (n > pend.list.length) {
			pendingNew[openid] = { list: pend.list, at: Date.now(), mode: pend.mode ?? null };
			modeCatalog().then((cat) => sendText(openid, `❌ 编号超范围（1-${pend.list.length}）。\n\n${newListText(pend.list, cat, pend.mode)}`)).catch(() => {});
			return true;
		}
		makeSessionIn(openid, pend.list[n - 1], { mode: pend.mode ?? null })
			.then((msg) => sendText(openid, msg))
			.catch((e) => sendText(openid, `❌ 新建失败：${e?.message ?? e}`));
		return true;
	};
	function cmdInstance(arg) {
		if (arg) return '单插件模式已绑定当前实例，不支持经 QQ 跨实例切换。跨实例对话请在 Web UI 操作。';
		return cmdProfile();
	}
	async function cmdStatus() {
		const lines = ['📊 状态检查：', ''];
		lines.push(`插件: 已加载 pid=${process.pid} profile=${profile}`);
		lines.push(`QQ: ${BOT.running ? (BOT.connected ? '已连接 ✓' : '连接中…') : '未启用 ✗（设置页打开"启用"开关）'}`);
		if (BOT.url) lines.push(`   WS: ${BOT.url}`);
		try {
			const liveAgents = svc.agents ? svc.agents.list().length : 0;
			lines.push(`实例: web:${webPort}  liveAgents:${liveAgents}`);
		} catch {
			lines.push(`实例: web:${webPort}`);
		}
		try {
			const n = (await svc.sessionQuery.listSessions()).length;
			lines.push(`会话: ${n} 个`);
		} catch {
			/* skip */
		}
		lines.push('', '指令: /profile /会话 /会话 <ID> /new /权限 /提醒 /实例 <端口> /状态 /帮助');
		return lines.join('\n');
	}
	const CMD_HELP = [
		'QQ-DSH 桥接（单插件版）',
		'只回复最终结果，思考过程与工具调用不展示。',
		'指令：',
		'  /profile        查看实例',
		'  /会话           列出会话（按工作区）',
		'  /会话 <4位ID>    接入某个会话（ID 固定，跨重启不变）',
		'  /new            新建会话（可带 mode=<模式>；模式清单见 /new 提示）',
		'  /实例 <端口>     查看实例（跨实例请回 Web UI）',
		'  /状态           全链路体检',
		'  /approve        允许当前会话的待审批请求',
		'  /deny           拒绝待审批请求',
		'  /跳过           跳过待回答的问题',
		'  /stop           停止当前会话正在执行的工作',
		'  /提醒           列出定时推送任务',
		'  /提醒 删 <ID>   取消某个定时任务（ID 见 /提醒 列表）',
		'  /权限           查看当前会话权限（sandbox + approval）',
		'  /权限 <预设名>    切换当前会话权限（如 danger-full-access）',
		'  /权限 重置       回默认权限 + 审批推 QQ',
		'  /帮助           本帮助',
		'普通消息：发给当前接入的会话；未接入则自动新建会话。',
	].join('\n');
	function handleCommand(openid, text) {
		const [head, ...rest] = text.split(/\s+/);
		const arg = rest.join(' ').trim();
		switch (head) {
			case '/profile':
				return cmdProfile();
			case '/实例':
				return arg ? cmdInstance(arg) : cmdProfile();
			case '/会话':
				return arg ? cmdAttach(openid, arg) : cmdSessions(openid);
			case '/new':
			case '/新建':
				return cmdNew(openid, arg);
			case '/状态':
			case '/status':
				return cmdStatus();
			case '/approve':
			case '/允许':
				return cmdApprove(openid, true);
			case '/deny':
			case '/拒绝':
				return cmdApprove(openid, false);
			case '/跳过':
				return cmdSkipQuestion(openid);
			case '/stop':
			case '/停止':
				return cmdStop(openid);
			case '/提醒':
			case '/提醒列表':
				return cmdSchedule(arg);
			case '/权限':
			case '/permission':
				return cmdPermission(openid, arg);
			case '/帮助':
			case '/help':
			case '/?':
				return Promise.resolve(CMD_HELP);
			default:
				return Promise.resolve(`未知指令 ${head}。用 /帮助 查看指令。`);
		}
	}
	// ── QQ 消息 → DSH 的完整处理（含输入状态保活）───────────────────────────
	/**
	 * 发一条 QQ 文本消息（不截断内容）。
	 * - 一律用 `msg_type=2` + `markdown.content`（标题/加粗/列表/表格能渲染）；
	 *   万一官方对这条通路没开通，**自动降级为纯文本重发**（不丢回复）。
	 * - 超长文本按空行切片、每片 ≤ QQ_CHUNK_CHARS 分多条发；
	 *   若某条仍被接口拒（"太大"），**自动二分重试**直到单条 ≤ QQ_SPLIT_FLOOR，绝不整条丢。
	 * - `msg_id` 只挂在第一条上（被动回复的 msg_id + msg_seq 组合不能重复）。
	 */
	async function sendText(openid, content, msgId) {
		const cfg = readCfg();
		const token = await ensureToken(cfg.appId, cfg.appSecret);
		const base = apiBase(cfg);
		/** 单条发送：markdown 优先，失败降级纯文本；再失败就二分。 */
		const sendOne = async (text, attachMsgId) => {
			const md = { msg_type: 2, msg_seq: ++BOT.msgSeq, markdown: { content: text } };
			if (attachMsgId) md.msg_id = attachMsgId;
			try {
				await postMessage(base, token, openid, md);
				return;
			} catch (e) {
				log(`markdown 发送失败（降级纯文本）: ${e?.message ?? e}`);
			}
			const plain = { content: text, msg_type: 0, msg_seq: ++BOT.msgSeq };
			if (attachMsgId) plain.msg_id = attachMsgId;
			try {
				await postMessage(base, token, openid, plain);
			} catch (e) {
				if (text.length <= QQ_SPLIT_FLOOR) throw e;
				const half = Math.ceil(text.length / 2);
				log(`单条发送失败（${text.length} 字），二分重试: ${e?.message ?? e}`);
				await sendOne(text.slice(0, half), attachMsgId);
				await sendOne(text.slice(half), false);
			}
		};
		const chunks = chunkText(content);
		for (let i = 0; i < chunks.length; i += 1) await sendOne(chunks[i], msgId && i === 0 ? msgId : null);
	}
	async function sendTyping(openid) {
		const cfg = readCfg();
		const token = await ensureToken(cfg.appId, cfg.appSecret);
		await postMessage(apiBase(cfg), token, openid, {
			msg_type: 6,
			msg_seq: ++BOT.msgSeq,
			input_notify: { input_type: 1, input_second: 60 },
		});
	}
	// QQ 客户端的「正在输入」气泡每次 input_notify 只维持几秒，之后自动消失；
	// 长任务期间必须每 ~5 秒续发一次，才能保持到回复发出为止（行业通用做法）。
	// input_second: 60 是单次声明，客户端仍按自身节奏收起，所以以 5s 续发为准。
	function startTyping(openid) {
		let stopped = false;
		let timer = null;
		const fire = () => {
			if (stopped) return;
			sendTyping(openid).catch(() => {});
		};
		fire();
		timer = setInterval(fire, 5000);
		timer.unref?.();
		return () => {
			stopped = true;
			if (timer) clearInterval(timer);
		};
	}
	// ── 审批（approval）桥接：QQ 会话的审批由 QQ 用户决定 ───────────────────
	// answerer 以 prepend+global 注册在瀑布最外层：QQ 会话直接接管（不 next），
	// 非 QQ 会话立即 next() 交给 Web UI 等下游 answerer。
	function removePending(openid, entry) {
		const q = pendingApprovals[openid];
		if (!q) return;
		const i = q.indexOf(entry);
		if (i >= 0) q.splice(i, 1);
		if (q.length === 0) delete pendingApprovals[openid];
	}
	function settlePending(openid, entry, outcome) {
		if (entry.done) return;
		entry.done = true;
		clearTimeout(entry.timer);
		if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
		removePending(openid, entry);
		entry.resolve(outcome);
	}
	async function sendApprovalPrompt(openid, req, ownerSessionId) {
		const sid = req.agent.id;
		let argsText = '';
		if (req.callId) {
			try {
				const events = await svc.sessionQuery.listEvents(sid);
				const tc = events.find((e) => e?.type === 'tool/call' && e?.data?.callId === req.callId);
				if (tc?.data?.arguments) {
					let a = String(tc.data.arguments);
					if (a.length > 200) a = a.slice(0, 200) + '…';
					argsText = `参数：${a}`;
				}
			} catch { /* best-effort */ }
		}
		const cur = perUser(openid).sessionId;
		const who = sid === cur ? '当前会话' : `会话 [${displayShort(sid)}]`;
		const lines = [
			`🔐 需要你的审批（${who}）`,
			`工具：${req.toolName ?? '?'}`,
			...(req.reason ? [`原因：${req.reason}`] : []),
			...(argsText ? [argsText] : []),
			'回复 /approve 允许执行一次，/deny 拒绝；超时将自动拒绝。',
		];
		await sendText(openid, lines.join('\n'));
	}
	async function approvalListener(req, next) {
		try {
			if (!BOT.running) return next(); // 机器人未运行 → 交给 Web UI 等其他 answerer
			const session = req?.agent?.session;
			const sid = session?.header?.id ?? req?.agent?.id;
			// 反查 openid：主会话直查；一级子会话(subagent)沿 parentSession 上溯；
			// 无头定时会话（没人绑定）看本轮 run 的 openid —— 审批也照样推到那个 QQ 用户
			const sessionToOpenid = new Map();
			for (const [o, p] of Object.entries(state.openids)) {
				if (p?.sessionId) sessionToOpenid.set(p.sessionId, o);
			}
			for (const [s, r] of runs) {
				if (r?.openid && !sessionToOpenid.has(s)) sessionToOpenid.set(s, r.openid);
			}
			let openid;
			let ownerSessionId;
			if (sid && sessionToOpenid.has(sid)) {
				openid = sessionToOpenid.get(sid);
				ownerSessionId = sid;
			} else {
				const parent = session?.header?.parentSession;
				if (parent && sessionToOpenid.has(parent)) {
					openid = sessionToOpenid.get(parent);
					ownerSessionId = parent;
				}
			}
			// 「等你审批」也算会话状态：没在聊这个会话的用户会收到一条 QQ 通知（审批本身仍走原路）
			notifyWaiting(session, `需要审批：${req?.toolName ?? '?'}${req?.reason ? `（${String(req.reason).replace(/\s+/g, ' ').trim().slice(0, 40)}）` : ''}`);
			if (openid === undefined) return next(); // 非 QQ 会话 → 交给 Web UI 等其他 answerer
			const entry = {
				sessionId: sid,
				ownerSessionId,
				toolName: req.toolName,
				callId: req.callId,
				reason: req.reason,
				done: false,
				resolve: null,
				timer: null,
				signal: null,
				onAbort: null,
			};
			const outcome = await new Promise((resolve) => {
				entry.resolve = resolve;
				const timeoutMs = readCfg().chatTimeoutMs || 300000;
				entry.timer = setTimeout(() => {
					settlePending(openid, entry, 'rejected');
					sendText(openid, '⏰ 审批超时（未在限期内回复），已自动拒绝。').catch(() => {});
				}, timeoutMs);
				entry.timer.unref?.();
				if (req.signal) {
					entry.signal = req.signal;
					entry.onAbort = () => settlePending(openid, entry, 'cancelled');
					req.signal.addEventListener('abort', entry.onAbort, { once: true });
				}
				(pendingApprovals[openid] ?? (pendingApprovals[openid] = [])).push(entry);
				sendApprovalPrompt(openid, req, ownerSessionId).catch(() => {});
			});
			return outcome;
		} catch {
			return next();
		}
	}
	async function cmdApprove(openid, allow) {
		const q = pendingApprovals[openid];
		if (!q || q.length === 0) return '当前没有待审批的请求。';
		const entry = q[0];
		if (allow && entry.ownerSessionId !== perUser(openid).sessionId) {
			return `有待审批请求，但它属于会话 [${displayShort(entry.sessionId)}]，不是当前接入的会话（同意的指令只对当前会话生效）。请先 /会话 切换到对应会话。`;
		}
		settlePending(openid, entry, allow ? 'allowed-once' : 'rejected');
		return allow ? '✅ 已允许该操作执行。' : '❌ 已拒绝该操作。';
	}
	// ── 用户问答（user-questions）桥接：模型调 ask_user_question 时经 QQ 收集回答 ──
	function settleQuestion(openid, entry, answers, notify) {
		if (entry.done) return;
		entry.done = true;
		clearTimeout(entry.timer);
		if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
		const q = pendingQuestions[openid];
		if (q) {
			const i = q.indexOf(entry);
			if (i >= 0) q.splice(i, 1);
			if (q.length === 0) delete pendingQuestions[openid];
		}
		entry.resolve(answers ?? { answers: [] });
		if (notify) sendText(openid, notify).catch(() => {});
	}
	function buildQuestionAnswers(questions, picks) {
		// picks[i] = { picked: string[](选项 label), custom: string }，与 questions 对齐
		return {
			answers: questions.map((q, i) => {
				const p = picks[i] ?? { picked: [], custom: '' };
				const custom = String(p.custom ?? '').trim();
				if (custom !== '') {
					return { id: q.id, selected: q.multiSelect === true ? (p.picked ?? []) : [], custom };
				}
				return { id: q.id, selected: p.picked ?? [] };
			}),
		};
	}
	async function sendQuestionPrompt(openid, entry) {
		const cur = perUser(openid).sessionId;
		const who = entry.sessionId === cur ? '当前会话' : `会话 [${displayShort(entry.sessionId)}]`;
		const lines = [`❓ 需要你回答（${who}）`];
		entry.questions.forEach((q, qi) => {
			const num = qi + 1;
			lines.push(`${num}. ${q.question ?? '（无标题问题）'}`);
			if (q.detail) lines.push(`　${q.detail}`);
			const opts = Array.isArray(q.options) ? q.options : [];
			if (opts.length > 0) {
				opts.forEach((o, oi) => {
					lines.push(`　${oi + 1}) ${o.label}${o.description ? `（${o.description}）` : ''}`);
				});
			} else {
				lines.push('　（自由回答：直接输入文本）');
			}
			if (q.multiSelect === true) lines.push('　多选：选项号用逗号分隔');
		});
		lines.push('直接输入答案即可；多题用「题号+分隔符」开头（如 1. 2 / 2、1），后续行算该题续行（可多行作答）；多选可用 , 、 | / \\ 分隔；/跳过 跳过。');
		await sendText(openid, lines.join('\n'));
	}
	async function userQuestionListener(req, next) {
		try {
			if (!BOT.running) return next();
			const session = req?.agent?.session;
			const sid = session?.header?.id ?? req?.agent?.id;
			const sessionToOpenid = new Map();
			for (const [o, p] of Object.entries(state.openids)) {
				if (p?.sessionId) sessionToOpenid.set(p.sessionId, o);
			}
			for (const [s, r] of runs) {
				if (r?.openid && !sessionToOpenid.has(s)) sessionToOpenid.set(s, r.openid); // 无头定时会话：问题也推给那个用户
			}
			let openid;
			let ownerSessionId;
			if (sid && sessionToOpenid.has(sid)) {
				openid = sessionToOpenid.get(sid);
				ownerSessionId = sid;
			} else {
				const parent = session?.header?.parentSession;
				if (parent && sessionToOpenid.has(parent)) {
					openid = sessionToOpenid.get(parent);
					ownerSessionId = parent;
				}
			}
			const questions = Array.isArray(req?.questions) ? req.questions : [];
			if (questions.length === 0) return next();
			// 「等你在 Web UI 里选」也算会话状态：没在聊这个会话的用户会收到一条 QQ 通知
			const q0 = String(questions[0]?.question ?? '（无标题问题）').replace(/\s+/g, ' ').trim().slice(0, 40);
			notifyWaiting(session, `在等你选择：${q0}${questions.length > 1 ? `（共 ${questions.length} 题）` : ''}`);
			if (openid === undefined) return next();
			const entry = { sessionId: sid, ownerSessionId, questions, done: false, resolve: null, timer: null, signal: null, onAbort: null };
			const outcome = await new Promise((resolve) => {
				entry.resolve = resolve;
				const timeoutMs = readCfg().chatTimeoutMs || 300000;
				entry.timer = setTimeout(() => settleQuestion(openid, entry, { answers: [] }, '⏰ 问答超时，已跳过。'), timeoutMs);
				entry.timer.unref?.();
				if (req.signal) {
					entry.signal = req.signal;
					entry.onAbort = () => settleQuestion(openid, entry, { answers: [] }, null);
					req.signal.addEventListener('abort', entry.onAbort, { once: true });
				}
				(pendingQuestions[openid] ?? (pendingQuestions[openid] = [])).push(entry);
				sendQuestionPrompt(openid, entry).catch(() => {});
			});
			return outcome;
		} catch {
			return next();
		}
	}
	async function cmdSkipQuestion(openid) {
		const q = pendingQuestions[openid];
		if (!q || q.length === 0) return '当前没有待回答的问题。';
		const entry = q[0];
		if (entry.ownerSessionId !== perUser(openid).sessionId) {
			return `有待回答的问题，但它属于会话 [${displayShort(entry.sessionId)}]，不是当前接入的会话。请先 /会话 切换到对应会话。`;
		}
		settleQuestion(openid, entry, { answers: [] }, null);
		return '⏭️ 已跳过该问题。';
	}
	/**
	 * 结构化多题作答解析：每行「题号. 选项号/文本」（分隔符接受 . 、 : ： ) ））。
	 * - 有选项的题：后面写选项号，多选用逗号/空格分隔；选项号非法则整段当自由文本
	 * - 无选项的题：后面整段都是自由文本
	 * 任一行不符合结构 → 返回 null（退回「整条消息 = 第 1 题自由文本」）
	 */
	function parseStructuredPicks(questions, text) {
		const raw = String(text ?? '').split(/\r?\n/);
		// 题头：行首「编号 + 分隔符」（分隔符接受 . 、 : ： ) ） , ，）
		const headRe = /^\s*(\d+)\s*[.、:：)）,，]\s*(.*)$/;
		// 第一行非空必须就是题头，否则整体退回「自由文本」
		let first = -1;
		for (let i = 0; i < raw.length; i++) {
			if (!raw[i].trim()) continue;
			first = headRe.test(raw[i]) ? i : -1;
			break;
		}
		if (first < 0) return null;
		const picks = questions.map(() => ({ picked: [], custom: '' }));
		let qi = -1;
		let buf = [];
		const flush = () => {
			if (qi < 0) return;
			const content = buf.join('\n').trim();
			const opts = Array.isArray(questions[qi].options) ? questions[qi].options : [];
			let picked = [];
			let ok = false;
			if (opts.length && content) {
				// 多选分隔符：逗号、顿号、竖线、斜杠、反斜杠、空白
			const parts = content.split(/[,，、\s|\/\\]+/).map((s) => s.trim()).filter(Boolean);
				ok = parts.length > 0;
				for (const part of parts) {
					const oi = Number(part) - 1;
					if (!Number.isInteger(oi) || oi < 0 || oi >= opts.length) { ok = false; break; }
					picked.push(opts[oi].label);
				}
			}
			picks[qi] = ok ? { picked, custom: '' } : { picked: [], custom: content };
		};
		let any = false;
		for (let i = first; i < raw.length; i++) {
			const m = raw[i].match(headRe);
			if (m) {
				flush();
				qi = Number(m[1]) - 1;
				if (qi < 0 || qi >= questions.length) return null;
				buf = [];
				const rest = m[2].trim();
				if (rest) buf.push(rest);
				any = true;
			} else if (qi >= 0) {
				buf.push(raw[i].trim()); // 非题头行 → 上一题的续行（支持多行作答）
			}
		}
		flush();
		return any ? picks : null;
	}
	// 普通消息 → 回答：优先按「题号. 选项」结构化解析（可一次答多题），
	// 否则整条消息作为第 1 题的自由文本（其余问题标记跳过）。返回是否已消费该消息。
	answerPendingByText = (openid, text) => {
		const q = pendingQuestions[openid];
		if (!q || q.length === 0) return false;
		const entry = q[0];
		if (entry.ownerSessionId !== perUser(openid).sessionId) return false;
		const structured = parseStructuredPicks(entry.questions, text);
		const picks = structured ?? entry.questions.map((qq, i) => (i === 0 ? { picked: [], custom: String(text ?? '') } : { picked: [], custom: '' }));
		settleQuestion(openid, entry, buildQuestionAnswers(entry.questions, picks), null);
		sendText(openid, structured ? '✅ 已按「题号. 选项」解析并提交回答。' : '✅ 已收到你的回答。').catch(() => {});
		return true;
	};

	/** /stop：停止当前接入会话正在执行的工作，并丢弃队列中未处理的消息 */
	async function cmdStop(openid) {
		const sid = perUser(openid).sessionId;
		if (!sid) return '当前没有接入任何会话。';
		try {
			const r = await svc.sessionController.resolveAgent(sid);
			if (!r || !r.agent) return `⏹️ 该会话当前未附着（${r?.error?.message ?? '未知'}）。`;
			// keepInbox: false → agent.inbox.clear()：中断的同时丢弃未处理消息
			// （官方 sessionController.cancel 写死 keepInbox:true，会把队列留到下次输入时一起处理）
			r.agent.cancel({ kind: 'user' }, { keepInbox: false });
			return '⏹️ 已停止当前会话的工作，并丢弃了队列中未处理的消息。';
		} catch (e) {
			return `⏹️ 当前会话没有正在运行的工作（${e?.message ?? e}）。`;
		}
	}
	/** /权限 [预设名|重置]：查看 / 切换当前接入会话的权限预设（sandbox + approval 一起切）。 */
	async function cmdPermission(openid, arg) {
		const sid = perUser(openid).sessionId;
		if (!sid) return '当前没有接入任何会话。用 /会话 <ID> 接入，或直接发一条普通消息自动新建。';
		const svcPerm = svc.permissionPresets;
		if (!svcPerm || typeof svcPerm.set !== 'function') return '❌ 当前实例没有 permissionPresets 服务，无法切换权限。';
		let agent = null;
		try {
			const r = await svc.sessionController.resolveAgent(sid);
			agent = r?.agent ?? null;
		} catch {
			/* 未附着时退回 sessions 里的实例 */
		}
		const session = agent?.session ?? svc.sessions?.get?.(sid);
		if (!session) return `❌ 会话 [${shortIdFor(sid)}] 当前未附着，先发一条消息把它唤起来再切权限。`;
		const names = permissionPresetNames(svcPerm);
		const want = String(arg ?? '').trim();
		const chosen = state.permPreset?.[sid] ?? null;
		if (!want) {
			const st = svcPerm.permissionState?.(session) ?? {};
			return [
				`🔐 当前会话权限：${svcPerm.current?.(session) ?? '?'}`,
				`　sandbox：${st.sandbox ?? '（默认）'}`,
				`　approval：${st.approval ?? '（默认）'}`,
				chosen ? `　（你在 QQ 里指定过「${chosen}」，桥接不再自动改回 ask）` : '　（未指定：桥接会保证 approval=ask，审批推给 QQ）',
				'',
				`可切换：${names.join(' / ') || '（无）'}`,
				'用法：/权限 <预设名>；/权限 重置（回默认 + approval=ask）',
			].join('\n');
		}
		if (['重置', 'reset', '默认'].includes(want)) {
			const def = svcPerm.defaultPreset ?? names[0] ?? 'workspace-write';
			if (state.permPreset) delete state.permPreset[sid];
			saveState();
			svcPerm.set(session, def);
			if (agent && svc.approval) svc.approval.setPolicy(agent, 'ask');
			log(`权限重置：会话 ${displayShort(sid)} → ${def}（approval=ask）`);
			return `✅ 已重置为默认权限「${def}」（approval=ask，审批推给 QQ）。`;
		}
		if (!names.includes(want)) return `❌ 没有「${want}」这个预设。可选：${names.join(' / ') || '（无）'}`;
		svcPerm.set(session, want);
		if (!state.permPreset) state.permPreset = {};
		state.permPreset[sid] = want;
		saveState();
		const st = svcPerm.permissionState?.(session) ?? {};
		log(`权限切换：会话 ${displayShort(sid)} → ${want}（sandbox=${st.sandbox}, approval=${st.approval}）`);
		return `✅ 当前会话权限已切到「${want}」（sandbox=${st.sandbox ?? '?'}，approval=${st.approval ?? '?'}）。`;
	}
	/** /提醒 [删 <ID>]：列出 / 取消定时推送任务。 */
	async function cmdSchedule(arg) {
		const parts = String(arg ?? '').trim().split(/\s+/).filter(Boolean);
		if (parts.length >= 2 && ['删', '取消', 'del', 'rm', 'delete'].includes(parts[0].toLowerCase())) {
			const id = parts[1];
			const before = schedule.tasks.length;
			schedule.tasks = schedule.tasks.filter((t) => t.id !== id);
			if (schedule.tasks.length === before) return `找不到定时任务 [${id}]。用 /提醒 查看列表。`;
			await saveSchedule();
			log(`定时任务 ${id} 已由 QQ 用户取消`);
			return `✅ 已取消定时任务 [${id}]（还剩 ${schedule.tasks.length} 个）。`;
		}
		if (schedule.tasks.length === 0) return '当前没有定时任务。直接跟我说「每天 8 点提醒我喝水」这类话即可添加。';
		const now = Date.now();
		const lines = [...schedule.tasks].sort((a, b) => a.at - b.at).map((t) => scheduleLine(t, now));
		return [`🕒 定时任务（${schedule.tasks.length} 个，按下次触发排序）：`, ...lines, '', '取消：/提醒 删 <ID>'].join('\n');
	}
	handleUserText = async (openid, msgId, text, images = []) => {
		const per = perUser(openid);
		if (text.startsWith('/')) {
			const reply = await handleCommand(openid, text);
			if (reply) await sendText(openid, reply, msgId);
			return;
		}
		if (!text && images.length === 0) return;
		// 立即提交给 DSH（排队/插话由 DSH 原生模式决定），由回复观察器负责把结果回给 QQ
		try {
			// 图片先下载成 base64（QQ 的 CDN 链接有时效），失败要在提交前告诉用户
			let imageParts = [];
			if (images.length > 0) {
				try {
					imageParts = await downloadQqImages(images);
				} catch (e) {
					log(`图片接收失败: ${e?.message ?? e}`);
					await sendText(openid, `⚠️ 图片没收到（${e?.message ?? e}），你可以改用文字描述，或重发一次。`, msgId).catch(() => {});
					if (!text) return;
				}
			}
			const sessionId = await ensureSession(per);
			const beforeTurn = await currentTurn(sessionId);
			await submitPrompt(sessionId, text, imageParts);
			ensureReplier(openid, sessionId, beforeTurn);
		} catch (e) {
			log(`提交失败: ${e?.message ?? e}`);
			try {
				await sendText(openid, `❌ ${e?.message ?? String(e)}`, msgId);
			} catch {
				/* ignore */
			}
		}
	};
	// ── 启停（设置开关）────────────────────────────────────────────────────
	startBot = async () => {
		if (BOT.running) return;
		const cfg = readCfg();
		if (!cfg.enabled) {
			log('设置页"启用"未打开，桥接空闲。');
			return;
		}
		if (!cfg.appId || !cfg.appSecret) {
			log('缺少 QQ 凭证（appId/appSecret），请到设置页填写。');
			return;
		}
		BOT.running = true;
		BOT.retry = 0;
		BOT.msgSeq = Math.floor(Date.now() / 1000) % 1000000;
		BOT.chains = new Map();
		log(`启动：${cfg.sandbox ? '沙箱' : '正式'}环境`);
		connectLoop();
	};
	stopBot = () => {
		if (!BOT.running) return;
		BOT.running = false;
		BOT.connected = false;
		for (const s of BOT.sockets) {
			try {
				s.close();
			} catch {
				/* ignore */
			}
		}
		BOT.sockets.clear();
		if (BOT.heartbeat) {
			clearInterval(BOT.heartbeat);
			BOT.heartbeat = null;
		}
		if (BOT.retryTimer) {
			clearTimeout(BOT.retryTimer);
			BOT.retryTimer = null;
		}
		BOT.ws = null;
		log('已停止');
	};
	restartBot = () => {
		stopBot();
		startBot();
	};
	// ── 服务注入 + 设置注册 + 设置读写路由（供设置页客户端分区）─────────────
	ctx.inject(['settings', 'sessionController', 'sessionQuery', 'sessions', 'approval', 'webServer'], (host) => {
		svc.settings = host.settings;
		svc.sessionController = host.sessionController;
		svc.sessionQuery = host.sessionQuery;
		svc.sessions = host.sessions;
		svc.approval = host.approval;
		svc.webServer = host.webServer;
		svc.agents = ctx.get('agents'); // 可选：/状态 的 liveAgents
		svc.workspaceController = ctx.get('workspaceController'); // 可选：/new 登记工作区
		svc.permissionPresets = ctx.get('permissionPresets'); // 可选：/权限 切换会话权限预设（sandbox + approval）
		svc.workspaceRegistry = ctx.get('workspaceRegistry'); // 可选：/new 把新会话记账进工作区（Web UI 分组依据）
		try {
			host.settings.register('qq-bridge', SCHEMA);
		} catch (e) {
			log(`settings.register 失败（可能已注册）: ${e?.message ?? e}`);
		}
		readCfg = () => host.settings.get('qq-bridge') ?? {};
		registerInstance({ pid: process.pid, webPort, bridgePort: null, profile, cwd: process.cwd(), startedAt });
		log(`已加载（v0.16.2, web:${webPort ?? '?'}）。到设置页 → QQ 桥接，填写凭证并打开"启用"。（设置页改动即自动保存，没有保存按钮）`);
		try {
			svc.webServer.register({
				kind: 'exact',
				path: '/dsh-qq-bridge/settings',
				handler: async (req, res) => {
					if (req.method === 'GET') {
						const cfg = readCfg() || {};
						// 绝不把 appSecret 回传浏览器：只回非敏感字段 + secretSet 标记
						json(res, 200, {
							ok: true,
							settings: {
								enabled: !!cfg.enabled,
								appId: cfg.appId ?? '',
								sandbox: !!cfg.sandbox,
								chatTimeoutMs: Number(cfg.chatTimeoutMs) || 300000,
								steer: !!cfg.steer,
								notifyOnComplete: cfg.notifyOnComplete === true,
								// 「消息推送内容」4 个勾选项（未设置按勾选处理）
								pushTodo: pushEnabled(cfg, 'pushTodo'),
								pushDeliverable: pushEnabled(cfg, 'pushDeliverable'),
								pushToolCall: pushEnabled(cfg, 'pushToolCall'),
								pushNarration: pushEnabled(cfg, 'pushNarration'),
								secretSet: !!(cfg.appSecret && String(cfg.appSecret).length > 0),
							},
							status: { running: BOT.running, connected: BOT.connected, url: BOT.url ?? null },
						});
						return;
					}
					if (req.method === 'POST') {
						let input = {};
						try {
							input = JSON.parse(await readBody(req));
						} catch {
							return json(res, 400, { ok: false, error: 'bad json' });
						}
						if (!input || typeof input !== 'object' || Array.isArray(input)) {
							return json(res, 400, { ok: false, error: 'bad payload' });
						}
						// 白名单 merge patch：空 appSecret 表示"保持不变"，绝不回写空串覆盖已存密文
						const patch = {};
						for (const key of ['enabled', 'sandbox', 'steer', 'notifyOnComplete', 'pushTodo', 'pushDeliverable', 'pushToolCall', 'pushNarration']) {
							if (typeof input[key] === 'boolean') patch[key] = input[key];
						}
						if (typeof input.appId === 'string') patch.appId = input.appId;
						if (Number.isFinite(input.chatTimeoutMs) && input.chatTimeoutMs > 0) patch.chatTimeoutMs = input.chatTimeoutMs;
						if (typeof input.appSecret === 'string' && input.appSecret.trim() !== '') {
							patch.appSecret = input.appSecret.trim();
						}
						try {
							await host.settings.update('qq-bridge', patch);
							json(res, 200, { ok: true });
						} catch (e) {
							json(res, 400, { ok: false, error: e?.message ?? String(e) });
						}
						return;
					}
					json(res, 405, { ok: false, error: 'method' });
				},
			});
		} catch (e) {
			log(`设置路由注册失败: ${e?.message ?? e}`);
		}
		// 审批 answerer：prepend+global → 瀑布最外层；QQ 会话由 QQ 用户 /approve /deny 决定
		ctx.on('approval/request', approvalListener, { global: true, prepend: true });
		// 用户问答 answerer：模型调 ask_user_question 时经 QQ 收集回答（/答 /跳过）
		ctx.on('user-questions/request', userQuestionListener, { global: true, prepend: true });
		startBot();
		appliedConnKey = connKeyOf(readCfg());
	});
	// agent-presets 可选：/new 的 mode= 靠它列模式。**单独**一条 inject，不并进上面那条
	// 必填依赖 —— 没挂 roster 的 profile 上桥接照常工作，只是 /new 不支持 mode=。
	ctx.inject(['agentPresets'], (presetCtx) => {
		svc.agentPresets = presetCtx.agentPresets;
	});
	// 设置变更 → 启停 / 重启（只在连接参数变化时；其余键运行时实时读取）
	ctx.on('settings/updated', (ns, next) => {
		if (String(ns) !== 'qq-bridge') return;
		const cfg = next && typeof next === 'object' ? next : {};
		const connKey = connKeyOf(cfg);
		if (connKey === appliedConnKey) {
			// 只改了实时读取的参数（超时 / 插话 / 状态推送 / 推送内容 / 工作区）：不碰 WS
			log('检测到设置变更 → 非连接参数，免重启');
			return;
		}
		appliedConnKey = connKey;
		const shouldRun = !!(cfg.enabled && cfg.appId && cfg.appSecret);
		if (shouldRun && !BOT.running) {
			log('检测到设置变更 → 启动');
			startBot();
		} else if (!shouldRun && BOT.running) {
			log('检测到设置变更 → 停止');
			stopBot();
		} else if (shouldRun && BOT.running) {
			log('检测到设置变更 → 重启（应用新凭证/参数）');
			restartBot();
		}
	});
	ctx.on('dispose', async () => {
		stopBot();
		unregisterInstance();
		await saveState();
	});}

// 富媒体纯函数/流程导出给"真机联调脚本"（_tools/qq-send-file.mjs）：直接跑生产代码，不经宿主重启。
export { qqFileType, fileDigests, uploadQqFile, sendQqMedia, ensureToken };

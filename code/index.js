/** * dsh-qq-bridge — host half of the QQ bridge, single-plugin edition. * * One DSH plugin that is BOTH the QQ bot client and the DSH driver: *   - connects to the QQ official robot platform (WSS long connection) and *     handles C2C direct messages, with reconnect backoff and heartbeat; *   - drives DSH sessions in-process via current-version services *     (sessionController / sessionQuery / sessions / approval) — no gateway, *     no HTTP bridge, no registry-dependent routing; *   - configured from the DSH settings page ("qq-bridge" namespace): *     appId / appSecret / sandbox / enabled toggle / chat timeout / steer / *     notifyOnComplete（会话状态推送）/ 消息推送内容（pushTodo / pushDeliverable / *     pushToolCall / pushNarration 四个勾选项）. *     QQ 回复排版（msg_type=2 markdown）内置生效，没有开关：失败自动降级纯文本。 *     新建会话的工作目录不在设置里：兜底新建走 DSH 默认（实例进程目录），要指定项目用 /new 选工作区。 * * Only the final assistant text is sent back to QQ: reasoning / tool-call / * tool-result are separate content-block types and are filtered out, so the * user never sees thinking or tool traces. * * 会话状态推送（notifyOnComplete）：任何主会话一轮正常结束时给 QQ 推「[会话名]已完成」； * 等你选择 / 等你审批也推；QQ 用户当前正接入的那个会话不推，子会话不推。 * * * QQ-driven sessions run with approval policy 'ask', bridged to QQ: the pending approval is delivered as a QQ message and the user answers /approve or /deny; timeout auto-rejects. Web-UI sessions are unaffected. * * Requirements: DSH current version (0.1.5-rc.1 service layer), Node >= 22 * (global fetch / WebSocket). Zero npm dependencies — only node builtins and * @deepseek-ai/schemastery (ships with DSH) for the settings schema. */
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { qqText } from './messages.js';
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
const BOT = { running: false, connected: false, retry: 0, ws: null, heartbeat: null, retryTimer: null, lastSeq: null, msgSeq: 0, chains: new Map(), sockets: new Set(), lastAckAt: 0, lastFrameAt: 0 };
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
const freshState = () => ({ next: SHORT_BASE, map: {}, openids: {}, permPreset: {}, interactive: { pending: [], commands: [], recent: [] } });
let state = freshState();
void loadState(); // 模块加载即恢复落盘的 state（openids/短ID 映射）；失败则保持 fresh
async function loadState() {
	try {
		const raw = JSON.parse(await readFile(stateFile(), 'utf8'));
		state = { ...freshState(), ...(raw && typeof raw === 'object' ? raw : {}) };
	} catch {
		state = freshState();
	}
	// 审批/问答对象由当前 Host 和当前浏览器持有；冷启动无法恢复原始
	// PendingApproval/PendingQuestion。保留最近结果，丢弃旧进程遗留的待答/命令。
	const recent = Array.isArray(state.interactive?.recent) ? state.interactive.recent.slice(0, 50) : [];
	state.interactive = { pending: [], commands: [], recent };
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
/** 进程是否还活着（EPERM 说明进程存在但无权限 → 也算活着）。 */
function pidAlive(pid) {
	const n = Number(pid);
	if (!Number.isFinite(n) || n <= 0) return false;
	try {
		process.kill(n, 0);
		return true;
	} catch (e) {
		return e?.code === 'EPERM';
	}
}
// ── QQ 桥接独占锁：多个 DSH 实例共用一份凭证时，只允许一个实例连 QQ ────────
// 否则每个实例各持一条长连接，同一条私聊消息会被回复 N 次（本机实测 3 次）。
const lockPath = () => join(dshHome(), 'bridge', 'qq-bridge.lock.json');
function claimQqOwnership() {
	try {
		const raw = JSON.parse(readFileSync(lockPath(), 'utf8'));
		const owner = Number(raw?.pid);
		if (Number.isFinite(owner) && owner !== process.pid && pidAlive(owner)) return { ok: false, owner };
	} catch {
		/* 没有锁或锁损坏 → 视为可抢占 */
	}
	try {
		mkdirSync(join(dshHome(), 'bridge'), { recursive: true });
		writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, startedAt: Date.now() }, null, 2), 'utf8');
	} catch (e) {
		log(`QQ 独占锁写入失败: ${e?.message ?? e}`);
	}
	return { ok: true };
}
function releaseQqOwnership() {
	try {
		const raw = JSON.parse(readFileSync(lockPath(), 'utf8'));
		if (Number(raw?.pid) === process.pid) rmSync(lockPath(), { force: true });
	} catch {
		/* ignore */
	}}
/** 当前存活实例（按 pid 过滤）：/状态 的多实例诊断依据。 */
async function liveInstances() {
	const all = await readRegistry();
	return Object.entries(all).filter(([pid]) => pidAlive(pid));
}
function registerInstance(entry) {
	try {
		mkdirSync(join(dshHome(), 'bridge'), { recursive: true });
		let data = { updatedAt: Date.now(), instances: {} };
		try {
			data = JSON.parse(readFileSync(registryPath(), 'utf8'));
		} catch {
			/* first write */
		}
		// 清掉已死进程的陈旧记录：桌面 App 退出时宿主可能被强杀，dispose 不会执行，
		// 旧记录会一直累积（本机曾积到 8 条），使 /profile 与重复实例诊断失真。
		for (const pid of Object.keys(data.instances ?? {})) {
			if (!pidAlive(pid)) delete data.instances[pid];
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
/**
 * 这条文本该走 QQ 的 markdown 通路（msg_type=2）还是纯文本（msg_type=0）？
 *
 * QQ 的 markdown 渲染器会给**每个换行**加上段落间距 —— 纯文本清单（`/会话`、`/提醒`、
 * `📋 待办`、`📎 交付`）用 markdown 发出去，行距会翻倍、读起来像"每行之间空一行"（用户实测反馈）。
 * 所以只在文本里**真的有 markdown 记号**时才用 markdown，其余一律纯文本（行距与旧版一致）。
 *
 * 判定只看"记号"本身，不做语义理解：标题 / 加粗 / 删除线 / 有序无序列表 / 引用 / 表格 /
 * 行内代码 / 链接 / 分割线。命中任意一条 → markdown。
 */
function looksLikeMarkdown(text) {
	const s = String(text ?? '');
	return [
		/^#{1,6} +\S/m, // 标题
		/\*\*[^*\n]+\*\*/, // 加粗
		/~~[^~\n]+~~/, // 删除线
		/^ {0,3}[-*+] +[^\s-]/m, // 无序列表
		/^ {0,3}\d+\. +[^\s]/m, // 有序列表
		/^ {0,3}> +\S/m, // 引用
		/^ {0,3}\|.*\|\s*$/m, // 表格行
		/`[^`\n]+`/, // 行内代码
		/\[[^\]\n]+\]\([^)\n]+\)/, // 链接
		/^ {0,3}([-*_])(?: *\1){2,} *$/m // 分割线
	].some((re) => re.test(s));
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
	return qqText('P01', { body: text });}
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
	const lines = [qqText('P02', { done, total: todos.length, ...(curText ? { current: curText } : {}) })];
	const MAX = 15;
	todos.slice(0, MAX).forEach((t, i) => {
		const mark = t?.status === 'completed' ? '✅' : t?.status === 'in_progress' ? '▶' : '⬜';
		lines.push(qqText('P03', { mark, index: i + 1, content: oneLine(t?.content, 50) }));
	});
	if (todos.length > MAX) lines.push(qqText('P04', { count: todos.length - MAX }));
	return lines.join('\n');}
/** `deliverables/presented` → 📎 一条交付清单：文件名（末两段）+ 说明。 */
function deliverableLine(files) {
	if (!Array.isArray(files) || files.length === 0) return null;
	const lines = [qqText('P05', { count: files.length })];
	const MAX = 12;
	files.slice(0, MAX).forEach((f) => {
		const desc = oneLine(f?.description, 40);
		lines.push(qqText('P05a', { path: shortPath(f?.path), ...(desc ? { description: desc } : {}) }));
	});
	if (files.length > MAX) lines.push(qqText('P06', { count: files.length - MAX }));
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
/** 看门狗：超过这个倍数的心跳间隔都没收到任何帧（尤其 op11 ACK）→ 判定连接假活 */
const WS_SILENCE_FACTOR = 2.5;
/**
 * 长连接看门狗。
 *
 * 为什么需要：WebSocket 半开（Mac 睡眠/NAT 超时/代理断开）时 onclose/onerror **不会触发**，
 * BOT.connected 会一直停在 true —— 设置页看起来"已连接"，但 QQ 的消息再也收不到，
 * 只有主动发消息（走 HTTP）还成功。这类故障以前只能靠人肉重启实例解决。
 * 现在：按心跳间隔巡检，连续 2.5 个间隔没有任何帧/ACK 就强制关闭当前 socket，
 * 交给 onclose → scheduleReconnect 重连。
 */
let wsWatchdog = null;
let wsWatchdogTick = null; // 供测试直接驱动一次巡检（不依赖真实定时器）
function stopWsWatchdog() {
	if (wsWatchdog) {
		clearInterval(wsWatchdog);
		wsWatchdog = null;
	}
	wsWatchdogTick = null;}
function startWsWatchdog(heartbeatMs) {
	stopWsWatchdog();
	const hi = Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : 45000;
	const silenceLimit = Math.max(30000, Math.round(hi * WS_SILENCE_FACTOR));
	const tick = () => {
		if (!BOT.running || !BOT.connected || !BOT.ws) return;
		const last = Math.max(BOT.lastFrameAt, BOT.lastAckAt);
		const silence = Date.now() - last;
		if (silence <= silenceLimit) return;
		log(`WS 静默 ${Math.round(silence / 1000)}s（> ${Math.round(silenceLimit / 1000)}s）→ 判定连接假活，强制重连`);
		BOT.connected = false;
		const dead = BOT.ws;
		BOT.ws = null;
		try {
			dead?.close();
		} catch {
			/* ignore */
		}
		// close 事件若也没触发（极端半开），兜底排一次重连
		setTimeout(() => {
			if (BOT.running && !BOT.connected && !BOT.ws) scheduleReconnect();
		}, 2000).unref?.();
	};
	wsWatchdogTick = tick;
	wsWatchdog = setInterval(tick, Math.max(5000, Math.round(hi / 2)));
	wsWatchdog.unref?.();
}
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
	BOT.lastFrameAt = Date.now();
	const op = msg.op;
	if (op === 10) {
		// Hello → Identify + 心跳
		const hi = Number(msg.d?.heartbeat_interval);
		BOT.connected = true;
		BOT.retry = 0;
		BOT.lastFrameAt = Date.now();
		BOT.lastAckAt = Date.now();
		startWsWatchdog(hi);
		if (BOT.heartbeat) clearInterval(BOT.heartbeat);
		sendWs({ op: 2, d: { token: `QQBot ${BOT.token}`, intents: QQ_INTENTS, shard: [0, 1] } });
		if (hi > 0) {
			BOT.heartbeat = setInterval(() => sendWs({ op: 1, d: BOT.lastSeq ?? null }), hi);
			BOT.heartbeat.unref?.();
		}
		log('WS READY（已 Identify，开始接收消息）');
		return;
	}
	if (op === 11) { BOT.lastAckAt = Date.now(); return; } // Heartbeat ACK：刷新看门狗
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
let handleModelPick = null; // (openid, text) => boolean 由 apply 注入（/模型两阶段选择）
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
		handleUserText(openid, msgId, content).catch((e) => log(`指令 ${content.split(/\s+/, 1)[0]} 处理失败: ${e?.stack ?? e}`));
		return;
	}
	// 有待回答的问题时，普通消息直接作为自由回答（立即处理，不排队）
	if (answerPendingByText && (pendingQuestions[openid]?.length ?? 0) > 0 && answerPendingByText(openid, content)) {
		return;
	}
	// /模型 两阶段选择：纯数字回复优先交给模型选择流程
	if (handleModelPick && handleModelPick(openid, content)) {
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
			stopWsWatchdog();
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
// 启动/停止/重启（由 apply 驱动）
let readCfg = () => ({});
let startBot = () => {};
let stopBot = () => {};
let restartBot = () => {};
let onSettingsApplied = () => {};
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
function noticeTargets(state, sid, includeDisconnected = false) {
	const out = [];
	for (const [openid, per] of Object.entries(state?.openids ?? {})) {
		if ((!includeDisconnected && per?.disconnected) || per?.sessionId === sid) continue;
		out.push(openid);
	}
	return out;
}

// ── plugin ─────────────────────────────────────────────────────────────────
/**
 * 0.1.7+：插件配置不再是「settings namespace」，而是 Loader 条目上的 `config:`
 * （见 profile 的 cordis.patch.yml）。本插件的条目 id 是 `dsh-qq-bridge`。
 * 静态 Config 让宿主按 schema 校验 + 在设置页渲染表单；改动经 configEditor.edit
 * 落盘到 patch，Loader reconcile 后新值自动出现在传入的 config 上。
 */
export const Config = SCHEMA;

export function apply(ctx, config) {
	log = (...a) => {
		const line = `[qq-bridge] ${a.join(' ')}`;
		try {
			ctx.logger?.info?.(line);
		} catch {
			console.log(line);
		}
	};
	const svc = { settings: null, sessionController: null, sessionQuery: null, sessions: null, approval: null, agentPresets: null, schedule: null };
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
		const line = qqText('P07', { name: event.data?.name ?? '?', ...(a ? { preview: a } : {}) });
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
		if (result.error) return qqText('R03', { error: result.error });
		if (result.aborted || result.timedOut) {
			const head = result.aborted
				? qqText('R04')
				: qqText('R05', { minutes: Math.round((readCfg().chatTimeoutMs || 300000) / 60000) });
			const lines = [head];
			const list = digest ?? [];
			if (list.length) lines.push('', qqText('R06', { steps: list }));
			lines.push('', qqText('R07', { body: result.text }));
			return lines.join('\n');
		}
		return result.text || qqText('R02');
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
		if (perUser(openid).disconnected) return;
		const state = { openid, detached: false, inTurn: false, stopTyping: startTyping(openid) };
		runs.set(sessionId, state);
		(async () => {
			try {
				let base = beforeTurn;
				let warned = false; // 已发过超时提示：连续两次超时才真退出（长工具/慢收尾可能超过单个窗口）
				while (!state.detached && !perUser(state.openid).disconnected) {
					state.inTurn = true;
					const waiter = waitForTurn(sessionId, base, readCfg().chatTimeoutMs || 300000, null);
					const result = await waiter.promise;
					if (state.detached || perUser(state.openid).disconnected) break;
					state.inTurn = false;
					base = result.endedTurn ?? base;
					if (result.timedOut && warned) break; // 连续两次超时：本轮确实无进展，退出观察
					if (result.timedOut) warned = true;
					else warned = false;
					const digest = takeToolDigest(sessionId);
					await sendText(state.openid, formatTurn(result, digest));
					if (result.timedOut) continue; // 已提示超时：继续守同一轮（或其后排队的轮），正文到达即补发
					if (!(await waitTurnStart(sessionId, base, 1200))) {
						// 官方 schedule 刚往这个会话投递了提醒：它的轮次马上开始，继续守
						if (state.followupPending) { state.followupPending = false; continue; }
						break;
					}
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
		const owner = openidForSession(sid) ?? runs.get(sid)?.openid ?? null;
		return owner && !perUser(owner).disconnected ? owner : null;
	}
	/**
	 * 记住这个 QQ 用户用过的会话（最新在前，最多 50 个）。
	 * 官方 schedule 把任务绑在**会话**上，用户 /会话 切走之后还要能 /提醒 看到并取消自己的任务，
	 * 所以归属不能只看"当前绑定"。
	 */
	function rememberSession(openid, sid) {
		if (!openid || !sid) return;
		const per = perUser(openid);
		const list = Array.isArray(per.sessions) ? per.sessions : (per.sessions = []);
		const i = list.indexOf(sid);
		if (i === 0) return;
		if (i > 0) list.splice(i, 1);
		list.unshift(sid);
		if (list.length > 50) list.length = 50;
		void saveState();
	}
	/**
	 * 该把会话结果发给谁：绑定 → 本轮 run → 用过的会话记录（仅当唯一候选时）。
	 * 与 ownerOpenidForSession 的区别是最后那层，让切走会话后的计划任务结果仍能回到 QQ。
	 */
	function sessionOwner(sid) {
		const direct = ownerOpenidForSession(sid);
		if (direct) return direct;
		const candidates = Object.entries(state.openids)
			.filter(([, per]) => per && !per.disconnected && Array.isArray(per.sessions) && per.sessions.includes(sid))
			.map(([openid]) => openid);
		return candidates.length === 1 ? candidates[0] : null;
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
		if (perUser(openid).disconnected) throw new Error("QQ 已断开会话，禁止文件推送");
		const epoch = perUser(openid).routingEpoch ?? 0;
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
				if (perUser(openid).disconnected || (perUser(openid).routingEpoch ?? 0) !== epoch) break;
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
		const known = Object.keys(state.openids ?? {}).filter(o => !perUser(o).disconnected);
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
		}).catch((e) => {
			log(`注册 qq_send 工具失败（只是少工具，桥接不受影响）: ${e?.message ?? e}`);
		});
	});
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
	// ── 官方 schedule 到点投递 → QQ ───────────────────────────────────────────
	// schedule 插件把提醒作为 user/message 投进**原会话** inbox（source.kind==='schedule'），
	// 由该会话自己跑一轮，若该会话属于某个 QQ 用户就把这一轮结果发回 QQ。
	//
	// ⚠️ 不能用「当前轮次号」当观察基线：实测事件顺序是
	//     turn/start(turn=N) → step/start → user/message(source=schedule)
	// （投递消息是在这一轮内部才落事件的），此时快照里已经有 N，
	// 观察器只等 `turn > N` 就会永远等不到自己这一轮，正文发不出去（只到 5 分钟超时）。
	// 所以改为「登记 sid → 该轮 turn/end 时取正文发送」，完全不依赖轮次号比较。
	const scheduleDeliveries = new Map(); // sessionId -> { openid }
	ctx.on('session/event', (session, event) => {
		if (event?.type !== 'user/message') return;
		if (event.data?.source?.kind !== 'schedule') return;
		const sid = session?.id ?? session?.header?.id;
		if (!sid) return;
		const openid = sessionOwner(sid);
		if (!openid) return;
		const existing = runs.get(sid);
		if (existing) {
			existing.followupPending = true; // 正在聊这个会话：由现有观察器负责这一轮
			return;
		}
		if (!scheduleDeliveries.has(sid)) {
			scheduleDeliveries.set(sid, { openid });
			log(`计划任务提醒已投递到会话 ${displayShort(sid)}，结果将回 QQ`);
		}
	});
	/**
	 * 每一轮结束 → 把这一轮正文回 QQ。
	 *
	 * 归属规则与「旁白/工具推送」完全一致：**只要这个会话属于某个 QQ 用户，这一轮就该回 QQ**，
	 * 不区分这轮是从 QQ 还是从桌面端发起的。之前只在「QQ 发起的轮次」里挂回复观察器，
	 * 于是桌面端发起（同一个 QQ 绑定会话）的轮次只有旁白/工具行推到 QQ、正文留在桌面 —— 就是用户看到的现象。
	 *
	 * QQ 发起的轮次仍由回复观察器负责（打字状态、超时补发、工具回放都在它那边），
	 * 这里只在没有观察器时兜底，避免重复发送。
	 */
	ctx.on('session/event', (session, event) => {
		if (event?.type !== 'turn/end') return;
		const sid = session?.id ?? session?.header?.id;
		if (!sid) return;
		const delivered = scheduleDeliveries.delete(sid);
		const replier = runs.get(sid);
		if (replier) {
			// 观察器已在守这一轮（QQ 发起的轮次，或投递时它就在）→ 交给它，避免重复
			if (replier.followupPending) replier.followupPending = false;
			return;
		}
		// 收件人与「旁白/工具行」同源：普通轮次只看当前绑定（openidForSession）；
		// 计划任务投递那一轮允许回退到「用过的会话」（sessionOwner），
		// 否则用户把绑定切走后就收不到自己任务的结果了。
		const openid = delivered ? sessionOwner(sid) : openidForSession(sid);
		if (!openid) return;
		if (perUser(openid).disconnected) return;
		const turn = event.data?.turn;
		let events = [];
		try {
			events = session?.snapshotEvents?.() ?? [];
		} catch {
			/* 快照读不到就按空正文处理 */
		}
		const assistantEvents = events.filter((e) => e?.type === 'assistant/message'
			&& (typeof turn !== 'number' || e?.data?.turn === turn));
		const reason = event.data?.reason ?? null;
		const error = reason?.kind === 'error' ? (reason.error?.message ?? 'agent turn error') : null;
		const aborted = reason?.kind === 'aborted' || reason?.kind === 'interrupted';
		const text = formatTurn({ text: extractFinalText(assistantEvents), error, timedOut: false, aborted }, []);
		void sendText(openid, text).catch(() => {});
		log(`会话 ${displayShort(sid)} 第 ${turn ?? '?'} 轮正文已回 QQ（无观察器：桌面端或计划任务发起，${text.length} 字）`);
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
		if (sid) queueSessionNotice(session, sid, async () => qqText('N01', { sessionName: await sessionLabel(session, sid) }), true);
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
		return qqText('N04', { shortId: displayShort(sid), ...(cwd ? { workspace: cwdLabel(cwd) } : {}) });
	}
	/**
	 * 「这个会话在等你输入」推送入口（选择题 / 审批都走这里）。
	 * tail 例：`在等你选择：要跑哪个方案？`、`需要审批：Bash`。
	 */
	function notifyWaiting(session, buildLine) {
		const sid = noticeSidFor(session, readCfg());
		if (!sid) return;
		queueSessionNotice(session, sid, async () => buildLine(await sessionLabel(session, sid)));
	}
	/** 串行推送状态通知（一条 QQ 消息一个人一次；避免并发触发频控）。 */
	function queueSessionNotice(session, sid, buildLine, includeDisconnected = false) {
		if (!BOT.running) return;
		if (noticeQueue.length >= NOTICE_BACKLOG_MAX) {
			log(`状态通知积压超过 ${NOTICE_BACKLOG_MAX} 条，丢弃：${sid}`);
			return;
		}
		noticeQueue.push({ session, sid, buildLine, includeDisconnected });
		if (noticeBusy) return;
		noticeBusy = true;
		(async () => {
			try {
				while (noticeQueue.length) {
					const item = noticeQueue.shift();
					try {
						const targets = noticeTargets(state, item.sid, item.includeDisconnected);
						if (!targets.length) continue; // 唯一用户在聊这个会话 → 无需通知
						const line = await item.buildLine(item.session, item.sid);
						for (const openid of targets) {
							try {
								await sendText(openid, line, null, { completionNotice: item.includeDisconnected });
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
		// 只报存活实例：桌面 App 被强杀时宿主可能变孤儿，其 registry 条目不会被回收
		const insts = Object.fromEntries(await liveInstances());
		const keys = Object.keys(insts);
		if (!keys.length) return qqText('C01');
		const instances = keys
			.sort((a, b) => (insts[a]?.webPort ?? 0) - (insts[b]?.webPort ?? 0))
			.map((pid, idx) => {
				const e = insts[pid] || {};
				return { index: idx + 1, webPort: e.webPort ?? '?', bridgePort: e.bridgePort ?? '?', pid,
					current: String(e.webPort) === String(webPort), startedAt: fmtTime(e.startedAt), cwd: e.cwd ?? '?' };
			});
		return qqText('C02', { instances, webPort });
	}
	/**
	 * 会话查询整体超时（listSessions / readTitleSnapshots / 逐条正文）。
	 * 单插件的命令回复必须**永不静默挂死**：超时就降级到内存里的 live sessions。
	 */
	const SESSION_QUERY_TIMEOUT_MS = 7000;
	/** 给一个 promise 加超时护栏；超时只 reject 本函数，不取消底层（sessionQuery 不接受 signal 的子集）。 */
	function withTimeout(promise, ms, label) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${label} 超时（>${ms}ms）`)), ms);
			Promise.resolve(promise).then(
				(v) => { clearTimeout(timer); resolve(v); },
				(e) => { clearTimeout(timer); reject(e); },
			);
		});
	}
	/**
	 * dsh-session-manager 的落盘位置：桌面宿主启动参数里**没有** `--profile`，
	 * 所以 `profile` 只是 'web' 兜底，拼出的 `profiles/web/...` 并不存在（静默失效）。
	 * 真实位置是 DSH home 根目录；两个位置都试，取先解析到的。
	 * @returns {{trash:Set<string>, pendingPurge:Set<string>}}
	 */
	function readSessionManagerState() {
		const candidates = [join(dshHome(), 'dsh-session-manager.json')];
		if (profile) candidates.push(join(dshHome(), 'profiles', profile, 'dsh-session-manager.json'));
		for (const file of candidates) {
			try {
				const raw = JSON.parse(readFileSync(file, 'utf8'));
				return { trash: new Set(Object.keys(raw?.trash ?? {})), pendingPurge: new Set(Object.keys(raw?.pendingPurge ?? {})) };
			} catch {
				/* 换下一个候选 */
			}
		}
		return { trash: new Set(), pendingPurge: new Set() };
	}
	/**
	 * 已删除但尚未从持久化清除的会话 ID（DSH 两阶段删除：先入 trash/pendingPurge，稍后才真正 purge）。
	 * listSessions() 走持久化层，因此这些会话仍会被返回——必须在此显式排除。
	 */
	function deletedSessionIds() {
		const { trash, pendingPurge } = readSessionManagerState();
		return new Set([...trash, ...pendingPurge]);
	}
	/**
	 * 取会话列表快照。持久化查询（sessionQuery.listSessions）带超时护栏；
	 * 超时/异常时退回内存里的 live sessions，绝不让 /会话 静默挂死。
	 * @returns {Promise<{items?: Array<{header:object}>, source?: string, error?: string, live: Array<{header:object}>}>}
	 */
	async function sessionSnapshot() {
		let queried = null;
		let queryError = null;
		if (svc.sessionQuery?.listSessions) {
			try {
				const list = await withTimeout(svc.sessionQuery.listSessions(), SESSION_QUERY_TIMEOUT_MS, 'listSessions');
				if (Array.isArray(list)) queried = list;
				else queryError = 'listSessions 返回了非数组';
			} catch (e) {
				queryError = e?.message ?? String(e);
			}
		} else {
			queryError = 'sessionQuery 服务不可用';
		}
		const live = (svc.sessions?.list?.() ?? []).filter((s) => s?.header).map((s) => ({ header: s.header, live: true }));
		if (queried === null) return { error: queryError, live };
		const merged = new Map();
		for (const r of queried) if (r?.header?.id) merged.set(r.header.id, r);
		let added = 0;
		for (const r of live) if (!merged.has(r.header.id)) { merged.set(r.header.id, r); added += 1; }
		return { items: [...merged.values()], source: added ? 'sessionQuery+live' : 'sessionQuery', live };
	}
	/**
	 * 批量取标题。形状与内核 readTitleSnapshots 一致（projectMany → {status, value:{session,title}}）；
	 * 内核若在未来改形状，这里整体退回"无标题"而不是让 /会话 报错。
	 * @returns {Promise<Map<string,string>>} sessionId → 标题
	 */
	async function sessionTitles(ids) {
		const map = new Map();
		if (!ids.length || !svc.sessionQuery?.readTitleSnapshots) return map;
		try {
			const trs = await withTimeout(svc.sessionQuery.readTitleSnapshots(ids), SESSION_QUERY_TIMEOUT_MS, 'readTitleSnapshots');
			for (const tr of trs ?? []) {
				const t = tr?.status === 'fulfilled' ? (tr.value?.title?.title ?? tr.value?.title) : null;
				if (tr?.sessionId && typeof t === 'string' && t) map.set(tr.sessionId, t);
			}
		} catch {
			/* 标题失败不影响列表 */
		}
		return map;
	}
	/**
	 * 逐条摘要（轮数 / 最近活跃 / 预览）。优先一次 projectMany 批量投影（与内核标题投影同一套路，
	 * 复用内核的消息投影，避免手写 foldSurface），批量失败则退回逐条 readSession。
	 * @param {string[]} ids - 会话 ID（已裁剪）
	 * @returns {Promise<Map<string,{userMsgs:number,lastActive:number|null,preview:string|null}>>}
	 */
	async function sessionDigests(ids) {
		const map = new Map();
		/** 从一个会话的事件数组里折叠出摘要。 */
		const digestOf = (events) => {
			let userMsgs = 0;
			let lastActive = null;
			let lastUserPreview = null;
			let lastAssistantPreview = null;
			for (const e of events ?? []) {
				if (e?.type === 'user/message') {
					userMsgs += 1;
					lastUserPreview = textOfEvent(e) ?? lastUserPreview;
				} else if (e?.type === 'assistant/message') {
					lastAssistantPreview = textOfEvent(e) ?? lastAssistantPreview;
				}
				if (typeof e?.time === 'number') lastActive = e.time;
			}
			return { userMsgs, lastActive, preview: lastUserPreview ?? lastAssistantPreview };
		};
		if (!ids.length || !svc.sessionQuery) return map;
		if (typeof svc.sessionQuery.projectMany === 'function') {
			try {
				const results = await withTimeout(
					svc.sessionQuery.projectMany(ids, (source) => digestOf(source.events)),
					SESSION_QUERY_TIMEOUT_MS,
					'projectMany',
				);
				for (const r of results ?? []) {
					if (r?.status === 'fulfilled' && r.value) map.set(r.sessionId, r.value);
				}
				if (map.size === ids.length) return map;
			} catch {
				/* 批量失败 → 退回逐条 */
			}
		}
		if (typeof svc.sessionQuery.readSession === 'function') {
			await Promise.all(ids.map(async (id) => {
				if (map.has(id)) return;
				try {
					const loaded = await withTimeout(svc.sessionQuery.readSession(id), SESSION_QUERY_TIMEOUT_MS, 'readSession');
					const events = Array.isArray(loaded) ? loaded : (loaded?.events ?? []);
					map.set(id, digestOf(events));
				} catch {
					/* 单条失败跳过 */
				}
			}));
		}
		return map;
	}
	/** 当前 Web 端口：优先跑在宿主里的 webServer.port（启动参数可能不带 --port）。 */
	function currentWebPort() {
		return svc.webServer?.port ?? webPort ?? '?';
	}
	/**
	 * 采集 /会话 需要的会话行（也供诊断出口复用）。
	 * @returns {Promise<{rows: object[], visible: object[], source: string|null, error: string|null, ms: number}>}
	 */
	async function collectSessionRows() {
		const startedAt = Date.now();
		const snap = await sessionSnapshot();
		if (snap.error && !snap.live.length) {
			return { rows: [], visible: [], source: null, error: snap.error, ms: Date.now() - startedAt };
		}
		let records = (snap.error ? snap.live : snap.items) ?? [];
		// 只列主会话（与 Web 左侧一致）：排除子会话/subagent——子会话带 parentSession 或 origin==='subagent'
		records = records.filter((r) => !r?.header?.parentSession && r?.header?.origin !== 'subagent');
		// 排除已删除（待清除）的会话
		const deleted = deletedSessionIds();
		if (deleted.size) records = records.filter((r) => !deleted.has(r?.header?.id));
		const picked = [...records].sort((a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0)).slice(0, SESSION_LIST_CAP);
		const titles = await sessionTitles(picked.map((r) => r.header.id));
		const digests = await sessionDigests(picked.map((r) => r.header.id));
		const rows = picked.map((r) => {
			const h = r.header;
			const d = digests.get(h.id) ?? { userMsgs: 0, lastActive: null, preview: null };
			return {
				id: h.id,
				cwd: h.cwd ?? null,
				agentPreset: h.agentPreset ?? null,
				createdAt: h.createdAt ?? null,
				title: titles.get(h.id) ?? null,
				userMsgs: d.userMsgs,
				lastActive: d.lastActive,
				lastUserPreview: d.preview,
				lastAssistantPreview: d.preview,
			};
		});
		// 按最近活跃排序（显示时间同步为最近活跃）：正在用的会话排前面
		rows.sort((a, b) => (b.lastActive ?? b.createdAt ?? 0) - (a.lastActive ?? a.createdAt ?? 0));
		// 空壳会话（无标题且无任何用户消息）不展示
		const visible = rows.filter((r) => r.title || r.userMsgs > 0);
		return { rows, visible, source: snap.error ? 'live（持久化查询失败）' : snap.source, error: snap.error ?? null, ms: Date.now() - startedAt };
	}
	async function cmdSessions(openid) {
		let collected;
		try {
			collected = await collectSessionRows();
		} catch (e) {
			return qqText('C03', { error: e?.message ?? e });
		}
		if (collected.error && !collected.visible.length) return qqText('C03', { error: collected.error });
		const visible = collected.visible;
		if (!visible.length) return qqText('C04');
		const groups = new Map();
		for (const s of visible) {
			const key = s.cwd ?? '(未指定)';
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(s);
		}
		const groupRows = [...groups].map(([cwd, sesses]) => ({
			workspace: cwdLabel(cwd),
			sessions: sesses.map((s) => {
				const title = s.title || s.lastUserPreview || s.lastAssistantPreview || s.id.slice(8, 20);
				return { shortId: shortIdFor(s.id), title: String(title).slice(0, 26),
					current: perUser(openid).sessionId === s.id,
					time: fmtTime(s.lastActive ?? s.createdAt), userMsgs: s.userMsgs, preset: s.agentPreset ?? 'standard' };
			}),
		}));
		saveState();
		return qqText('C05', { webPort: currentWebPort(), groups: groupRows });
	}
	function cmdAttach(openid, arg) {
		const short = String(arg || '').trim();
		const sid = state.map[short];
		if (!sid) return qqText('C06a', { shortId: short });
		perUser(openid).sessionId = sid;
		perUser(openid).disconnected = false;
		rememberSession(openid, sid);
		saveState();
		return qqText('C06b', { shortId: short });
	}
	// ── /new：列出工作区 → 回数字即在该工作区新建会话并接入 ────────────────
	const pendingNew = {}; // openid -> { list: string[], at: number, mode: { id, name } | null }
	const pendingModel = {}; // openid -> { phase, groups, provider, models, at }
	const NEW_TTL_MS = 10 * 60 * 1000;
	const MODEL_TTL_MS = 10 * 60 * 1000;
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
		if (!catalog || !catalog.rows.length) return qqText('C07');
		return qqText('C08', { rows: catalog.rows.map((p, i) => ({ index: i + 1, name: p.name, id: p.id, isDefault: p.id === catalog.defaultId })) });
	}
	/** 解析 mode= 的值：纯数字 → 序号；否则按 preset id 精确匹配。返回 { id, name } 或 { error } */
	async function resolveMode(token) {
		const raw = String(token ?? '').trim();
		if (!raw) return { error: qqText('C09') };
		const catalog = await modeCatalog();
		if (!catalog) return { error: qqText('C10') };
		if (/^\d+$/.test(raw)) {
			const hit = catalog.rows[Number(raw) - 1];
			if (!hit) return { error: qqText('C11', { count: catalog.rows.length, modeList: modeListText(catalog) }) };
			return { id: hit.id, name: hit.name };
		}
		const hit = catalog.rows.find((p) => p.id === raw);
		if (hit) return { id: hit.id, name: hit.name };
		// 不在可用清单里：区分「不认识这个 id」与「认识但 discovery 判为 broken」
		try {
			const broken = (await svc.agentPresets.list()).find((p) => p && p.id === raw && p.broken !== undefined);
			if (broken) return { error: qqText('C12', { modeId: raw, reason: broken.broken }) };
		} catch {
			/* ignore：按未知模式处理 */
		}
		return { error: qqText('C13', { modeId: raw, modeList: modeListText(catalog) }) };
	}
	/** /new 参数解析：位置参数（纯数字）= 工作区号；k=v = 选项（当前仅 mode） */
	function parseNewArgs(arg) {
		const out = { workspaceNo: undefined, modeToken: undefined, unknownKeys: [], stray: [] };
		for (const tok of String(arg ?? '').trim().split(/\s+/).filter(Boolean)) {
			const eq = tok.indexOf('=');
			if (eq > 0) {
				const key = tok.slice(0, eq).trim().toLowerCase();
				if (key === 'mode') {
					if (out.modeToken !== undefined) return { error: qqText('C14') };
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
		return qqText('C15', { workspaces: list.map((cwd, i) => ({ index: i + 1, name: cwdLabel(cwd), path: cwd })),
			modeList: modeListText(catalog), ...(mode ? { modeName: mode.name, modeId: mode.id } : {}) });
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
		const routingEpoch = perUser(openid).routingEpoch ?? 0;
		const mode = opts?.mode ?? null;
		let created;
		try {
			created = await svc.sessionController.create(mode ? { cwd, agentPreset: mode.id } : { cwd });
		} catch (e) {
			return qqText('C16', { error: e?.message ?? e });
		}
		const sid = created?.sessionId ?? created?.id;
		if (!sid) return qqText('C17');
		await attachToWorkspace(sid, cwd);
		if ((perUser(openid).routingEpoch ?? 0) !== routingEpoch) return qqText('C18');
		perUser(openid).sessionId = sid;
		perUser(openid).disconnected = false;
		rememberSession(openid, sid);
		const short = shortIdFor(sid);
		saveState();
		return qqText('C19', { workspace: cwdLabel(cwd), shortId: short, ...(mode ? { modeName: mode.name } : {}) });
	}
	async function cmdNew(openid, arg) {
		const parsed = parseNewArgs(arg);
		if (parsed.error) return parsed.error;
		if (parsed.stray.length) {
			return qqText('C20', { argument: parsed.stray.join(' ') });
		}
		if (parsed.unknownKeys.length) {
			return qqText('C21', { key: parsed.unknownKeys.join(' ') });
		}
		let mode = null;
		if (parsed.modeToken !== undefined) {
			const r = await resolveMode(parsed.modeToken);
			if (r.error) return r.error;
			mode = r;
		}
		const list = await workspaceList();
		if (!list.length) return qqText('C22');
		if (parsed.workspaceNo !== undefined) {
			if (parsed.workspaceNo > list.length) {
				return qqText('C23', { count: list.length, workspaceList: newListText(list, await modeCatalog(), mode) });
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
			modeCatalog().then((cat) => sendText(openid, qqText('C24', { count: pend.list.length, workspaceList: newListText(pend.list, cat, pend.mode) }))).catch(() => {});
			return true;
		}
		makeSessionIn(openid, pend.list[n - 1], { mode: pend.mode ?? null })
			.then((msg) => sendText(openid, msg))
			.catch((e) => sendText(openid, qqText('C25', { error: e?.message ?? e })));
		return true;
	};
	function cmdInstance(arg) {
		if (arg) return qqText('C26');
		return cmdProfile();
	}
	// 重启职责属于独立后台启动器；本插件只能提交请求，绝不自行结束 App/Host。
	async function cmdRestart() {
		const manager = ctx.get('dshInstanceManager');
		if (!manager || typeof manager.requestRestart !== 'function') {
			return qqText('C27');
		}
		try {
			await saveState();
			const result = await manager.requestRestart();
			if (!result || result.ok !== true) return qqText('C28', { error: result?.error?.message ?? result?.error ?? '后台启动器不可用' });
			return qqText('C29');
		} catch (error) {
			return qqText('C30', { error: error?.message ?? error });
		}
	}
	function sessionModelSelection(session) {
		try {
			const context = session?.requestContext?.();
			const header = session?.requestHeader?.();
			const config = header?.config ?? context;
			if (config?.provider && config?.model) {
				return { provider: config.provider, model: config.model, ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) };
			}
		} catch {
			/* 当前会话可能尚未产生请求头 */
		}
		return null;
	}
	function modelProviderText(groups) {
		return qqText('C31', { groups });
	}
	function modelListText(provider, models) {
		return qqText('C32', { provider, models });
	}
	async function cmdModel(openid) {
		const sid = perUser(openid).sessionId;
		if (!sid) return qqText('C33');
		if (typeof svc.sessionController?.modelCatalog !== 'function') {
			return qqText('C34');
		}
		try {
			const catalog = await svc.sessionController.modelCatalog();
			const groups = (Array.isArray(catalog?.groups) ? catalog.groups : [])
				.filter((g) => g && g.id && Array.isArray(g.models) && g.models.length);
			if (!groups.length) return qqText('C35');
			pendingModel[openid] = { phase: 'provider', groups, at: Date.now() };
			return modelProviderText(groups);
		} catch (e) {
			return qqText('C36', { error: e?.message ?? e });
		}
	}
	// 纯数字回复 → 消费 /模型 的供应商/模型两阶段选择；输入 0 随时取消。
	handleModelPick = (openid, text) => {
		const pending = pendingModel[openid];
		if (!pending) return false;
		const raw = String(text ?? '').trim();
		if (Date.now() - pending.at > MODEL_TTL_MS) {
			delete pendingModel[openid];
			return false;
		}
		if (!/^\d+$/.test(raw)) return false;
		const n = Number(raw);
		if (n === 0) {
			delete pendingModel[openid];
			sendText(openid, qqText('C37')).catch(() => {});
			return true;
		}
		if (pending.phase === 'provider') {
			const provider = pending.groups[n - 1];
			if (!provider) {
				sendText(openid, qqText('C38', { count: pending.groups.length, providerList: modelProviderText(pending.groups) })).catch(() => {});
				return true;
			}
			pendingModel[openid] = { phase: 'model', provider, models: provider.models, at: Date.now() };
			sendText(openid, modelListText(provider, provider.models)).catch(() => {});
			return true;
		}
		const model = pending.models[n - 1];
		if (!model) {
			sendText(openid, qqText('C39', { count: pending.models.length, modelList: modelListText(pending.provider, pending.models) })).catch(() => {});
			return true;
		}
		delete pendingModel[openid];
		const sid = perUser(openid).sessionId;
		const request = { sessionId: sid, provider: pending.provider.id, model: model.id };
		Promise.resolve().then(async () => {
			if (typeof svc.sessionController?.selectModel !== 'function') throw new Error('当前宿主不支持会话级模型切换，请升级 DSH 后重试');
			const result = await svc.sessionController.selectModel(request);
			const selected = result?.selected ?? request;
			await sendText(openid, qqText('C40', { providerId: selected.provider, modelId: selected.model }));
		}).catch((e) => sendText(openid, qqText('C41', { error: e?.message ?? e })).catch(() => {}));
		return true;
	};
	async function cmdStatus() {
		const facts = { pid: process.pid, profile, running: BOT.running, connected: BOT.connected, webPort: webPort ?? '?',
			...(BOT.url ? { ws: BOT.url } : {}) };
		try { facts.liveAgents = svc.agents ? svc.agents.list().length : 0; } catch { /* optional */ }
		try {
			facts.sessionCount = (await Promise.race([
				svc.sessionQuery.listSessions(),
				new Promise((_, reject) => setTimeout(() => reject(new Error('session listing timed out')), 2000)),
			])).length;
		} catch (e) { log(`/状态 会话计数不可用: ${e?.message ?? e}`); }
		// 多实例诊断：桌面 App 退出时可能留下孤儿宿主，多个实例各连一条 QQ → 重复回复
		try {
			facts.instances = (await liveInstances()).map(([pid, inst]) => ({ pid,
				current: Number(pid) === process.pid, cwd: inst?.cwd ?? '?' }));
		} catch { /* optional */ }
		return qqText('C42', facts);
	}

	async function cmdDisconnect(openid) {
		const per = perUser(openid);
		per.sessionId = null;
		per.disconnected = true;
		per.routingEpoch = (per.routingEpoch ?? 0) + 1;
		delete pendingNew[openid];
		delete pendingModel[openid];
		for (const [sid, run] of runs) {
			if (run.openid !== openid) continue;
			run.detached = true;
			run.stopTyping?.();
			runs.delete(sid);
		}
		for (let i = progressQueue.length - 1; i >= 0; i--) {
			if (progressQueue[i].openid === openid) progressQueue.splice(i, 1);
		}
		// 桌面卡片始终归官方 answerer；断开只清理 QQ 元数据。
		for (const entry of [...(pendingApprovals[openid] ?? []), ...(pendingQuestions[openid] ?? [])]) finishInteraction(entry, 'detached', '');
		await saveState();
		return qqText('C44');
	}
	function handleCommand(openid, text) {
		const [head, ...rest] = text.split(/\s+/);
		const arg = rest.join(' ').trim();
		switch (head) {
			case '/profile':
				return cmdProfile();
			case '/实例':
				return arg ? cmdInstance(arg) : cmdProfile();
			case '/断开':
			case '/disconnect':
				return cmdDisconnect(openid);
			case '/会话':
				return arg ? cmdAttach(openid, arg) : cmdSessions(openid);
			case '/new':
			case '/新建':
				return cmdNew(openid, arg);
			case '/模型':
			case '/model':
				return cmdModel(openid);
			case '/restart':
				return cmdRestart();
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
				return Promise.resolve(qqText('C43'));
			default:
				return Promise.resolve(qqText('C45', { command: head }));
		}
	}
	// ── QQ 消息 → DSH 的完整处理（含输入状态保活）───────────────────────────
	/**
	 * 发一条 QQ 文本消息（不截断内容）。
	 * - **带 markdown 记号**的文本用 `msg_type=2` + `markdown.content`（标题/加粗/列表/表格能渲染）；
	 *   万一官方对这条通路没开通，**自动降级为纯文本重发**（不丢回复）。
	 * - **纯文本**（`/会话`、`/提醒`、`📋 待办`…）走 `msg_type=0`：markdown 会给每个换行加段落
	 *   间距，纯清单用 markdown 发行距翻倍（用户实测反馈）；纯文本行距与旧版一致。
	 * - 超长文本按空行切片、每片 ≤ QQ_CHUNK_CHARS 分多条发；
	 *   若某条仍被接口拒（"太大"），**自动二分重试**直到单条 ≤ QQ_SPLIT_FLOOR，绝不整条丢。
	 * - `msg_id` 只挂在第一条上（被动回复的 msg_id + msg_seq 组合不能重复）。
	 */
	async function sendText(openid, content, msgId, { completionNotice = false } = {}) {
		// /断开仅静音实时会话消息；完成通知仍由 notifyOnComplete 独立控制。
		if (perUser(openid).disconnected && !msgId && !completionNotice) return;
		const epoch = perUser(openid).routingEpoch ?? 0;
		const stalePush = () => !msgId && (!completionNotice && perUser(openid).disconnected || (perUser(openid).routingEpoch ?? 0) !== epoch);
		const cfg = readCfg();
		const token = await ensureToken(cfg.appId, cfg.appSecret);
		const base = apiBase(cfg);
		const useMarkdown = looksLikeMarkdown(content);
		/** 单条发送：要 markdown 就优先 markdown、失败降级纯文本；再失败就二分。 */
		const sendOne = async (text, attachMsgId) => {
			if (stalePush()) return;
			if (useMarkdown) {
				const md = { msg_type: 2, msg_seq: ++BOT.msgSeq, markdown: { content: text } };
				if (attachMsgId) md.msg_id = attachMsgId;
				try {
					await postMessage(base, token, openid, md);
					return;
				} catch (e) {
					log(`markdown 发送失败（降级纯文本）: ${e?.message ?? e}`);
				}
			}
			if (stalePush()) return;
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
		if (perUser(openid).disconnected) return;
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
	function finishInteraction(entry, source, summary) {
		if (!entry || entry.done) return false;
		entry.done = true;
		for (const queue of [pendingApprovals, pendingQuestions]) {
			const items = queue[entry.openid];
			if (items) { const i = items.indexOf(entry); if (i >= 0) items.splice(i, 1); if (!items.length) delete queue[entry.openid]; }
		}
		const data = state.interactive;
		data.pending = data.pending.filter((p) => p.id !== entry.id);
		data.commands = data.commands.filter((c) => c.id !== entry.id);
		data.recent.unshift({ id: entry.id, sessionId: entry.sessionId, source, summary, settledAt: Date.now() });
		data.recent = data.recent.slice(0, 50);
		void saveState();
		if (source !== 'detached') sendText(entry.openid, qqText(source === 'qq' ? 'I04' : 'I05', { summary })).catch(() => {});
		return true;
	}
	function enqueueInteraction(entry, answer) {
		if (entry.done) return;
		const commands = state.interactive.commands;
		if (!commands.some((c) => c.id === entry.id)) commands.push({ id: entry.id, answer });
		void saveState();
	}
	/**
	 * 交互结束收尾。
	 * @param {Object} entry - 交互条目
	 * @param {any} outcome - 下游/QQ 给出的结果
	 * @param {'qq'|'desktop'} [source] - 结论来源（决定 QQ 回复 I04 还是 I05）
	 */
	function finishAfterAnswer(entry, outcome, source = 'desktop') {
		// Give the browser's POST /ack a bounded window after official pending.answer().
		if (state.interactive.commands.some((c) => c.id === entry.id)) {
			setTimeout(() => finishInteraction(entry, source, JSON.stringify(outcome)), 500);
			return;
		}
		finishInteraction(entry, source, JSON.stringify(outcome));
	}
	function trackInteraction(openid, data) {
		const entry = { id: randomUUID(), openid, ...data, createdAt: Date.now() };
		state.interactive.pending.push(entry);
		const target = entry.kind === 'approval' ? pendingApprovals : pendingQuestions;
		(target[openid] ??= []).push(entry);
		void saveState();
		return entry;
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
					argsText = qqText('I02c', { arguments: a });
				}
			} catch { /* best-effort */ }
		}
		const cur = perUser(openid).sessionId;
		const who = sid === cur ? '当前会话' : `会话 [${displayShort(sid)}]`;
		const lines = [
			qqText('I01', { sessionLabel: who }),
			qqText('I02a', { toolName: req.toolName ?? '?' }),
			...(req.reason ? [qqText('I02b', { reason: req.reason })] : []),
			...(argsText ? [argsText] : []),
			qqText('I03'),
		];
		await sendText(openid, lines.join('\n'));
	}
	// ── QQ 指令直接兑现（穿透等待态）────────────────────────────────────────
	/** QQ 指令 → 审批结果的合法取值。 */
	const APPROVAL_ANSWERS = new Set(['allowed-once', 'allowed-always', 'rejected']);
	/**
	 * 读取某条交互在 state 文件里的待兑现指令（**从磁盘读**，避免与 loadState 换对象竞争）。
	 * @param {string} entryId - 交互 id（trackInteraction 生成）
	 * @returns {Object|null} { id, answer }；没有则 null
	 */
	function readCommandAnswer(entryId) {
		try {
			const raw = JSON.parse(readFileSync(stateFile(), 'utf8'));
			const commands = Array.isArray(raw?.interactive?.commands) ? raw.interactive.commands : [];
			return commands.find((c) => c?.id === entryId) ?? null;
		} catch {
			return null;
		}
	}
	/**
	 * 等待 QQ 侧对某条交互的答复。
	 * - 先看内存里排队的指令（同进程内 /approve 已入队的情况），
	 * - 之后每 300ms 从 state 文件读一次（跨进程/跨重启也能看到）。
	 * 只 resolve、不 reject；外层用 Promise.race 与桌面路径竞争，不依赖取消。
	 * @param {string} entryId - 交互 id
	 * @returns {Promise<Object|null>} 指令条目，或 null 表示"暂时没有"
	 */
	function waitForCommandAnswer(entryId) {
		const immediate = (state.interactive.commands ?? []).find((c) => c?.id === entryId);
		if (immediate) return Promise.resolve(immediate);
		return new Promise((resolve) => {
			const timer = setInterval(() => {
				const found = readCommandAnswer(entryId);
				if (found) { clearInterval(timer); resolve(found); }
			}, 300);
			timer.unref?.();
		});
	}
	/**
	 * 一条审批的结论：**QQ 的 /approve /deny 与桌面卡片并行生效，谁先到用谁**。
	 * 这是 `/approve` 在"等待消息"状态下能直接穿透的关键——旧实现只把决定排进
	 * state.interactive.commands 等桌面卡片消费，卡片不在就永远悬着。
	 * @param {Object} entry - trackInteraction 的审批条目
	 * @param {() => Promise<string>} next - 下游 answerer（官方桌面卡片）
	 * @returns {Promise<string>} 'allowed-once' | 'allowed-always' | 'rejected' | 'cancelled'
	 */
	async function approvalDecision(entry, next) {
		return commandDecision(entry, next, (answer) => APPROVAL_ANSWERS.has(answer));
	}
	/**
	 * 通用「QQ 指令 / 桌面卡片 谁先到用谁」决策。
	 * @param {Object} entry - trackInteraction 生成的交互条目
	 * @param {() => Promise<any>} next - 下游 answerer（官方桌面卡片）
	 * @param {(answer: any) => boolean} accepts - 判断排队指令里的 answer 是否本流程可用的形状
	 * @returns {Promise<any>} 下游或 QQ 的答案（QQ 分支返回 answer 原值）
	 */
	async function commandDecision(entry, next, accepts) {
		// 桌面分支先启动：它会立刻走到下一层 answerer（官方卡片），不能因为等 QQ 而延后
		const desktop = Promise.resolve(next()).then((outcome) => ({ source: 'desktop', answer: outcome }));
		const qq = waitForCommandAnswer(entry.id).then((cmd) => (cmd && accepts(cmd.answer) ? { source: 'qq', answer: cmd.answer } : undefined));
		const winner = await Promise.race([desktop, qq]);
		// 桌面先答 → 把没人消费的 QQ 指令清掉，避免留下悬空指令
		if (winner.source === 'desktop') {
			const stale = state.interactive.commands ?? [];
			const kept = stale.filter((c) => c?.id !== entry.id);
			if (kept.length !== stale.length) { state.interactive.commands = kept; void saveState(); }
		}
		return { answer: winner.answer, source: winner.source };
	}
	async function approvalListener(req, next) {
		let delegated = false;
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
				if (r?.openid && !r.detached && !perUser(r.openid).disconnected && !sessionToOpenid.has(s)) sessionToOpenid.set(s, r.openid);
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
			notifyWaiting(session, (sessionName) => qqText('N02', { sessionName, toolName: req?.toolName ?? '?', ...(req?.reason ? { reason: String(req.reason).replace(/\s+/g, ' ').trim().slice(0, 40) } : {}) }));
			if (openid === undefined) return next(); // 非 QQ 会话 → 交给 Web UI 等其他 answerer
			const entry = trackInteraction(openid, { sessionId: sid, ownerSessionId, kind: 'approval', toolName: req.toolName, callId: req.callId, reason: req.reason });
			sendApprovalPrompt(openid, req, ownerSessionId).catch(() => {});
			try {
				delegated = true;
				// QQ 的 /approve /deny 直接在本 answerer 里兑现：不再只往 state.interactive.commands
				// 里排队、等桌面卡片去消费（桌面卡片不在/没渲染时，旧实现会让审批永远悬着，QQ 只回
				// 「指令已排队…」）。桌面卡片仍并行生效，谁先到用谁。
				const decision = await approvalDecision(entry, next);
				finishAfterAnswer(entry, decision.answer, decision.source);
				return decision.answer;
			} catch (error) { finishInteraction(entry, 'desktop', '请求已结束'); throw error; }
		} catch (error) {
			if (delegated) throw error;
			return next();
		}
	}
	async function cmdApprove(openid, allow) {
		const q = pendingApprovals[openid];
		if (!q || q.length === 0) return qqText('C49');
		const entry = q[0];
		if (allow && entry.ownerSessionId !== perUser(openid).sessionId) {
			return qqText('C50', { shortId: displayShort(entry.sessionId) });
		}
		enqueueInteraction(entry, allow ? 'allowed-once' : 'rejected');
		return qqText('C51');
	}
	// ── 用户问答（user-questions）桥接：模型调 ask_user_question 时经 QQ 收集回答 ──
	function settleQuestion(openid, entry, answers, notify) {
		enqueueInteraction(entry, answers ?? { answers: [] });
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
		const lines = [qqText('I06', { sessionLabel: who })];
		entry.questions.forEach((q, qi) => {
			const num = qi + 1;
			lines.push(qqText('I07', { index: num, question: q.question ?? '（无标题问题）', ...(q.detail ? { detail: q.detail } : {}) }));
			const opts = Array.isArray(q.options) ? q.options : [];
			if (opts.length > 0) {
				opts.forEach((o, oi) => {
					lines.push(qqText('I08', { index: oi + 1, label: o.label, ...(o.description ? { description: o.description } : {}) }));
				});
			} else {
				lines.push(qqText('I09'));
			}
			if (q.multiSelect === true) lines.push(qqText('I08m'));
		});
		lines.push(qqText('I10'));
		await sendText(openid, lines.join('\n'));
	}
	async function userQuestionListener(req, next) {
		let delegated = false;
		try {
			if (!BOT.running) return next();
			const session = req?.agent?.session;
			const sid = session?.header?.id ?? req?.agent?.id;
			const sessionToOpenid = new Map();
			for (const [o, p] of Object.entries(state.openids)) {
				if (p?.sessionId) sessionToOpenid.set(p.sessionId, o);
			}
			for (const [s, r] of runs) {
				if (r?.openid && !r.detached && !perUser(r.openid).disconnected && !sessionToOpenid.has(s)) sessionToOpenid.set(s, r.openid); // 无头定时会话：问题也推给那个用户
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
			notifyWaiting(session, (sessionName) => qqText('N03', { sessionName, question: q0, ...(questions.length > 1 ? { count: questions.length } : {}) }));
			if (openid === undefined) return next();
			const entry = trackInteraction(openid, { sessionId: sid, ownerSessionId, kind: 'question', questions });
			sendQuestionPrompt(openid, entry).catch(() => {});
			try {
				delegated = true;
				// 与审批同一条规则：QQ 侧的回答（/答、选项编号、自由文本）在本 answerer 里直接兑现，
				// 不再只排队等桌面卡片消费。
				const decision = await commandDecision(entry, next, (answer) => answer !== null && typeof answer === 'object');
				finishInteraction(entry, decision.source, JSON.stringify(decision.answer));
				return decision.answer;
			} catch (error) { finishInteraction(entry, 'desktop', '请求已结束'); throw error; }
		} catch (error) {
			if (delegated) throw error;
			return next();
		}
	}
	async function cmdSkipQuestion(openid) {
		const q = pendingQuestions[openid];
		if (!q || q.length === 0) return qqText('C54');
		const entry = q[0];
		if (entry.ownerSessionId !== perUser(openid).sessionId) {
			return qqText('C55', { shortId: displayShort(entry.sessionId) });
		}
		settleQuestion(openid, entry, { answers: [] }, null);
		return qqText('I13');
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
		sendText(openid, qqText(structured ? 'I11' : 'I12')).catch(() => {});
		return true;
	};

	/** /stop：停止当前接入会话正在执行的工作，并丢弃队列中未处理的消息 */
	async function cmdStop(openid) {
		const sid = perUser(openid).sessionId;
		if (!sid) return qqText('C59');
		try {
			const r = await svc.sessionController.resolveAgent(sid);
			if (!r || !r.agent) return qqText('C60', { error: r?.error?.message ?? '未知' });
			// keepInbox: false → agent.inbox.clear()：中断的同时丢弃未处理消息
			// （官方 sessionController.cancel 写死 keepInbox:true，会把队列留到下次输入时一起处理）
			r.agent.cancel({ kind: 'user' }, { keepInbox: false });
			return qqText('C61');
		} catch (e) {
			return qqText('C62', { error: e?.message ?? e });
		}
	}
	/** /权限 [预设名|重置]：查看 / 切换当前接入会话的权限预设（sandbox + approval 一起切）。 */
	async function cmdPermission(openid, arg) {
		const sid = perUser(openid).sessionId;
		if (!sid) return qqText('C63');
		const svcPerm = svc.permissionPresets;
		if (!svcPerm || typeof svcPerm.set !== 'function') return qqText('C64');
		let agent = null;
		try {
			const r = await svc.sessionController.resolveAgent(sid);
			agent = r?.agent ?? null;
		} catch {
			/* 未附着时退回 sessions 里的实例 */
		}
		const session = agent?.session ?? svc.sessions?.get?.(sid);
		if (!session) return qqText('C65', { shortId: shortIdFor(sid) });
		const names = permissionPresetNames(svcPerm);
		const want = String(arg ?? '').trim();
		const chosen = state.permPreset?.[sid] ?? null;
		if (!want) {
			const st = svcPerm.permissionState?.(session) ?? {};
			return qqText('C66', { preset: svcPerm.current?.(session) ?? '?', sandbox: st.sandbox ?? '（默认）',
				approval: st.approval ?? '（默认）', names: names.join(' / ') || '（无）', ...(chosen ? { chosen } : {}) });
		}
		if (['重置', 'reset', '默认'].includes(want)) {
			const def = svcPerm.defaultPreset ?? names[0] ?? 'workspace-write';
			if (state.permPreset) delete state.permPreset[sid];
			saveState();
			svcPerm.set(session, def);
			if (agent && svc.approval) svc.approval.setPolicy(agent, 'ask');
			log(`权限重置：会话 ${displayShort(sid)} → ${def}（approval=ask）`);
			return qqText('C67', { preset: def });
		}
		if (!names.includes(want)) return qqText('C68', { preset: want, names: names.join(' / ') || '（无）' });
		svcPerm.set(session, want);
		if (!state.permPreset) state.permPreset = {};
		state.permPreset[sid] = want;
		saveState();
		const st = svcPerm.permissionState?.(session) ?? {};
		log(`权限切换：会话 ${displayShort(sid)} → ${want}（sandbox=${st.sandbox}, approval=${st.approval}）`);
		return qqText('C69', { preset: want, sandbox: st.sandbox ?? '?', approval: st.approval ?? '?' });
	}
	/**
	 * 官方目录的返回形状容错：正常是数组，但不同版本/Remote 封装可能给
	 * 数组包一层或给「id → entry」映射；这里统一归一成数组，避免整条命令静默变空。
	 */
	function scheduleEntries(value) {
		if (Array.isArray(value)) return value.filter((x) => x && typeof x === 'object');
		if (!value || typeof value !== 'object') return [];
		for (const key of ['entries', 'items', 'value', 'records', 'tasks', 'list']) {
			if (Array.isArray(value[key])) return value[key].filter((x) => x && typeof x === 'object');
		}
		return Object.values(value).filter((x) => x && typeof x === 'object' && x.id);
	}
	/**
	 * 读官方计划任务目录（与桌面端「计划任务」页同源）：active + 已停止都给。
	 * 首选 catalog()（宿主级全量）；读不到或为空时退回官方工具同款 list({sessionId})。
	 * 两者都失败才算失败（C80），避免像以前那样静默回「没有任务」。
	 */
	async function readScheduleCatalog(api, per) {
		let error = null;
		let entries = [];
		if (typeof api.catalog === 'function') {
			try {
				entries = scheduleEntries(await api.catalog());
			} catch (e) {
				error = e;
				log(`计划任务目录读取失败: ${e?.message ?? e}`);
			}
		} else {
			error = new Error('schedule.catalog 不可用');
		}
		if (entries.length === 0 && typeof api.list === 'function') {
			const sids = [...new Set([per?.sessionId, ...(Array.isArray(per?.sessions) ? per.sessions : [])].filter(Boolean))];
			for (const sid of sids) {
				try {
					const rows = scheduleEntries(await api.list({ sessionId: sid }));
					for (const row of rows) entries.push({ ...row, sessionId: row?.sessionId ?? sid, status: row?.status ?? 'active' });
				} catch (e) {
					error = error ?? e;
					log(`计划任务列表读取失败（${displayShort(sid)}）: ${e?.message ?? e}`);
				}
			}
		}
		return { entries, error };
	}
	/**
	 * 官方 schedule 记录 → 一行 QQ 文本（目录里的 T06）。
	 * 只做本地时间换算、截断与「←当前」标记；规则名称、图标、括号等文案全在 messages.js。
	 */
	function scheduleRow(entry, nowMs, currentSessionId) {
		const d = new Date(entry?.scheduledAt ?? nowMs);
		const pad = (n) => String(n).padStart(2, '0');
		const next = Number.isNaN(d.getTime()) ? '?' : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		return qqText('T06', {
			id: String(entry?.id ?? '?').slice(0, 8),
			title: oneLine(entry?.title, 40),
			kind: entry?.kind ?? 'at',
			...(entry?.everySeconds === undefined ? {} : { everySeconds: entry.everySeconds }),
			...(entry?.time === undefined ? {} : { time: entry.time }),
			...(Array.isArray(entry?.weekdays) ? { weekdays: entry.weekdays } : {}),
			...(entry?.expression === undefined ? {} : { expression: entry.expression }),
			...(entry?.timeZone === undefined ? {} : { timeZone: entry.timeZone }),
			next,
			session: shortIdFor(entry?.sessionId),
			active: entry?.status !== 'inactive',
			current: !!currentSessionId && entry?.sessionId === currentSessionId,
		});
	}
	/**
	 * /提醒 [删 <ID>]：**直接查看官方计划任务**（与桌面端任务页同源，含已停止）。
	 * 删除支持唯一前缀；只有「该任务所在会话正绑在别的 QQ 账号上」才拒绝（C78），
	 * 避免一个 QQ 号删掉另一个 QQ 号会话里的任务。
	 */
	async function cmdSchedule(openid, arg) {
		const api = svc.schedule;
		if (!api || typeof api.catalog !== 'function' && typeof api.list !== 'function') return qqText('C77');
		const per = perUser(openid);
		const { entries, error } = await readScheduleCatalog(api, per);
		const all = entries;
		const parts = String(arg ?? '').trim().split(/\s+/).filter(Boolean);
		if (parts.length >= 2 && ['删', '取消', 'del', 'rm', 'delete'].includes(parts[0].toLowerCase())) {
			if (typeof api.delete !== 'function') return qqText('C77');
			const prefix = parts[1];
			const exact = all.filter((entry) => String(entry.id) === prefix);
			const hits = exact.length ? exact : all.filter((entry) => String(entry.id).startsWith(prefix));
			if (hits.length === 0) return error && all.length === 0 ? qqText('C80', { error: error?.message ?? error }) : qqText('C70', { id: prefix });
			if (hits.length > 1) return qqText('C79', { prefix });
			const owner = openidForSession(hits[0].sessionId);
			if (owner && owner !== openid) return qqText('C78', { shortId: shortIdFor(hits[0].sessionId) });
			try {
				const result = await api.delete({ sessionId: hits[0].sessionId, id: hits[0].id });
				if (!result || result.deleted !== true) return qqText('C70', { id: prefix });
			} catch (e) {
				log(`计划任务取消失败: ${e?.message ?? e}`);
				return qqText('C80', { error: e?.message ?? e });
			}
			log(`计划任务 ${hits[0].id} 已由 QQ 用户取消（会话 ${displayShort(hits[0].sessionId)}）`);
			return qqText('C71', { id: String(hits[0].id).slice(0, 8), count: Math.max(0, all.length - 1) });
		}
		if (all.length === 0) return error ? qqText('C80', { error: error?.message ?? error }) : qqText('C72');
		const now = Date.now();
		const rows = [...all]
			.sort((a, b) => String(a?.scheduledAt ?? '').localeCompare(String(b?.scheduledAt ?? '')))
			.map((entry) => scheduleRow(entry, now, per.sessionId));
		return qqText('C73', { count: all.length, rows });
	}
	handleUserText = async (openid, msgId, text, images = []) => {
		const per = perUser(openid);
		if (text.startsWith('/')) {
			const reply = await handleCommand(openid, text);
			if (reply) await sendText(openid, reply, msgId);
			return;
		}
		if (!text && images.length === 0) return;
		if (per.disconnected) {
			await sendText(openid, qqText('C74'), msgId);
			return;
		}
		const routingEpoch = per.routingEpoch ?? 0;
		// 立即提交给 DSH（排队/插话由 DSH 原生模式决定），由回复观察器负责把结果回给 QQ
		try {
			// 图片先下载成 base64（QQ 的 CDN 链接有时效），失败要在提交前告诉用户
			let imageParts = [];
			if (images.length > 0) {
				try {
					imageParts = await downloadQqImages(images);
				} catch (e) {
					log(`图片接收失败: ${e?.message ?? e}`);
					await sendText(openid, qqText('C75', { error: e?.message ?? e }), msgId).catch(() => {});
					if (!text) return;
				}
			}
			if (per.disconnected || (per.routingEpoch ?? 0) !== routingEpoch) return;
			const sessionId = await ensureSession(per);
			if (per.disconnected || (per.routingEpoch ?? 0) !== routingEpoch) { if (per.disconnected) per.sessionId = null; await saveState(); return; }
			rememberSession(openid, sessionId);
			const beforeTurn = await currentTurn(sessionId);
			if (per.disconnected || (per.routingEpoch ?? 0) !== routingEpoch) return;
			await submitPrompt(sessionId, text, imageParts);
			ensureReplier(openid, sessionId, beforeTurn);
		} catch (e) {
			log(`提交失败: ${e?.message ?? e}`);
			try {
				await sendText(openid, qqText('C76', { error: e?.message ?? String(e) }), msgId);
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
		// 独占锁：同一份凭证只允许一个实例连 QQ。多实例（桌面 App 退出时留下的孤儿宿主）
		// 会各持一条长连接，同一条私聊消息被回复 N 次——本机实测 3 次。
		const claim = claimQqOwnership();
		if (!claim.ok) {
			log(`另一个 DSH 实例 (pid=${claim.owner}) 正在服务 QQ 桥接 → 本实例不连 QQ，避免重复回复；30 秒后重试接管。`);
			if (BOT.lockTimer) clearTimeout(BOT.lockTimer);
			BOT.lockTimer = setTimeout(() => {
				BOT.lockTimer = null;
				startBot();
			}, 30000);
			BOT.lockTimer.unref?.();
			return;
		}
		BOT.running = true;
		BOT.retry = 0;
		BOT.msgSeq = Math.floor(Date.now() / 1000) % 1000000;
		BOT.chains = new Map();
		log(`启动：${cfg.sandbox ? '沙箱' : '正式'}环境（持有 QQ 独占锁 pid=${process.pid}）`);
		connectLoop();
	};
	stopBot = () => {
		if (!BOT.running) return;
		BOT.running = false;
		BOT.connected = false;
		stopWsWatchdog();
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
		if (BOT.lockTimer) {
			clearTimeout(BOT.lockTimer);
			BOT.lockTimer = null;
		}
		BOT.ws = null;
		log('已停止');
	};
	restartBot = () => {
		stopBot();
		startBot();
	};
	// 0.1.7+：配置应用时机。本函数在每次 apply（首次挂载 + 每次设置保存后 Loader 重建）末尾调用。
	// 连接参数（凭证 / 开关 / 沙箱）变了或首次挂载 → 按需启停/重启 WS；
	// 只动了运行时实时读取的键（超时 / 插话 / 状态推送 / 推送内容）→ 不碰连接。
	onSettingsApplied = () => {
		const cfg = readCfg() || {};
		const connKey = connKeyOf(cfg);
		const first = appliedConnKey === null;
		if (connKey === appliedConnKey) {
			if (!first) log('配置已应用 → 非连接参数，免重启');
			return;
		}
		appliedConnKey = connKey;
		const shouldRun = !!(cfg.enabled && cfg.appId && cfg.appSecret);
		if (shouldRun && !BOT.running) {
			if (!first) log('配置已应用 → 启动');
			startBot();
		} else if (!shouldRun && BOT.running) {
			log('配置已应用 → 停止');
			stopBot();
		} else if (shouldRun && BOT.running) {
			log('配置已应用 → 重启（应用新凭证/参数）');
			restartBot();
		}
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
		// 0.1.7+：配置由 Loader 按静态 Config 校验后作为第二个参数传进来；
		// 设置页的表单由宿主依据同一份 schema 自动生成（不再需要 settings.register）。
		readCfg = () => config ?? {};
		// 自动页面：让设置页按 schema 自动生成本插件的卡片。
		try {
			host.settings.configure({ auto: true }, ctx.fiber);
		} catch (e) {
			log(`settings.configure 失败: ${e?.message ?? e}`);
		}
		registerInstance({ pid: process.pid, webPort, bridgePort: null, profile, cwd: process.cwd(), startedAt });
		log(`已加载（v0.16.4, web:${webPort ?? '?'}）。到设置页 → 插件配置 → dsh-qq-bridge，填写凭证并打开"启用"。（设置页改动即自动保存，没有保存按钮）`);
		ctx.inject(['connection'], (trusted) => {
			for (const [path, method] of [['pending', 'GET'], ['ack', 'POST']]) {
				const dispose = svc.webServer.register({ kind: 'exact', path: `/dsh-qq-bridge/interactive/${path}`, handler: async (req, res) => {
					const rejection = trusted.connection.requestRejection(req);
					if (rejection) return json(res, rejection, { ok: false, error: 'unauthorized' });
					if (req.method !== method) return json(res, 405, { ok: false, error: 'method' });
					if (method === 'GET') return json(res, 200, { ok: true, pending: state.interactive.pending.map(({ openid, ...entry }) => entry), commands: state.interactive.commands, recent: state.interactive.recent });
					let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
					if (!body || typeof body.id !== 'string' || !['qq', 'desktop'].includes(body.source) || (body.summary !== undefined && typeof body.summary !== 'string')) return json(res, 400, { ok: false, error: 'bad payload' });
					const entry = state.interactive.pending.find((p) => p.id === body.id);
					finishInteraction(entry, body.source, String(body.summary ?? '').slice(0, 1500));
					return json(res, 200, { ok: true, alreadySettled: !entry });
				} });
				trusted.on('dispose', dispose);
			}
		});
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
							// 0.1.7+：经 configEditor 把整份 config 落盘到 profile patch，
							// Loader reconcile 后新 config 会以参数形式回到 apply。
							const editor = ctx.get('configEditor');
							const entry = ctx.fiber?.entry;
							if (editor === void 0 || entry === void 0) throw new Error('configEditor 不可用（无法保存配置）');
							await editor.edit(entry, (current) => ({ ...(current ?? {}), ...patch }));
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
		// /会话 数据通路诊断出口（只读；回计数/耗时/降级来源，不回会话正文）
		// GET /dsh-qq-bridge/sessions-diag
		try {
			svc.webServer.register({
				kind: 'exact',
				path: '/dsh-qq-bridge/sessions-diag',
				handler: async (req, res) => {
					if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method' });
					let collected;
					try {
						collected = await collectSessionRows();
					} catch (e) {
						return json(res, 200, { ok: false, stage: 'collect', error: e?.message ?? String(e) });
					}
					return json(res, 200, {
						ok: true,
						source: collected.source,
						queryError: collected.error,
						ms: collected.ms,
						records: collected.rows.length,
						visible: collected.visible.length,
						deletedIds: deletedSessionIds().size,
						webPort: currentWebPort(),
						perRow: collected.rows.map((row) => ({ shortId: shortIdFor(row.id), hasTitle: !!row.title, userMsgs: row.userMsgs, cwd: cwdLabel(row.cwd) })),
					});
				},
			});
		} catch (e) {
			log(`诊断路由注册失败: ${e?.message ?? e}`);
		}
		// 审批 answerer：prepend+global → 瀑布最外层；QQ 会话由 QQ 用户 /approve /deny 决定
		ctx.on('approval/request', approvalListener, { global: true, prepend: true });
		// 用户问答 answerer：模型调 ask_user_question 时经 QQ 收集回答（/答 /跳过）
		ctx.on('user-questions/request', userQuestionListener, { global: true, prepend: true });
		// 0.1.7 修复：`readCfg` 要到本回调（ctx.inject 的回调总是异步执行）内才被接上真配置，
		// 而 apply 顶层末尾那次 onSettingsApplied() 早已用空配置判过一轮：
		//   → 首启不启动（shouldRun 恒 false，且 appliedConnKey 已被置为非 null）
		//   → 设置页改动也无效（顶层同步读到的是上一轮 config 闭包，connKey 相同 → 提前 return）
		// 因此必须在配置真正就位之后（本回调末尾）再判一次。该调用幂等：
		// 若本回调因依赖重载再次执行，connKey 不变 → 提前 return，不会重复启动。
		onSettingsApplied();
	});
	// agent-presets 可选：/new 的 mode= 靠它列模式。**单独**一条 inject，不并进上面那条
	// 必填依赖 —— 没挂 roster 的 profile 上桥接照常工作，只是 /new 不支持 mode=。
	ctx.inject(['agentPresets'], (presetCtx) => {
		svc.agentPresets = presetCtx.agentPresets;
	});
	// 官方计划任务（@deepseek-ai/dsh-experimental-schedule-bundle）可选：/提醒 用它管理任务。
	// 未启用时 /提醒 回 C77，桥接其余功能不受影响。
	ctx.inject(['schedule'], (schedCtx) => {
		svc.schedule = schedCtx.schedule;
	});
	// 0.1.7+：设置页保存会经 configEditor 落盘，Loader 随即 unload + 以新 config 重跑 apply，
	// 所以「配置变更 → 启停/重启」的判定直接放在 apply 内完成（见下面 onSettingsApplied）。
	onSettingsApplied();
	ctx.on('dispose', async () => {
		stopBot();
		releaseQqOwnership();
		unregisterInstance();
		await saveState();
	});}

// 富媒体纯函数/流程导出给"真机联调脚本"（_tools/qq-send-file.mjs）：直接跑生产代码，不经宿主重启。
export { qqFileType, fileDigests, uploadQqFile, sendQqMedia, ensureToken };

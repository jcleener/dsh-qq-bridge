/** * dsh-qq-bridge — host half of the QQ bridge, single-plugin edition. * * One DSH plugin that is BOTH the QQ bot client and the DSH driver: *   - connects to the QQ official robot platform (WSS long connection) and *     handles C2C direct messages, with reconnect backoff and heartbeat; *   - drives DSH sessions in-process via current-version services *     (sessionController / sessionQuery / sessions / approval) — no gateway, *     no HTTP bridge, no registry-dependent routing; *   - configured from the DSH settings page ("qq-bridge" namespace): *     appId / appSecret / sandbox / enabled toggle / chat timeout / new-session cwd. * * Only the final assistant text is sent back to QQ: reasoning / tool-call / * tool-result are separate content-block types and are filtered out, so the * user never sees thinking or tool traces. * * QQ-driven sessions always run with approval policy 'never' (fail-closed): * QQ cannot answer an interactive approval prompt, so anything needing * approval is rejected and the model is told so. Web-UI sessions are unaffected. * * Requirements: DSH current version (0.1.5-rc.1 service layer), Node >= 22 * (global fetch / WebSocket). Zero npm dependencies — only node builtins and * @deepseek-ai/schemastery (ships with DSH) for the settings schema. */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
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
	compact: z.boolean().default(true), // 精简回复模式：true=只回最终结果；false=同时推送中间过程
	createCwd: z.string().default(''),});
const QQ_INTENTS = 1 << 25; // C2C_MESSAGE_CREATE + GROUP_AT_MESSAGE_CREATE
const SESSION_LIST_CAP = 30; // /会话 最多展示条数（按创建时间倒序）
const BOT = { running: false, connected: false, retry: 0, ws: null, heartbeat: null, retryTimer: null, lastSeq: null, msgSeq: 0, chains: new Map() };
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
const freshState = () => ({ next: SHORT_BASE, map: {}, openids: {} });
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

// ── formatting helpers ─────────────────────────────────────────────────────
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
	const content = String(d?.content ?? '').trim();
	if (!openid || !content || !handleUserText) return;
	log(`C2C ${openid.slice(0, 8)}…: ${content.slice(0, 40)}`);
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
	// 普通消息：立即交给 handleUserText 提交给 DSH。
	// 排队/插话一律走 DSH 原生机制（prompt 的 mode: 'queue' | 'steer'），桥接不再自己扣消息：
	// 排队中的内容因此真实进入会话 inbox，在 Web UI 可见，顺序与取消也由 DSH 管理。
	handleUserText(openid, msgId, content).catch(() => {});}
async function connectLoop() {
	if (!BOT.running) return;
	try {
		const cfg = readCfg();
		const token = await ensureToken(cfg.appId, cfg.appSecret);
		const url = await getGatewayUrl(token, apiBase(cfg));
		BOT.token = token;
		BOT.url = url;
		// 只允许「当前 socket」驱动状态：旧 socket 的 onmessage/onclose 一律忽略。
		// 否则重连/重启竞态下旧连接不会立即失效 → 两条连接同时收消息 →
		// 同一条 QQ 消息被处理两次（/approve 回两句、插话入两条）。
		const prevWs = BOT.ws;
		const socket = new WebSocket(url);
		BOT.ws = socket;
		try {
			prevWs?.close();
		} catch {
			/* ignore */
		}
		socket.onopen = () => {
			if (BOT.ws !== socket) return;
			log(`WS 已连接 ${url}`);
		};
		socket.onmessage = (ev) => {
			if (BOT.ws !== socket) return;
			try {
				handleWsFrame(ev?.data);
			} catch (e) {
				// 帧处理异常绝不能炸进程：记日志继续收下一条
				log(`WS 帧处理异常: ${e?.stack ?? e}`);
			}
		};
		socket.onclose = () => {
			if (BOT.ws !== socket) return; // 旧连接的关闭不影响当前连接
			BOT.connected = false;
			if (BOT.heartbeat) {
				clearInterval(BOT.heartbeat);
				BOT.heartbeat = null;
			}
			log('WS 已关闭');
			scheduleReconnect();
		};
		socket.onerror = (e) => {
			if (BOT.ws !== socket) return;
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
	const svc = { settings: null, sessionController: null, sessionQuery: null, sessions: null, approval: null };
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
	// 过程推送：精简回复模式关闭时，把工具调用推给 QQ
	ctx.on('session/event', (session, event) => {
		if (event?.type !== 'tool/call') return;
		const sid = session?.id;
		let a = String(event.data?.arguments ?? '');
		if (a.length > 120) a = a.slice(0, 120) + '…';
		const line = `🔧 ${event.data?.name ?? '?'}${a ? ` ${a}` : ''}`;
		recordTool(sid, line); // 始终记录：供超时/中断时打包回放
		if (readCfg().compact === false) {
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
		// 轮询兜底：事件订阅万一不触发也能收敛
		poll = setInterval(() => {
			const sess = svc.sessions?.get(sessionId);
			if (!sess) return;
			let events;
			try {
				events = sess.snapshotEvents();
			} catch {
				return;
			}
			for (const e of events) {
				const turn = e?.data?.turn;
				if (typeof turn !== 'number' || turn <= beforeTurn) continue;
				if (e.type === 'assistant/message') {
					if (!w.assistantEvents.some((x) => x.seq === e.seq)) w.assistantEvents.push(e);
				} else if (e.type === 'turn/end') {
					w.reason = e.data?.reason ?? null;
					w.endedTurn = turn;
					w.finish();
					return;
				}
			}
		}, 500);
		poll.unref?.();
		timer = setTimeout(() => {
			w.timedOut = true;
			try {
				onTimeout?.();
			} catch {
				/* ignore */
			}
			w.finish();
		}, timeoutMs);
		timer.unref?.();
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
			const created = await svc.sessionController.create(readCfg().createCwd ? { cwd: readCfg().createCwd } : {});
			sessionId = created.sessionId;
			per.sessionId = sessionId;
			saveState();
		}
		try {
			const r = await svc.sessionController.resolveAgent(sessionId);
			if (r && r.agent && svc.approval) svc.approval.setPolicy(r.agent, 'ask'); // QQ 会话：审批走 QQ 通知 + /approve /deny
		} catch {
			/* best-effort */
		}
		return sessionId;
	}
	/** 提交一条消息：插话开关开且有轮次在跑 → steer（并入当前轮）；否则 queue（DSH 原生排队） */
	async function submitPrompt(sessionId, text) {
		const r = runs.get(sessionId);
		const mode = readCfg().steer && r && r.inTurn ? 'steer' : 'queue';
		// prompt(request, signal)：signal 必传（AbortSignal）。缺省会抛 TypeError，
		// 且被 DSH 服务边界判为 fatal load failure 直接退出整个进程。
		await svc.sessionController.prompt(
			{ requestId: randomUUID(), sessionId, mode, content: [{ type: 'text', text }] },
			new AbortController().signal,
		);
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
				: `⚠️ 处理超时（>${Math.round((readCfg().chatTimeoutMs || 300000) / 60000)} 分钟）`;
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
				while (true) {
					state.inTurn = true;
					const waiter = waitForTurn(sessionId, base, readCfg().chatTimeoutMs || 300000, null);
					const result = await waiter.promise;
					state.inTurn = false;
					base = result.endedTurn ?? base;
					const digest = takeToolDigest(sessionId);
					await sendText(state.openid, formatTurn(result, digest));
					if (result.timedOut) break;
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
	// ── 过程推送（精简回复模式关闭时启用）─────────────────────────────────
	// 每条工具调用单独成一条 QQ 消息、实时发出（不合并、不丢弃）；
	// 仅保留 0.6s 最小间隔以防触发 QQ 频控。每日额度 1000 条，正常用量足够。
	const progressQueue = [];
	let progressBusy = false;
	const PROGRESS_BACKLOG_MAX = 200; // 防止异常刷屏：积压超限则丢弃并记日志
	function openidForSession(sid) {
		for (const [o, p] of Object.entries(state.openids)) if (p?.sessionId === sid) return o;
		return null;
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
				let lastUserPreview = null;
				let lastAssistantPreview = null;
				try {
					const surf = await svc.sessionQuery.readSurface(h.id);
					const ue = surf.events.filter((e) => e.type === 'user/message');
					const ae = surf.events.filter((e) => e.type === 'assistant/message');
					userMsgs = ue.length;
					lastUserPreview = textOfEvent(ue.at(-1));
					lastAssistantPreview = textOfEvent(ae.at(-1));
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
					lastUserPreview,
					lastAssistantPreview,
				};
			}),
		);
		// 空壳会话（无标题且无任何用户消息）不展示，避免出现看不懂的 UUID 片段条目
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
				lines.push(`     ${fmtTime(s.createdAt)} · ${s.userMsgs}问 · ${s.agentPreset ?? 'standard'}`);
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
	const pendingNew = {}; // openid -> { list: string[], at: number }
	const NEW_TTL_MS = 10 * 60 * 1000;
	/** 已知工作区（取自历史会话的 cwd，按最近使用排序） */
	async function workspaceList() {
		const records = await svc.sessionQuery.listSessions();
		const byCwd = new Map();
		for (const r of records) {
			const cwd = r?.header?.cwd;
			if (!cwd) continue;
			const t = r.header.createdAt ?? 0;
			if (!byCwd.has(cwd) || t > byCwd.get(cwd)) byCwd.set(cwd, t);
		}
		return [...byCwd.entries()].sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd);
	}
	function newListText(list) {
		const lines = ['📂 选择工作区（回复数字即可在其下新建会话）：', ''];
		list.forEach((cwd, i) => lines.push(`${i + 1}. [${cwdLabel(cwd)}]  ${cwd}`));
		lines.push('', `回复 1-${list.length}；也可直接 /new <编号>。`);
		return lines.join('\n');
	}
	/** 在指定工作区新建会话并接入（并把它记账进 Workspace Registry，供 Web UI 分组） */
	async function makeSessionIn(openid, cwd) {
		const created = await svc.sessionController.create({ cwd });
		const sid = created?.sessionId ?? created?.id;
		if (!sid) return '❌ 新建失败：未返回会话 ID。';
		// Web UI 的分组依据是 Workspace 的 sessionIds「记账」（attachSession），
		// 光有 cwd 不算归组：先登记该目录（幂等），再把会话 attach 进去。
		// attachSession 内部会校验 realpath(会话 cwd) === 工作区 path，不匹配会抛错。
		try {
			const reg = svc.workspaceRegistry;
			if (reg && typeof reg.resolveByPath === 'function') {
				let ws = await reg.resolveByPath(cwd);
				if (!ws && typeof reg.create === 'function') ws = await reg.create(cwd);
				if (ws && typeof ws.attachSession === 'function') await ws.attachSession(sid);
			}
		} catch (e) {
			log(`workspace 记账失败（会话已建，仅影响 Web UI 分组）: ${e?.message ?? e}`);
		}
		perUser(openid).sessionId = sid;
		const short = shortIdFor(sid);
		saveState();
		return `✅ 已在工作区 [${cwdLabel(cwd)}] 新建会话 [${short}] 并接入（之后的普通消息都发到这里；/会话 可看列表）。`;
	}
	async function cmdNew(openid, arg) {
		const list = await workspaceList();
		const n = Number(String(arg ?? '').trim());
		if (Number.isInteger(n) && n > 0) {
			if (n > list.length) return `❌ 编号超范围（1-${list.length}）。\n\n${newListText(list)}`;
			return makeSessionIn(openid, list[n - 1]);
		}
		if (!list.length) return '当前没有任何已知工作区（还没有历史会话）。';
		pendingNew[openid] = { list, at: Date.now() };
		return newListText(list);
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
			pendingNew[openid] = { list: pend.list, at: Date.now() };
			sendText(openid, `❌ 编号超范围（1-${pend.list.length}）。\n\n${newListText(pend.list)}`).catch(() => {});
			return true;
		}
		makeSessionIn(openid, pend.list[n - 1])
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
		lines.push('', '指令: /profile /会话 /会话 <ID> /实例 <端口> /状态 /帮助');
		return lines.join('\n');
	}
	const CMD_HELP = [
		'QQ-DSH 桥接（单插件版）',
		'只回复最终结果，思考过程与工具调用不展示。',
		'指令：',
		'  /profile        查看实例',
		'  /会话           列出会话（按工作区）',
		'  /会话 <4位ID>    接入某个会话（ID 固定，跨重启不变）',
		'  /new            列出工作区并新建会话（回复数字选择）',
		'  /实例 <端口>     查看实例（跨实例请回 Web UI）',
		'  /状态           全链路体检',
		'  /approve        允许当前会话的待审批请求',
		'  /deny           拒绝待审批请求',
		'  /跳过           跳过待回答的问题',
		'  /stop           停止当前会话正在执行的工作',
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
			case '/帮助':
			case '/help':
			case '/?':
				return Promise.resolve(CMD_HELP);
			default:
				return Promise.resolve(`未知指令 ${head}。用 /帮助 查看指令。`);
		}
	}
	// ── QQ 消息 → DSH 的完整处理（含输入状态保活）───────────────────────────
	async function sendText(openid, content, msgId) {
		const cfg = readCfg();
		const token = await ensureToken(cfg.appId, cfg.appSecret);
		const body = { content, msg_type: 0, msg_seq: ++BOT.msgSeq };
		if (msgId) body.msg_id = msgId;
		await postMessage(apiBase(cfg), token, openid, body);
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
			// 反查 openid：主会话直查；一级子会话(subagent)沿 parentSession 上溯
			const sessionToOpenid = new Map();
			for (const [o, p] of Object.entries(state.openids)) {
				if (p?.sessionId) sessionToOpenid.set(p.sessionId, o);
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
			if (openid === undefined) return next();
			const questions = Array.isArray(req?.questions) ? req.questions : [];
			if (questions.length === 0) return next();
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
	handleUserText = async (openid, msgId, text) => {
		const per = perUser(openid);
		if (text.startsWith('/')) {
			const reply = await handleCommand(openid, text);
			if (reply) await sendText(openid, reply, msgId);
			return;
		}
		if (!text) return;
		// 立即提交给 DSH（排队/插话由 DSH 原生模式决定），由回复观察器负责把结果回给 QQ
		try {
			const sessionId = await ensureSession(per);
			const beforeTurn = await currentTurn(sessionId);
			await submitPrompt(sessionId, text);
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
		try {
			BOT.ws?.close();
		} catch {
			/* ignore */
		}
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
		svc.workspaceRegistry = ctx.get('workspaceRegistry'); // 可选：/new 把新会话记账进工作区（Web UI 分组依据）
		try {
			host.settings.register('qq-bridge', SCHEMA);
		} catch (e) {
			log(`settings.register 失败（可能已注册）: ${e?.message ?? e}`);
		}
		readCfg = () => host.settings.get('qq-bridge') ?? {};
		registerInstance({ pid: process.pid, webPort, bridgePort: null, profile, cwd: process.cwd(), startedAt });
		log(`已加载（v0.7.9, web:${webPort ?? '?'}）。到设置页 → QQ 桥接，填写凭证并打开"启用"。`);
		try {
			svc.webServer.register({
				kind: 'exact',
				path: '/dsh-qq-bridge/settings',
				handler: async (req, res) => {
					if (req.method === 'OPTIONS') {
						res.writeHead(204, {
							'access-control-allow-origin': '*',
							'access-control-allow-methods': 'GET,POST,OPTIONS',
							'access-control-allow-headers': 'content-type',
						});
						return res.end();
					}
					if (req.method === 'GET') {
						json(res, 200, {
							ok: true,
							settings: readCfg(),
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
						try {
							await host.settings.update('qq-bridge', input);
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
	});
	// 设置变更 → 启停 / 重启
	ctx.on('settings/updated', (ns, next) => {
		if (String(ns) !== 'qq-bridge') return;
		const cfg = next && typeof next === 'object' ? next : {};
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

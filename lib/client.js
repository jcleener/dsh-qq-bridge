/**
 * dsh-qq-bridge — client half (browser plugin).
 *
 * Registers a "QQ 桥接" settings section (`settings.section`). All data goes
 * through same-origin host routes:
 *   GET  /dsh-qq-bridge/settings  → { ok, settings, status }
 *   POST /dsh-qq-bridge/settings  → { ok } (whitelisted merge patch)
 *
 * 分区渲染：凭证（appId/appSecret）、开关（启用 / 沙箱 / 插话 / 完成通知）、
 * 单轮超时、连接状态行，以及「消息推送内容」框的 4 个勾选项
 * （待办清单 📋 / 交付清单 📎 / 工具调用 🔧 / 旁白 💬）。
 * 没有「新建会话工作区」了：兜底新建由 DSH 兜到实例目录，要指定项目用 QQ 的 /new 选工作区。
 *
 * 改动即自动保存（无需点按钮）：
 *   - 开关：点击后立刻提交（启停/重启 WS 连接）；
 *   - 文本框 / 数字框：停止输入 700ms 后提交，连续输入合并为一次；
 *   - appSecret：失焦或回车时提交 —— 不把半截密文写进宿主以免无谓重启；
 *   - 只提交真正变化的键；值改回服务端现值则不提交；
 *   - 提交在飞时又有改动 → 本轮结束后自动续传；
 *   - 提交失败 → 改动留在待提交队列，自动重试两次（2s / 5s），仍失败红字提示；
 *   - 没有保存按钮：所有改动都自动落盘。
 */
window.__ModuleLoader__.load({
	id: "dsh-qq-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		//#region styles
		const css = [
			".qqb-section{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}",
			".qqb-head{align-items:baseline;gap:7px;padding:0 2px;display:flex}",
			".qqb-head h3{font-size:13px;font-weight:600;line-height:20px;margin:0}",
			".qqb-head span{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px}",
			".qqb-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;min-width:0;gap:12px;padding:12px 14px;display:flex;flex-direction:column}",
			".qqb-row{display:flex;align-items:center;gap:10px;min-width:0}",
			".qqb-row .k{flex:1;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".qqb-row .sub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:1px}",
			".qqb-input{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 9px;font-size:13px;line-height:18px;width:240px;flex:none}",
			".qqb-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".qqb-switch{flex:none;width:36px;height:20px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:999px;cursor:pointer;position:relative;padding:0;transition:background .12s}",
			".qqb-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".qqb-switch[data-on=true]{background:var(--dsw-alias-brand-primary);border-color:transparent}",
			".qqb-switch[aria-busy=true]{opacity:.6;cursor:wait}",
			".qqb-knob{background:var(--dsw-alias-label-primary);border-radius:999px;width:14px;height:14px;position:absolute;top:2px;left:2px;transition:transform .12s}",
			".qqb-switch[data-on=true] .qqb-knob{transform:translateX(16px);background:var(--dsw-alias-bg-layer-1)}",
			".qqb-actions{display:flex;align-items:center;gap:10px;margin-top:2px}",
			".qqb-save{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;margin-left:auto}",
			".qqb-status{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:0 2px;font-variant-numeric:tabular-nums}",
			".qqb-status .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}",
			".qqb-status .ok{background:var(--dsw-alias-state-success-primary)}",
			".qqb-status .warn{background:var(--dsw-alias-state-warn-primary)}",
			".qqb-status .off{background:var(--dsw-alias-label-tertiary)}",
			".qqb-notice{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px;padding:0 2px}",
			".qqb-hint{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;padding:0 2px}",
			".qqb-group{border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px;gap:10px;display:flex;flex-direction:column}",
			".qqb-grouphead{display:flex;flex-direction:column;gap:1px;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".qqb-grouphead .sub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-weight:400}",
			".qqb-check{display:flex;align-items:flex-start;gap:9px;min-width:0;cursor:pointer}",
			".qqb-check input{flex:none;width:15px;height:15px;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}",
			".qqb-check:focus-within .t{color:var(--dsw-alias-brand-primary)}",
			".qqb-check input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".qqb-check .t{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".qqb-check .sub{display:block;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}"
		].join("");
		const tagId = "dsh-qq-bridge/Section.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-qq-bridge";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region section
		const FIELD_LABELS = {
			enabled: "启用桥接",
			appId: "AppID",
			appSecret: "AppSecret",
			sandbox: "沙箱环境",
			chatTimeoutMs: "单轮超时（毫秒）",
			steer: "插话方式（工作中）",
			notifyOnComplete: "QQ接受会话完成状态"
		};
		/** 文本框/数字框停止输入后多久提交（毫秒）。 */
		const AUTOSAVE_DEBOUNCE_MS = 700;
		/** 提交失败后的自动重试间隔（毫秒）；没有保存按钮，靠它兜底。 */
		const AUTOSAVE_RETRY_MS = [2000, 5000];
		/**
		 * commit 语义：
		 *   now      — 点完立刻提交（开关）
		 *   debounce — 停止输入 AUTOSAVE_DEBOUNCE_MS 后提交（文本/数字）
		 *   blur     — 失焦或回车才提交（密文：避免半截密文写进宿主触发重启）
		 */
		const FIELDS = [
			{ key: "enabled", type: "switch", commit: "now", sub: "打开即连接 QQ；关闭即断开" },
			{ key: "appId", type: "text", commit: "debounce", placeholder: "QQ 开放平台机器人 AppID" },
			{ key: "appSecret", type: "secret", commit: "blur", placeholder: "机器人 AppSecret（密文）" },
			{ key: "sandbox", type: "switch", commit: "now", sub: "勾选走沙箱环境 sandbox.api.sgroup.qq.com" },
			{ key: "chatTimeoutMs", type: "number", commit: "debounce", sub: "默认 300000（5 分钟）" },
			{ key: "steer", type: "switch", commit: "now", sub: "开：工作期间的消息直接插话进当前会话（打断当前步骤）；关：排队，等当前工作结束后再处理" },
			{ key: "notifyOnComplete", type: "switch", commit: "now", sub: "开：会话完成、以及卡在等你选择 / 等你审批时都推给 QQ；QQ 正在聊的那个会话不重复推，子会话不推" }
		];
		/**
		 * 「消息推送内容」：4 个勾选项，逐类控制哪些中间消息推到 QQ。
		 * key 与宿主 pushEnabled(cfg, key) 一一对应；最终回复不受这些勾选项影响（始终推）。
		 * 注意：文件本体不在其中 —— 只有你点名要文件时才会发（模型调 qq_send_file）。
		 */
		const PUSH_FIELDS = [
			{ key: "pushTodo", label: "待办清单", sub: "模型更新待办时推 📋 清单（✅ / ▶ / ⬜ 逐条，最多 15 条；清单没变不重复推）" },
			{ key: "pushDeliverable", label: "交付清单", sub: "present 交付文件时推一条 📎 清单（文件名 + 说明）。只影响这条文本，不涉及文件本体" },
			{ key: "pushToolCall", label: "工具调用", sub: "每次工具调用推一行 🔧 名称 + 参数（最吵的一项）" },
			{ key: "pushNarration", label: "旁白", sub: "动手前的过场话推 💬（中间结论常在这里；不截断，超长自动分条发送）" }
		];
		/** 服务端现值 vs 本地待提交值：相等就不必提交（避免无谓重启）。 */
		const sameValue = (a, b) => String(a ?? "") === String(b ?? "");
		const hhmmss = (d) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");

		function Switch({ on, busy, onClick, label }) {
			return react.createElement("button", {
				type: "button",
				role: "switch",
				"aria-checked": on ? "true" : "false",
				"aria-busy": busy ? "true" : "false",
				"aria-label": label,
				className: "qqb-switch",
				"data-on": on ? "true" : "false",
				disabled: busy,
				onClick
			}, react.createElement("span", { className: "qqb-knob" }));
		}

		function Checkbox({ key, on, label, sub, onChange }) {
			return react.createElement("label", { className: "qqb-check", key },
				react.createElement("input", {
					type: "checkbox",
					checked: on,
					"aria-label": label,
					onChange: (e) => onChange(e.target.checked)
				}),
				react.createElement("span", { className: "qqb-checktext" },
					react.createElement("span", { className: "t" }, label),
					sub ? react.createElement("span", { className: "sub" }, sub) : null));
		}

		function QQBridgeSection() {
			const [cfg, setCfg] = react.useState(null);
			const [status, setStatus] = react.useState(null);
			const [notice, setNotice] = react.useState(null);
			// idle | pending | saving | saved | error
			const [saveState, setSaveState] = react.useState("idle");
			const [savedAt, setSavedAt] = react.useState(null);
			const pending = react.useRef(new Map()); // key → 待提交值
			const persisted = react.useRef({}); // 服务端已确认的值
			const timer = react.useRef(null);
			const inFlight = react.useRef(false);
			const retry = react.useRef(0); // 本轮改动已自动重试次数
			const retryTimer = react.useRef(null);

			const fetchSettings = react.useCallback(async () => {
				const res = await fetch("/dsh-qq-bridge/settings", { cache: "no-store" });
				const body = await res.json().catch(() => null);
				if (!body || body.ok !== true) throw new Error((body && body.error) || ("HTTP " + res.status));
				return body;
			}, []);

			const load = react.useCallback(async () => {
				try {
					const body = await fetchSettings();
					setCfg(body.settings || {});
					persisted.current = { ...(body.settings || {}) };
					pending.current.clear();
					if (timer.current !== null) {
						clearTimeout(timer.current);
						timer.current = null;
					}
					setSaveState("idle");
					setStatus(body.status || null);
					setNotice(null);
				} catch (e) {
					setNotice("加载失败: " + String(e));
				}
			}, [fetchSettings]);

			react.useEffect(() => {
				load();
			}, [load]);

			/** 提交待发送的改动；在飞时新来的改动会在本轮结束后续传。 */
			const flush = react.useCallback(async () => {
				if (inFlight.current) return;
				if (pending.current.size === 0) return;
				const patch = {};
				for (const [key, raw] of pending.current) {
					if (key === "chatTimeoutMs") {
						const ms = Number(raw);
						if (!Number.isFinite(ms) || ms <= 0) continue; // 非法超时不提交（输入框保留原文）
						patch[key] = ms;
						continue;
					}
					patch[key] = raw;
				}
				pending.current.clear();
				if (Object.keys(patch).length === 0) {
					setSaveState("idle");
					return;
				}
				inFlight.current = true;
				setSaveState("saving");
				let failed = false;
				try {
					const res = await fetch("/dsh-qq-bridge/settings", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(patch)
					});
					const body = await res.json().catch(() => null);
					if (!body || body.ok !== true) throw new Error((body && body.error) || ("HTTP " + res.status));
					if (Object.prototype.hasOwnProperty.call(patch, "appSecret")) {
						// 密文不回传浏览器：保存成功后清空输入框，只留 secretSet 标记。
						// 只在用户没有继续输入新密文时清空，避免吃掉正在敲的内容。
						setCfg((c) => (c && c.appSecret === patch.appSecret ? { ...c, appSecret: "", secretSet: true } : c));
						persisted.current.secretSet = true;
					}
					for (const [key, value] of Object.entries(patch)) persisted.current[key] = value;
					retry.current = 0;
					if (retryTimer.current !== null) {
						clearTimeout(retryTimer.current);
						retryTimer.current = null;
					}
					setSavedAt(new Date());
					setSaveState("saved");
					setNotice(null);
					// 只刷新状态行（不回填 cfg，免得覆盖正在编辑的输入框）
					fetchSettings()
						.then((body) => setStatus(body.status || null))
						.catch(() => {});
				} catch (e) {
					// 失败：改动放回队列；没有保存按钮了，所以自己按 2s / 5s 重试两次，
					// 仍失败就红字提示（改动仍留在队列里，继续编辑或失焦也会再次提交）。
					failed = true;
					for (const [key, value] of Object.entries(patch)) if (!pending.current.has(key)) pending.current.set(key, value);
					const attempt = retry.current;
					retry.current += 1;
					if (attempt < AUTOSAVE_RETRY_MS.length) {
						const wait = AUTOSAVE_RETRY_MS[attempt];
						setSaveState("pending");
						setNotice(`自动保存失败，${wait / 1000}s 后自动重试（第 ${attempt + 1}/${AUTOSAVE_RETRY_MS.length} 次）：${String(e)}`);
						retryTimer.current = setTimeout(() => {
							retryTimer.current = null;
							flush();
						}, wait);
					} else {
						setSaveState("error");
						setNotice(`自动保存失败（已自动重试 ${AUTOSAVE_RETRY_MS.length} 次）：${String(e)}；改动仍保留，继续编辑或让输入框失焦会再次提交。`);
					}
				} finally {
					inFlight.current = false;
					if (!failed && pending.current.size > 0) flush(); // 保存期间又改了 → 续传
				}
			}, [fetchSettings]);

			/** 提交所有待发送改动（失焦 / 回车 / 防抖到点）。 */
			const commitNow = react.useCallback(() => {
				if (timer.current !== null) {
					clearTimeout(timer.current);
					timer.current = null;
				}
				flush();
			}, [flush]);

			/** 记录一次改动：值等于服务端现值就当没改，否则入队并按 commit 语义提交。 */
			const set = (key, value, mode) => {
				setCfg((c) => (c ? { ...c, [key]: value } : c));
				if (key !== "appSecret" && sameValue(persisted.current[key], value)) pending.current.delete(key);
				else pending.current.set(key, value);
				retry.current = 0; // 用户又动了 → 重试预算重置
				setSaveState(pending.current.size > 0 ? "pending" : "idle");
				if (mode === "blur") return; // 密文：等失焦 / 回车（提交由 commitNow 触发）
				if (timer.current !== null) {
					clearTimeout(timer.current);
					timer.current = null;
				}
				if (mode === "now") {
					flush();
					return;
				}
				timer.current = setTimeout(() => {
					timer.current = null;
					flush();
				}, AUTOSAVE_DEBOUNCE_MS);
			};

			// 分区被卸载（切走设置页 / 客户端半热更）时，把未提交的改动送出去
			react.useEffect(() => () => {
				if (timer.current !== null) {
					clearTimeout(timer.current);
					timer.current = null;
				}
				if (retryTimer.current !== null) {
					clearTimeout(retryTimer.current);
					retryTimer.current = null;
				}
				if (pending.current.size > 0) flush();
			}, [flush]);

			const running = !!(status && status.running);
			const connected = !!(status && status.connected);
			const statusDot = connected ? "ok" : running ? "warn" : "off";
			const statusText = !status
				? "状态未知"
				: connected
					? "已连接 ✓"
					: running
						? "连接中…"
						: "未启用";
			const saveText = saveState === "saving"
				? "保存中…"
				: saveState === "pending"
					? "待保存…"
					: saveState === "error"
						? "保存失败（改动已保留）"
						: savedAt
							? "已自动保存 " + hhmmss(savedAt)
							: "改动即自动保存";

			return react.createElement("div", { className: "qqb-section" },
				react.createElement("div", { className: "qqb-head" },
					react.createElement("h3", null, "QQ 桥接"),
					react.createElement("span", null, "QQ ↔ DSH 单插件桥接")),
				react.createElement("div", { className: "qqb-card" },
					FIELDS.map((f) => {
						const value = cfg ? cfg[f.key] : undefined;
						const sub = f.key === "appSecret"
							? (cfg && cfg.secretSet ? "已配置（留空保持不变；改完失焦即自动保存）" : "尚未配置（填完失焦或回车即自动保存）")
							: f.sub;
						if (f.type === "switch") {
							return react.createElement("div", { className: "qqb-row", key: f.key },
								react.createElement("div", { className: "k" },
									FIELD_LABELS[f.key],
									react.createElement("div", { className: "sub" }, sub)),
								Switch({ on: !!value, busy: false, label: FIELD_LABELS[f.key], onClick: () => set(f.key, !value, f.commit) }));
						}
						return react.createElement("div", { className: "qqb-row", key: f.key },
							react.createElement("div", { className: "k" },
								FIELD_LABELS[f.key],
								sub ? react.createElement("div", { className: "sub" }, sub) : null),
							react.createElement("input", {
								className: "qqb-input",
								type: f.type === "secret" ? "password" : f.type,
								value: value == null ? "" : String(value),
								placeholder: f.placeholder,
								spellCheck: false,
								onChange: (e) => set(f.key, e.target.value, f.commit),
								onBlur: commitNow,
								onKeyDown: (e) => {
									if (e.key === "Enter") commitNow();
								}
							}));
					}),
					react.createElement("div", { className: "qqb-group" },
						react.createElement("div", { className: "qqb-grouphead" },
							"消息推送内容",
							react.createElement("span", { className: "sub" }, "勾选哪些过程消息推到 QQ（只推给你当前接入的那个会话；最终回复始终推）")),
						PUSH_FIELDS.map((f) => Checkbox({
							key: f.key,
							on: cfg ? cfg[f.key] !== false : true,
							label: f.label,
							sub: f.sub,
							onChange: (next) => set(f.key, next, "now")
						}))),
					react.createElement("div", { className: "qqb-actions" },
						react.createElement("span", { className: "qqb-status" },
							react.createElement("span", { className: "dot " + statusDot }),
							statusText,
							status && status.url ? "  ·  " + status.url : ""),
						react.createElement("span", { className: "qqb-save" }, saveText))),
				notice !== null ? react.createElement("div", { className: "qqb-notice" }, notice) : null,
				react.createElement("div", { className: "qqb-hint" }, "所有改动即时生效并自动保存，没有保存按钮；失败会自动重试两次并红字提示。文件本体不会自动发到 QQ —— 只有你明确要某个文件时才发。等待期间 QQ 显示「正在输入…」；只回最终文本；QQ 会话审批由 QQ 用户 /approve /deny 决定。"));
		}
		//#endregion

		//#region plugin
		const inject = ["slots"];
		function apply(ctx) {
			ctx.inject(["slots"], (scope) => {
				scope.slots.inject("settings.section", () => scope.slots.register({
					name: "settings.section",
					id: "qq-bridge",
					order: 80,
					label: () => "QQ 桥接"
				}, (props) => react.createElement(QQBridgeSection, props)));
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

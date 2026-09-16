/**
 * dsh-qq-bridge — client half (browser plugin).
 *
 * Registers a "QQ 桥接" settings section (`settings.section`). All data goes
 * through same-origin host routes:
 *   GET  /dsh-qq-bridge/settings  → { ok, settings, status }
 *   POST /dsh-qq-bridge/settings  → { ... } (updates the qq-bridge namespace)
 *
 * The section renders the QQ bot credentials (appId/appSecret), environment
 * toggles (enabled / sandbox), chat timeout and new-session cwd, plus a live
 * connection status line. Saving calls settings.update on the host, which
 * starts/stops/restarts the QQ client through settings/updated.
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
			".qqb-btn{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 14px;font-size:13px;cursor:pointer;line-height:18px}",
			".qqb-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".qqb-btn.primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted)}",
			".qqb-status{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:0 2px;font-variant-numeric:tabular-nums}",
			".qqb-status .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}",
			".qqb-status .ok{background:var(--dsw-alias-state-success-primary)}",
			".qqb-status .warn{background:var(--dsw-alias-state-warn-primary)}",
			".qqb-status .off{background:var(--dsw-alias-label-tertiary)}",
			".qqb-notice{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px;padding:0 2px}",
			".qqb-hint{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;padding:0 2px}"
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
			compact: "精简回复模式",
			createCwd: "新建会话工作区"
		};
		const FIELDS = [
			{ key: "enabled", type: "switch", sub: "打开即连接 QQ；关闭即断开" },
			{ key: "appId", type: "text", placeholder: "QQ 开放平台机器人 AppID" },
			{ key: "appSecret", type: "secret", placeholder: "机器人 AppSecret（密文）" },
			{ key: "sandbox", type: "switch", sub: "勾选走沙箱环境 sandbox.api.sgroup.qq.com" },
			{ key: "chatTimeoutMs", type: "number", sub: "默认 300000（5 分钟）" },
			{ key: "steer", type: "switch", sub: "开：工作期间的消息直接插话进当前会话（打断当前步骤）；关：排队，等当前工作结束后再处理" },
			{ key: "compact", type: "switch", sub: "开：只回最终结果；关：每条工具调用实时推送（0.6s 间隔防频控，每日 1000 条额度）" },
			{ key: "createCwd", type: "text", placeholder: "如 D:\\DSH\\design（留空用 DSH 默认）" }
		];

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

		function QQBridgeSection() {
			const [cfg, setCfg] = react.useState(null);
			const [status, setStatus] = react.useState(null);
			const [notice, setNotice] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [dirty, setDirty] = react.useState(false);

			const load = react.useCallback(async () => {
				try {
					const res = await fetch("/dsh-qq-bridge/settings", { cache: "no-store" });
					const body = await res.json().catch(() => null);
					if (!body || body.ok !== true) throw new Error((body && body.error) || ("HTTP " + res.status));
					setCfg(body.settings || {});
					setStatus(body.status || null);
					setDirty(false);
				} catch (e) {
					setNotice("加载失败: " + String(e));
				}
			}, []);

			react.useEffect(() => {
				load();
			}, [load]);

			const set = (key, value) => {
				setCfg((c) => (c ? { ...c, [key]: value } : c));
				setDirty(true);
			};

			const save = async () => {
				if (!cfg || busy) return;
				setBusy(true);
				setNotice(null);
				try {
					const res = await fetch("/dsh-qq-bridge/settings", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(cfg)
					});
					const body = await res.json().catch(() => null);
					if (!body || body.ok !== true) throw new Error((body && body.error) || ("HTTP " + res.status));
					setNotice("已保存。" + (cfg.enabled ? "桥接已按新配置启动/重启。" : "尚未启用，打开「启用桥接」即可连接。"));
					await load();
				} catch (e) {
					setNotice("保存失败: " + String(e));
				} finally {
					setBusy(false);
				}
			};

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

			return react.createElement("div", { className: "qqb-section" },
				react.createElement("div", { className: "qqb-head" },
					react.createElement("h3", null, "QQ 桥接"),
					react.createElement("span", null, "QQ ↔ DSH 单插件桥接")),
				react.createElement("div", { className: "qqb-card" },
					FIELDS.map((f) => {
						const value = cfg ? cfg[f.key] : undefined;
						if (f.type === "switch") {
							return react.createElement("div", { className: "qqb-row", key: f.key },
								react.createElement("div", { className: "k" },
									FIELD_LABELS[f.key],
									react.createElement("div", { className: "sub" }, f.sub)),
								Switch({ on: !!value, busy, label: FIELD_LABELS[f.key], onClick: () => set(f.key, !value) }));
						}
						return react.createElement("div", { className: "qqb-row", key: f.key },
							react.createElement("div", { className: "k" },
								FIELD_LABELS[f.key],
								f.sub ? react.createElement("div", { className: "sub" }, f.sub) : null),
							react.createElement("input", {
								className: "qqb-input",
								type: f.type === "secret" ? "password" : f.type,
								value: value == null ? "" : String(value),
								placeholder: f.placeholder,
								disabled: busy,
								spellCheck: false,
								onChange: (e) => set(f.key, f.type === "number" ? (Number(e.target.value) || 0) : e.target.value)
							}));
					}),
					react.createElement("div", { className: "qqb-actions" },
						react.createElement("button", { type: "button", className: "qqb-btn primary", disabled: busy || !dirty, onClick: save }, "保存"),
						react.createElement("span", { className: "qqb-status" },
							react.createElement("span", { className: "dot " + statusDot }),
							statusText,
							status && status.url ? "  ·  " + status.url : ""))),
				notice !== null ? react.createElement("div", { className: "qqb-notice" }, notice) : null,
				react.createElement("div", { className: "qqb-hint" }, "等待期间 QQ 显示「正在输入…」；只回最终文本；QQ 会话审批由 QQ 用户 /approve /deny 决定。"));
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

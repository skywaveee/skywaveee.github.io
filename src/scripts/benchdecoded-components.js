// BenchDecoded interactive components: <file-tree> and <eval-flow>.
// Data channel: [...slug].astro inlines per-bench JSON as
// <script type="application/json" id="bench-data-<slug>-tree">, which these
// custom elements read on upgrade. Zero dependencies, light DOM, light theme
// aware via CSS (styles in benchdecoded.css).

const esc = (s) =>
	String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

const fmtSize = (n) => {
	if (n == null) return '';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

const ROLES = {
	input: { label: '模型输入', cls: 'r-input' },
	prompt: { label: '题面', cls: 'r-prompt' },
	contract: { label: '输出契约', cls: 'r-contract' },
	scorer: { label: '评分器', cls: 'r-scorer' },
	reference: { label: '参考答案', cls: 'r-reference' },
	output: { label: '真实输出', cls: 'r-output' },
	run: { label: '运行现场', cls: 'r-run' },
	infra: { label: '基础设施', cls: 'r-infra' },
};

function payload(bench) {
	const el = document.getElementById(`bench-data-${bench}-tree`);
	if (!el) return null;
	try {
		return JSON.parse(el.textContent);
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------------ *
 * Mini syntax highlighter — regex tokenizer, escaped output.
 * Priority per language: comment > string > keyword/key > number.
 * Anything unmatched or too large falls back to a plain escaped <pre>.
 * ------------------------------------------------------------------ */

const HL_MAX = 40 * 1024;

const PY_KW =
	'def|class|return|if|elif|else|for|while|in|not|and|or|import|from|as|with|try|except|finally|raise|yield|lambda|pass|break|continue|global|assert|del|is|None|True|False';
const SH_KW = 'if|then|else|elif|fi|for|while|do|done|case|esac|set|export|local|return|in';

const RULES = {
	python: [
		[/#.*/g, 'tok-cmt'],
		[/("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/g, 'tok-str'],
		[new RegExp(`\\b(?:${PY_KW})\\b`, 'g'), 'tok-kw'],
		[/\b\d[\d._]*(?:e[+-]?\d+)?j?\b/gi, 'tok-num'],
		[/@[A-Za-z_][\w.]*/g, 'tok-fn'],
		[/\b[A-Za-z_]\w*(?=\()/g, 'tok-fn'],
	],
	yaml: [
		[/#.*/g, 'tok-cmt'],
		[/"[^"\n]*"|'[^'\n]*'/g, 'tok-str'],
		[/^[ \t*-]*[\w.-]+(?=[ \t]*:)/gm, 'tok-key'],
		[/\b(?:true|false|null)\b/gi, 'tok-kw'],
		[/\b\d[\d.eE+-]*\b/g, 'tok-num'],
	],
	toml: [
		[/#.*/g, 'tok-cmt'],
		[/"[^"\n]*"|'[^'\n]*'/g, 'tok-str'],
		[/^\s*\[[^\]\n]+\]/gm, 'tok-key'],
		[/^[\w.-]+(?=\s*[=])/gm, 'tok-key'],
		[/\b(?:true|false)\b/gi, 'tok-kw'],
		[/\b\d[\d._]*(?:e[+-]?\d+)?\b/gi, 'tok-num'],
	],
	json: [
		[/"(?:\\.|[^"\\])*"/g, 'tok-str'],
	],
	sh: [
		[/#.*/g, 'tok-cmt'],
		[/"[^"\n]*"|'[^'\n]*'/g, 'tok-str'],
		[new RegExp(`\\b(?:${SH_KW})\\b`, 'g'), 'tok-kw'],
		[/\$\{?\w+\}?/g, 'tok-var'],
		[/\b\d+\b/g, 'tok-num'],
	],
	markdown: [
		[/^#{1,6}[^\n]*/gm, 'tok-key'],
		[/`[^`\n]+`/g, 'tok-str'],
		[/\*\*[^*\n]+\*\*/g, 'tok-kw'],
		[/\[[^\]\n]*\]\([^)\n]*\)/g, 'tok-fn'],
	],
};
RULES.md = RULES.markdown;
RULES.jinja = RULES.markdown;

function highlight(src, lang) {
	if (src == null) return '';
	if (!lang || src.length > HL_MAX) return esc(src);
	const rules = RULES[lang];
	if (!rules) return esc(src);
	// Merge matches from all rules (earlier rules win on overlap), then sort.
	const hits = [];
	for (const [re, cls] of rules) {
		const r = new RegExp(re.source, re.flags);
		let m;
		while ((m = r.exec(src)) && hits.length < 20000) {
			hits.push({ s: m.index, e: m.index + m[0].length, cls });
			if (m[0].length === 0) r.lastIndex++;
		}
	}
	hits.sort((a, b) => a.s - b.s || a.cls.localeCompare(b.cls));
	let out = '';
	let pos = 0;
	for (const h of hits) {
		if (h.s < pos) continue; // overlapped by an earlier (higher-priority) token
		out += esc(src.slice(pos, h.s));
		out += `<span class="${h.cls}">${esc(src.slice(h.s, h.e))}</span>`;
		pos = h.e;
	}
	out += esc(src.slice(pos));
	return out;
}

/* ------------------------------------------------------------------ *
 * <file-tree bench="…"> — VSCode-style explorer: left tree, right preview.
 * ------------------------------------------------------------------ */

class FileTree extends HTMLElement {
	static get observedAttributes() {
		return ['bench'];
	}

	connectedCallback() {
		this.data = payload(this.getAttribute('bench'));
		this.groupIdx = 0;
		this.expanded = new Set();
		this.selected = null;
		this.variant = null;
		this.wrap = false; // 默认横向滚动；「自动换行」按钮可切换（修过 bug：pre 内层 code 的 white-space 会盖过 wrap 类）
		// Deep link: #ft-<group.id>/path/to/file opens that file preselected.
		const want = location.hash.startsWith('#ft-')
			? decodeURIComponent(location.hash.slice(4))
			: null;
		if (want) {
			const gi = this.data?.groups?.findIndex((g) => want.startsWith(`${g.id}/`));
			if (gi >= 0) {
				this.groupIdx = gi;
				this.initialPath = want;
			}
		}
		this.render();
	}

	group() {
		return this.data?.groups?.[this.groupIdx];
	}

	// path = group.id + '/' + names joined by '/'
	walk(nodes, prefix, out) {
		for (const n of nodes || []) {
			const p = `${prefix}/${n.name}`;
			out.set(p, n);
			if (n.children) this.walk(n.children, p, out);
		}
		return out;
	}

	select(path, { scroll = true } = {}) {
		this.selected = path;
		this.variant = null;
		// Make sure ancestors are expanded.
		const parts = path.split('/');
		for (let i = 2; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join('/'));
		this.renderTree();
		this.renderPreview();
		if (scroll) this.querySelector('.ft-view')?.scrollIntoView({ block: 'nearest' });
	}

	render() {
		if (!this.data) {
			this.innerHTML = `<p class="ft-empty">（此组件的数据未随页面加载：tree.json 缺失）</p>`;
			return;
		}
		this.innerHTML = `
			<div class="ft-head">
				<div class="ft-chips" role="tablist" aria-label="资产组"></div>
				<div class="ft-title"></div>
			</div>
			<div class="ft-body">
				<div class="ft-tree" role="tree" tabindex="0" aria-label="文件树"></div>
				<div class="ft-view" aria-live="polite"></div>
			</div>`;
		this.querySelector('.ft-chips').addEventListener('click', (e) => {
			const btn = e.target.closest('button[data-g]');
			if (!btn) return;
			this.groupIdx = Number(btn.dataset.g);
			this.expanded = new Set();
			this.selected = null;
			this.render();
		});
		this.querySelector('.ft-tree').addEventListener('keydown', (e) => this.onKey(e));
		this.renderChips();
		const g = this.group();
		// Seed the expanded set with dirs flagged default_open (toggling still works:
		// an explicit delete from the set closes them).
		const seed = (nodes, prefix) => {
			for (const n of nodes || []) {
				const p = `${prefix}/${n.name}`;
				if (n.type !== 'dir') continue;
				if (n.default_open) this.expanded.add(p);
				seed(n.children, p);
			}
		};
		seed(g.children, g.id);
		const init = this.initialPath || g.initial_select || this.firstFile(g.children, g.id);
		this.initialPath = null;
		if (init) this.select(init, { scroll: false });
		else {
			this.renderTree();
			this.renderPreview();
		}
	}

	firstFile(nodes, prefix) {
		for (const n of nodes || []) {
			const p = `${prefix}/${n.name}`;
			if (n.type === 'file' && (n.content || n.variants)) return p;
			if (n.children) {
				this.expanded.add(p);
				const f = this.firstFile(n.children, p);
				if (f) return f;
			}
		}
		return null;
	}

	renderChips() {
		const chips = this.querySelector('.ft-chips');
		chips.innerHTML = this.data.groups
			.map(
				(g, i) =>
					`<button role="tab" data-g="${i}" aria-selected="${i === this.groupIdx}" class="${i === this.groupIdx ? 'on' : ''}">${esc(g.label)}</button>`,
			)
			.join('');
		this.querySelector('.ft-title').textContent = this.group().note || '';
	}

	renderTree() {
		const g = this.group();
		const tree = this.querySelector('.ft-tree');
		let html = this.treeNodes(g.children, g.id, 0);
		// Group-level overview (e.g. the per-task universal skeleton) renders
		// below the tree rows, inside the same scroll area.
		if (g.overview?.length) {
			html += `<div class="ft-overview"><div class="ft-ov-title">${esc(g.overview_title || '通用骨架')}</div>${g.overview
				.map(
					(r) =>
						`<div class="ft-ov-row"><code>${esc(r.name)}</code><span>${esc(r.desc)}</span></div>`,
				)
				.join('')}</div>`;
		}
		tree.innerHTML = html;
		tree.querySelectorAll('button[data-dir]').forEach((b) =>
			b.addEventListener('click', () => {
				const p = b.dataset.dir;
				this.expanded.has(p) ? this.expanded.delete(p) : this.expanded.add(p);
				b.setAttribute('aria-expanded', this.expanded.has(p) ? 'true' : 'false');
				this.renderTree();
			}),
		);
		tree.querySelectorAll('button[data-file]').forEach((b) =>
			b.addEventListener('click', () => this.select(b.dataset.file)),
		);
	}

	treeNodes(nodes, prefix, depth) {
		let out = '';
		for (const n of nodes || []) {
			const p = `${prefix}/${n.name}`;
			const pad = 8 + depth * 14;
			if (n.type === 'dir') {
				const open = this.expanded.has(p);
				out += `<button role="treeitem" data-dir="${esc(p)}" aria-expanded="${open}" class="ft-row ft-dir" style="padding-left:${pad}px">
					<span class="ft-chev${open ? ' open' : ''}"></span><span class="ft-name">${esc(n.name)}/</span>
				</button>`;
				if (open && n.children) out += this.treeNodes(n.children, p, depth + 1);
			} else {
				const r = ROLES[n.role] || ROLES.infra;
				const sel = this.selected === p;
				out += `<button role="treeitem" data-file="${esc(p)}" aria-selected="${sel}" class="ft-row ft-file${sel ? ' sel' : ''}" style="padding-left:${pad + 16}px">
					<span class="ft-dot ${r.cls}"></span><span class="ft-name">${esc(n.name)}</span>
					${n.size_bytes ? `<span class="ft-size">${fmtSize(n.size_bytes)}</span>` : ''}
				</button>`;
			}
		}
		return out;
	}

	renderPreview() {
		const view = this.querySelector('.ft-view');
		if (!this.selected) {
			view.innerHTML = `<p class="ft-empty">在左侧选择一个文件查看内容。</p>`;
			return;
		}
		const node = this.walk(this.group().children, this.group().id, new Map()).get(this.selected);
		if (!node) {
			view.innerHTML = `<p class="ft-empty">（文件不存在）</p>`;
			return;
		}
		const r = ROLES[node.role] || ROLES.infra;
		const g = this.group();
		let tabs = '';
		let active = node;
		let vId = null;
		if (node.variants?.length) {
			vId = this.variant && node.variants.some((v) => v.id === this.variant) ? this.variant : node.variants[0].id;
			active = { ...node, ...node.variants.find((v) => v.id === vId) };
			tabs = `<div class="ft-tabs" role="tablist">${node.variants
				.map((v) => `<button data-v="${esc(v.id)}" class="${v.id === vId ? 'on' : ''}" role="tab" aria-selected="${v.id === vId}">${esc(v.label)}</button>`)
				.join('')}</div>`;
		}
		const body =
			active.content != null
				? `<pre class="ft-pre${this.wrap ? ' wrap' : ''}"><code>${highlight(active.content, active.lang)}</code></pre>`
				: `<div class="ft-nofile"><p>此文件不内联到页面（${node.size_bytes ? fmtSize(node.size_bytes) : '大文件/二进制'}）。</p>${
						g.origin?.url ? `<p><a href="${esc(g.origin.url)}" target="_blank" rel="noopener">在 ${esc(g.origin.label)} 查看完整内容 ↗</a></p>` : ''
					}</div>`;
		const wrapBtn =
			active.content != null
				? `<button class="ft-wrapbtn${this.wrap ? ' on' : ''}" aria-pressed="${this.wrap}" title="长行自动换行（关闭时横向滚动）">自动换行</button>`
				: '';
		view.innerHTML = `
			<div class="ft-path">${esc(this.selected.replace(/^\//, ''))}</div>
			<div class="ft-meta">
				<span class="ft-badge ${r.cls}">${r.label}</span>
				${node.size_bytes ? `<span class="ft-badge-size">${fmtSize(node.size_bytes)}</span>` : ''}
				${node.truncated ? `<span class="ft-badge-trunc" title="${esc(node.excerpt_note || '')}">截断 · ${esc(node.excerpt_note || '')}</span>` : ''}
				${g.origin?.url ? `<a class="ft-origin" href="${esc(g.origin.url)}" target="_blank" rel="noopener">${esc(g.origin.label)} ↗</a>` : ''}
				${wrapBtn}
			</div>
			${node.note ? `<p class="ft-note">${esc(node.note)}</p>` : ''}
			${tabs}
			${body}`;
		view.querySelectorAll('.ft-tabs button').forEach((b) =>
			b.addEventListener('click', () => {
				this.variant = b.dataset.v;
				this.renderPreview();
			}),
		);
		view.querySelector('.ft-wrapbtn')?.addEventListener('click', () => {
			this.wrap = !this.wrap;
			this.renderPreview();
		});
	}

	onKey(e) {
		const items = [...this.querySelectorAll('.ft-tree button')];
		const idx = items.indexOf(document.activeElement);
		const move = (i) => {
			e.preventDefault();
			items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
		};
		if (e.key === 'ArrowDown') move(idx + 1);
		else if (e.key === 'ArrowUp') move(idx - 1);
		else if (e.key === 'Home') {
			e.preventDefault();
			items[0]?.focus();
		} else if (e.key === 'End') {
			e.preventDefault();
			items[items.length - 1]?.focus();
		}
	}
}

/* ------------------------------------------------------------------ *
 * <eval-flow bench="…"> — interactive stepper over the scoring chain.
 * ------------------------------------------------------------------ */

class EvalFlow extends HTMLElement {
	connectedCallback() {
		this.data = payload(this.getAttribute('bench'))?.eval_flow;
		this.level = this.data?.levels?.[0]?.id ?? null;
		this.stepIdx = 0;
		// Deep link: #ef-<stepId> opens on that step (e.g. #ef-iterate).
		const want = location.hash.startsWith('#ef-') ? location.hash.slice(4) : null;
		const idx = want ? this.data?.steps?.findIndex((s) => s.id === want) : -1;
		if (idx > 0) this.stepIdx = idx;
		this.wrap = false;
		this.render();
	}

	merge(panel) {
		if (!panel.level_variants) return panel;
		const ov = panel.level_variants[this.level];
		return ov ? { ...panel, ...ov } : panel;
	}

	render() {
		if (!this.data) {
			this.innerHTML = `<p class="ft-empty">（此组件的数据未随页面加载：tree.json 缺失）</p>`;
			return;
		}
		const levels = this.data.levels
			? `<div class="ef-levels" role="tablist" aria-label="题面档位">${this.data.levels
					.map((l) => `<button data-l="${esc(l.id)}" class="${l.id === this.level ? 'on' : ''}" role="tab" aria-selected="${l.id === this.level}">${esc(l.label)}</button>`)
					.join('')}</div>`
			: '';
		this.innerHTML = `
			<div class="ef-root">
				<div class="ef-run">${esc(this.data.run_label || '')}</div>
				${levels}
				<div class="ef-steps">${this.data.steps
					.map(
						(s, i) => `<button data-s="${i}" class="${i === this.stepIdx ? 'on' : ''}" aria-current="${i === this.stepIdx ? 'step' : 'false'}">
							<strong>${esc(s.title)}</strong><span>${esc(s.subtitle || '')}</span></button>`,
					)
					.join('')}</div>
				<div class="ef-panels"></div>
			</div>`;
		this.querySelectorAll('.ef-levels button').forEach((b) =>
			b.addEventListener('click', () => {
				this.level = b.dataset.l;
				this.render();
			}),
		);
		this.querySelectorAll('.ef-steps button').forEach((b) =>
			b.addEventListener('click', () => {
				this.stepIdx = Number(b.dataset.s);
				this.render();
			}),
		);
		const step = this.data.steps[this.stepIdx];
		this.querySelector('.ef-panels').innerHTML = (step.panels || []).map((p) => this.renderPanel(this.merge(p))).join('');
		this.querySelector('.ef-panels').addEventListener('click', (e) => {
			if (!e.target.closest('.ft-wrapbtn')) return;
			this.wrap = !this.wrap;
			this.render();
		});
	}

	renderPanel(p) {
		switch (p.type) {
			case 'code': {
				const trunc = p.truncated
					? `<span class="ft-badge-trunc">截断 · ${esc(p.excerpt_note || '')}</span>`
					: '';
				const wrapBtn =
					p.content != null
						? `<button class="ft-wrapbtn${this.wrap ? ' on' : ''}" aria-pressed="${this.wrap}" title="长行自动换行（关闭时横向滚动）">自动换行</button>`
						: '';
				return `<div class="ef-panel"><div class="ef-phead">${esc(p.heading || '')}${trunc}${wrapBtn}</div>
					<pre class="ft-pre${this.wrap ? ' wrap' : ''}"><code>${highlight(p.content, p.lang)}</code></pre></div>`;
			}
			case 'kv':
				return `<div class="ef-panel ef-kv"><dl>${p.rows
					.map(([k, v]) => `<div><dt><code>${esc(k)}</code></dt><dd>${esc(v)}</dd></div>`)
					.join('')}</dl></div>`;
			case 'weights': {
				const total = p.items.reduce((a, b) => a + b.weight, 0) || 1;
				return `<div class="ef-panel ef-weights">${p.items
					.map(
						(i, n) =>
							`<div class="w-seg w${n}" style="flex:${i.weight / total}" title="${esc(i.name)} ${i.weight}"><span>${esc(i.name)}</span><b>${Math.round(i.weight * 100)}%</b></div>`,
					)
					.join('')}</div>${p.note ? `<p class="ft-note">${esc(p.note)}</p>` : ''}`;
			}
			case 'anchors':
				return `<div class="ef-panel ef-anchors">${p.anchors
					.map(
						(a) =>
							`<div class="anchor-card"><code>RMSE ${a.rmse}</code><strong>${a.score}</strong><span>${esc(a.label)}</span></div>`,
					)
					.join('<div class="anchor-arrow">→</div>')}</div>${p.note ? `<p class="ft-note">${esc(p.note)}</p>` : ''}`;
			case 'score': {
				const val = p.value != null ? p.value : '—';
				const compare = (p.compare || [])
					.map((c) => `<span class="cmp">${esc(c.label)}${c.value != null ? ` <b>${c.value}</b>` : ''}${c.note ? ` <i>${esc(c.note)}</i>` : ''}</span>`)
					.join('');
				return `<div class="ef-panel ef-score"><div class="big">${val}<small>${esc(p.unit || '')}</small></div>
					${p.note ? `<p class="ft-note">${esc(p.note)}</p>` : ''}${compare ? `<div class="cmps">${compare}</div>` : ''}</div>`;
			}
			case 'callout':
				return `<div class="ef-panel ef-callout">${esc(p.body)}</div>`;
			default:
				return p.body
					? `<div class="ef-panel"><h4>${esc(p.heading || '')}</h4>${p.body.map((t) => `<p>${esc(t)}</p>`).join('')}</div>`
					: '';
		}
	}
}

customElements.define('file-tree', FileTree);
customElements.define('eval-flow', EvalFlow);

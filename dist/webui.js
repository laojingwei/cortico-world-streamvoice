/**
 * 世界页的三个页签：`流式语音播报`（运行状态）、`Edge 语音`、`API 语音`。
 *
 * 手写的 ESM，不 import 任何东西：服务端按 `cortico.webUiClient` 找到这个文件，浏览器直接
 * `import()` 它，所以要自带默认导出 `{ panels: { …: { mount } } }`。键就是 panel id。
 *
 * 外观全部走宿主给的 `ctx.ui` 原语（卡片 `.sheet`、按钮 `.btn`、控件 `.field`、`.msgline`），
 * 这样深色/浅色主题、字号、圆角都跟控制台其他页一致；`ctx.ui` 不在时退回同样版式的裸 DOM。
 *
 * 为什么拆成三页：两套引擎的参数以前并排摆在同一个「配置」页里，谁也说不清哪一组此刻生效。
 * 现在每套引擎自己一页、页内只有一个「启用」开关——想用哪边就点哪边，开关互相联动。
 * 「配置」页签（框架画的）只剩念什么、切块、高级这些跟引擎无关的项。
 *
 * 字段是从后端拿的（`invoke('fields')`）：标题、说明、取值范围、下拉候选全由 `config.ts` 给，
 * 这一层只负责按 `type` 摆控件，不认识任何一个字段名——以后加一个参数不用动这里。
 */

const TEXT = {
  zh: {
    statusTitle: '运行状态',
    statusDesc: '参数在「Edge 语音」「API 语音」两页里调，这里是它此刻在做什么。',
    on: '在说',
    idle: '待命',
    off: '已关',
    engine: '当前引擎',
    voice: '当前嗓音',
    chunks: '切块',
    first: '第一块出声',
    round: '本轮',
    queued: '排队',
    spoken: '已说',
    failed: '失败',
    total: '总耗时',
    quiet: '立即静音',
    quietDone: '已清空队列',
    never: '还没念过',
    optionsOn: '念选项开',
    optionsOff: '念选项关',
    save: '保存',
    saving: '保存中…',
    saved: '已保存',
    try: '试听这句',
    trying: '合成中…（冷启动要两三秒）',
    sample: '试听文本',
    sampleText: '你好，这是现在的音色、语速和音调——听得清楚吗？',
    test: '连接测试',
    testing: '连接中…',
    testOk: (ms, voices, models) => {
      const bits = [];
      if (voices) bits.push(`${voices} 个音色`);
      if (models) bits.push(`${models} 个模型`);
      return `通 · ${ms}ms${bits.length ? ` · ${bits.join('、')}` : ''}`;
    },
    testNoList: '通，但服务没给音色/模型清单（这两个接口它可能没实现），照旧手填。',
    modelNone: '（不发送）',
    cached: (ago) => `音色与模型用的是 ${ago}探测到的清单，直接选就行；想刷新就点一次「连接测试」。`,
    clearKey: '清除令牌',
    customTag: '自定义',
    switchOn: (name) => `已启用：${name}`,
    switchOff: '两个引擎至少留一个启用：想换另一个，去那一页把它的开关打开就行。',
    otherTab: (name) => `想换另一套引擎？去「${name}」页把它的开关打开，这一页的会自动关上。`,
    engineMoved: '引擎刚在另一页被切换了：这一页看到的参数已不生效，刷新一下页面就好。',
    staleSession: '和 Core 的连接失效了（刚重启过？），刷新一下这个页面就好。',
    loadFail: '字段没加载出来（Core 刚重启？），刷新这个页面再试。',
    ok: '可以用',
  },
  en: {
    statusTitle: 'Status',
    statusDesc: 'Tune parameters on the "Edge voice" / "API voice" tabs; this page shows what it is doing right now.',
    on: 'speaking',
    idle: 'ready',
    off: 'off',
    engine: 'engine',
    voice: 'voice',
    chunks: 'chunks',
    first: 'first sound',
    round: 'this round',
    queued: 'queued',
    spoken: 'said',
    failed: 'failed',
    total: 'total',
    quiet: 'Mute now',
    quietDone: 'queue cleared',
    never: 'nothing said yet',
    optionsOn: 'reads choices',
    optionsOff: 'choices silent',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved',
    try: 'Play sample',
    trying: 'Synthesising… (a cold start takes 2–3s)',
    sample: 'Sample',
    sampleText: 'Hello, this is the current voice, rate and pitch.',
    test: 'Test connection',
    testing: 'Connecting…',
    testOk: (ms, voices, models) => {
      const bits = [];
      if (voices) bits.push(`${voices} voices`);
      if (models) bits.push(`${models} models`);
      return `reachable · ${ms}ms${bits.length ? ` · ${bits.join(', ')}` : ''}`;
    },
    testNoList: 'Reachable, but the service returned no voice/model list (it may not implement those endpoints).',
    modelNone: '(not sent)',
    cached: (ago) => `Voices and models come from the list found ${ago} ago — pick from it, or press Test connection to refresh.`,
    clearKey: 'Clear token',
    customTag: 'custom',
    switchOn: (name) => `Enabled: ${name}`,
    switchOff: 'Keep one engine on: open the other tab and enable it there.',
    otherTab: (name) => `Want the other engine? Enable it on the "${name}" tab — this one switches off.`,
    engineMoved: 'The engine was just switched on another tab, so what you see here is inactive. Reload the page.',
    staleSession: 'The connection to Core went stale (restart?). Reload this page.',
    loadFail: 'Could not load the fields (Core just restarted?). Reload this page.',
    ok: 'works',
  },
};

const pick = (language) => (language === 'zh' || language === 'zh-Hant' ? TEXT.zh : TEXT.en);

/** 控制台是深色还是浅色：拿 body 背景的亮度判断，用在原生下拉的 `color-scheme` 上。 */
const themeScheme = () => {
  try {
    const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    if (!bg || bg.length < 3) return 'dark';
    const [r, g, b] = bg.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 120 ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
};
const fmt = (ms) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
/** 「3 分钟前」这种人话，给探测缓存用。 */
const agoOf = (ms, en) => {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return en ? 'seconds' : '刚刚';
  if (min < 60) return en ? `${min} minutes` : `${min} 分钟前`;
  const hour = Math.round(min / 60);
  if (hour < 24) return en ? `${hour} hours` : `${hour} 小时前`;
  const day = Math.round(hour / 24);
  return en ? `${day} days` : `${day} 天前`;
};
const errText = (err) => String(err && err.message ? err.message : err);

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

/**
 * 宿主没给 `ctx.ui` 时的兜底：只求版式与配色跟着主题变量走，
 * 类名尽量用控制台已有的（`.sheet` / `.btn` / `.field` / `.msgline`）。
 */
const fallbackUi = () => ({
  sheet: (opts) => {
    const box = el('div', 'sheet');
    const h = el('h3', null, opts.title);
    box.append(h);
    if (opts.desc) box.append(el('div', 'sh-desc', opts.desc));
    const body = el('div');
    box.append(body);
    return { el: box, body, note: el('span'), desc: null };
  },
  rowbar: () => el('div', 'rowbar'),
  button: (label, opts = {}) => {
    const btn = el('button', `btn${opts.size === 'sm' ? ' sm' : ''}${opts.variant === 'primary' ? ' primary' : ''}`, label);
    btn.type = 'button';
    if (opts.onClick) btn.addEventListener('click', opts.onClick);
    return btn;
  },
  pill: (text, tone) => el('span', `pill${tone === 'off' ? ' off' : ''}`, text),
  msgline: (text, bad) => el('div', `msgline${bad ? ' bad' : ''}`, text),
  select: (opts = {}) => {
    const sel = el('select', 'field');
    for (const item of opts.options || []) {
      const opt = el('option', null, typeof item === 'string' ? item : item.label || item.value);
      opt.value = typeof item === 'string' ? item : item.value;
      sel.append(opt);
    }
    if (opts.value != null) sel.value = opts.value;
    return sel;
  },
  input: (opts = {}) => {
    const input = el('input', 'field');
    input.type = opts.type || 'text';
    if (opts.value != null) input.value = opts.value;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.disabled) input.disabled = true;
    return input;
  },
  checkbox: (label, opts = {}) => {
    const wrap = el('label', 'check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = opts.checked === true;
    if (opts.disabled) box.disabled = true;
    if (opts.onChange) box.addEventListener('change', () => opts.onChange(box.checked));
    wrap.append(box, el('span', null, label));
    return {
      el: wrap,
      input: box,
      get checked() { return box.checked; },
      setChecked(next) { box.checked = next === true; },
    };
  },
  field: (label, control) => {
    const wrap = el('label');
    wrap.append(el('span', 'tlabel', label), control);
    return wrap;
  },
});

/* ------------------------------------------------------------------ *
 * 「流式语音播报」：只剩状态
 * ------------------------------------------------------------------ */

const mountStatus = async (ctx) => {
  const t = pick(ctx.language);
  const ui = ctx.ui && ctx.ui.sheet ? ctx.ui : fallbackUi();
  const root = el('div');

  const state = await ctx.invoke('state').catch(() => null);
  const s = state && typeof state === 'object' ? state : {};

  const sheet = ui.sheet({ title: t.statusTitle, desc: t.statusDesc });
  const card = sheet.body;

  const bar = ui.rowbar();
  const statePill = ui.pill(t.idle, 'on');
  const quietBtn = ui.button(t.quiet, {
    size: 'sm',
    onClick: () => {
      quietBtn.disabled = true;
      ctx.invoke('hush')
        .then((next) => {
          if (next && typeof next === 'object') render(next);
          setNote(statusMsg, t.quietDone, 'ok');
        })
        .catch((err) => fail(err))
        .finally(() => { quietBtn.disabled = false; });
    },
  });
  bar.append(statePill, quietBtn);

  const rows = el('div');
  rows.style.display = 'flex';
  rows.style.flexDirection = 'column';

  /** 一行「标签 … 值」，颜色跟着主题变量走。 */
  const kvRow = (label, mono) => {
    const line = el('div');
    line.style.cssText = 'display:flex;gap:14px;justify-content:space-between;align-items:baseline;'
      + 'padding:6px 0;border-top:1px solid var(--line);font-size:var(--text-detail,12.5px)';
    const left = el('span', null, label);
    left.style.cssText = 'color:var(--ink-soft);flex:0 0 auto';
    const right = el('span', null, '—');
    right.style.cssText = `color:var(--ink);text-align:right;word-break:break-all${mono ? ';font-family:var(--mono,monospace)' : ''}`;
    line.append(left, right);
    rows.append(line);
    return right;
  };

  const engineValue = kvRow(t.engine, true);
  const voiceValue = kvRow(t.voice, true);
  const chunkValue = kvRow(t.chunks);
  const firstValue = kvRow(t.first, true);
  const roundValue = kvRow(t.round);
  const totalValue = kvRow(t.total, true);

  const statusMsg = el('div');
  statusMsg.style.cssText = 'font-size:var(--text-detail,12.5px);line-height:1.45;min-height:0;margin-top:10px;color:var(--ink-soft)';
  /** 一行提示：tone 空=灰，ok=绿，bad=红。 */
  const setNote = (node, text, tone) => {
    node.textContent = text || '';
    node.className = tone === 'bad' ? 'msgline bad' : tone === 'ok' ? 'msgline' : '';
    node.style.color = !tone ? 'var(--ink-soft)' : '';
    if (!text) node.style.minHeight = '0';
  };

  card.append(bar, rows, statusMsg);

  const render = (next) => {
    const speaking = next.speaking === true;
    const on = next.enabled !== false;
    statePill.textContent = !on ? t.off : speaking ? t.on : t.idle;
    statePill.className = `pill ${on ? 'on' : 'off'}`;
    engineValue.textContent = next.engine === 'api'
      ? `API · ${next.apiBase || '—'}`
      : 'Edge';
    voiceValue.textContent = next.engine === 'api'
      ? [`${next.apiVoice || '—'} · ${next.apiFormat || ''}`, `${next.apiSpeedFactor ?? 1}×`, `${next.apiVolume ?? 100}%`]
        .join(' · ') + (next.apiKeySet ? ' · 带令牌' : '')
      : `${next.voiceName || next.voice || '—'} · ${next.rate || ''} · ${next.pitch || ''} · ${next.volume || ''}`;
    chunkValue.textContent = [
      `${next.minChars}–${next.maxChars} 字`,
      `停顿 ${next.gapMs ?? 0}ms`,
      next.readOptions === false ? t.optionsOff : t.optionsOn,
    ].join(' · ');
    firstValue.textContent = next.firstAudioMs == null ? t.never : fmt(next.firstAudioMs);
    roundValue.textContent = `${next.chunks ?? 0} 块 · ${t.queued} ${next.queued ?? 0} · ${t.spoken} ${next.spoken ?? 0}`
      + (next.failed ? ` · ${t.failed} ${next.failed}` : '');
    totalValue.textContent = fmt(next.totalMs);
  };

  const fail = (err) => setNote(statusMsg, /40[13]/.test(errText(err)) ? t.staleSession : errText(err), 'bad');

  if (state && typeof state === 'object') render(state);

  root.append(sheet.el);
  ctx.root.append(root);

  ctx.interval(async () => {
    try {
      const next = await ctx.invoke('state');
      if (next && typeof next === 'object') {
        render(next);
        if (next.error) fail(next.error);
        else if (statusMsg.className.includes('bad')) setNote(statusMsg, '');
      }
    } catch (err) {
      fail(err);
    }
  }, 2000);
};

/* ------------------------------------------------------------------ *
 * 「Edge 语音」/「API 语音」：一套引擎一页
 * ------------------------------------------------------------------ */

/**
 * 两个语音页共用的一套渲染。
 *
 * `which` 只用来决定「另一页叫什么」「试听参数怎么映射」，字段本身全由后端给。
 */
const mountVoice = async (ctx, which) => {
  const t = pick(ctx.language);
  const ui = ctx.ui && ctx.ui.sheet ? ctx.ui : fallbackUi();
  const scheme = themeScheme();
  const root = el('div');
  const isApi = which === 'api';
  const en = ctx.language === 'en';
  const otherName = isApi ? (en ? 'Edge voice' : 'Edge 语音') : (en ? 'API voice' : 'API 语音');

  let spec;
  try {
    spec = await ctx.invoke('fields');
  } catch (err) {
    root.append(ui.msgline(`${t.loadFail}（${errText(err)}）`, true));
    ctx.root.append(root);
    return;
  }
  if (!spec || !Array.isArray(spec.fields)) {
    root.append(ui.msgline(t.loadFail, true));
    ctx.root.append(root);
    return;
  }

  const initial = isApi ? await ctx.invoke('state').catch(() => null) : null;
  const sheet = ui.sheet({ title: spec.title, desc: spec.desc });
  const card = sheet.body;

  const fieldsBox = el('div');
  /** key → 取当前控件值的函数；保存与试听都从这里收。 */
  const getters = new Map();
  /** 控件本身，刷新值时按 key 找到它。 */
  const controls = new Map();
  let keyClear = null;

  const setNote = (text, tone) => {
    note.textContent = text || '';
    note.className = tone === 'bad' ? 'msgline bad' : tone === 'ok' ? 'msgline' : '';
    note.style.color = !tone ? 'var(--ink-soft)' : '';
  };

  /** 下拉重建：保留当前值，不在表里就补一行，免得一刷新就把设置吞掉。 */
  const fillSelect = (sel, rows, current) => {
    sel.replaceChildren();
    const values = [];
    const add = (value, label) => {
      const opt = el('option', null, label);
      opt.value = value;
      sel.append(opt);
      values.push(value);
    };
    const known = rows.map((r) => r.value);
    if (current && !known.includes(current)) add(current, `${current} · ${t.customTag}`);
    for (const row of rows) add(row.value, row.label || row.value);
    const at = values.indexOf(current);
    sel.selectedIndex = at >= 0 ? at : 0;
    return sel;
  };

  for (const field of spec.fields) {
    const row = el('div');
    row.style.cssText = 'padding:9px 0;border-top:1px solid var(--line)';
    const top = el('div');
    top.style.cssText = 'display:flex;align-items:center;gap:14px';
    const cap = el('span', null, field.title);
    cap.style.cssText = 'flex:0 0 100px;font-size:var(--text-detail,12.5px);color:var(--ink)';
    const mid = el('div');
    mid.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;max-width:340px';
    // 说明单独占一行、控件下面，别挤在控件右边变成一条竖线
    const desc = el('div', null, field.desc || '');
    desc.style.cssText = 'font-size:var(--text-detail,12px);color:var(--ink-soft);line-height:1.55;'
      + 'margin:4px 0 0 114px;max-width:560px';

    if (field.type === 'boolean') {
      const cb = ui.checkbox('', { checked: field.value === true });
      cb.input.style.colorScheme = scheme;
      // 勾选框的尺寸与对齐全部写死：原生框的大小跟着字号走、位置跟着框架的 .check 走，
      // 换一处字号它就会比文字中心高一截。这里连标签行盒都是 18px，三者同一把尺。
      cb.el.style.cssText = 'display:inline-flex;align-items:center;height:18px;flex:none;'
        + 'margin:0;cursor:pointer';
      const filler = cb.el.lastElementChild;
      if (filler && !filler.textContent) filler.style.display = 'none';
      cb.input.style.cssText = 'width:16px;height:16px;margin:0;padding:0;flex:none;'
        + 'display:block;cursor:pointer';
      cap.style.lineHeight = '18px';
      mid.style.cssText = 'display:flex;align-items:center;height:18px;gap:8px;'
        + 'flex:1 1 auto;min-width:0;max-width:340px';
      mid.append(cb.el);
      getters.set(field.key, () => cb.checked === true);
      controls.set(field.key, { kind: 'bool', ctl: cb });
      // 启用开关立刻生效：它决定的是「现在用哪套引擎」，等点保存太绕
      cb.input.addEventListener('change', () => { void saveSwitch(field.key, cb.checked); });
    } else if (field.type === 'select') {
      const sel = ui.select({ options: field.options || [] });
      sel.style.flex = '1 1 auto';
      sel.style.minWidth = '0';
      sel.style.colorScheme = scheme;
      fillSelect(sel, field.options || [], String(field.value ?? ''));
      mid.append(sel);
      getters.set(field.key, () => sel.value);
      controls.set(field.key, { kind: 'select', ctl: sel });
    } else if (field.type === 'number') {
      const input = ui.input({ type: 'number', value: String(field.value ?? '') });
      input.style.flex = '1 1 auto';
      input.style.minWidth = '0';
      input.style.colorScheme = scheme;
      if (field.min != null) input.min = String(field.min);
      if (field.max != null) input.max = String(field.max);
      if (field.step != null) input.step = String(field.step);
      mid.append(input);
      if (field.suffix) {
        const unit = el('span', null, field.suffix);
        unit.style.cssText = 'color:var(--ink-soft);font-size:var(--text-detail,12px)';
        mid.append(unit);
      }
      getters.set(field.key, () => Number(input.value));
      controls.set(field.key, { kind: 'number', ctl: input });
    } else if (field.type === 'slider') {
      // 滑动条：0.1–5 的倍率，右边跟一个读数（如「1.2×」）
      const min = field.min != null ? Number(field.min) : 0.1;
      const max = field.max != null ? Number(field.max) : 5;
      const step = field.step != null ? Number(field.step) : 0.05;
      const input = ui.input({ type: 'range' });
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(field.value ?? 1);
      input.style.flex = '1 1 auto';
      input.style.minWidth = '0';
      input.style.colorScheme = scheme;
      input.style.accentColor = 'var(--accent, #4c8dff)';
      const suffix = field.suffix || '';
      const fmtNum = (n) => String(Math.round(Number(n) * 100) / 100);
      const readout = el('span', null, fmtNum(input.value) + suffix);
      readout.style.cssText = 'flex:0 0 48px;text-align:right;font-variant-numeric:tabular-nums;color:var(--ink-soft);font-size:var(--text-detail,12px)';
      const syncReadout = () => { readout.textContent = fmtNum(input.value) + suffix; };
      input.addEventListener('input', syncReadout);
      mid.append(input, readout);
      getters.set(field.key, () => Number(input.value));
      controls.set(field.key, { kind: 'slider', ctl: input, syncReadout });
    } else {
      const input = ui.input({
        type: field.type === 'password' ? 'password' : 'text',
        value: field.type === 'password' ? '' : String(field.value ?? ''),
        placeholder: field.placeholder,
      });
      input.style.flex = '1 1 auto';
      input.style.minWidth = '0';
      input.style.colorScheme = scheme;
      mid.append(input);
      if (field.key === 'apiKey') {
        getters.set(field.key, () => input.value.trim());
        keyClear = ui.checkbox(t.clearKey, {
          checked: false,
          onChange: (next) => { input.disabled = next === true; },
        });
        // 和上面那个开关用同一把尺：行高 18px、框 16px，靠 flex 居中，不随字号漂
        keyClear.el.style.cssText = 'display:inline-flex;align-items:center;gap:7px;height:18px;'
          + 'flex:none;margin:0;cursor:pointer;white-space:nowrap';
        keyClear.input.style.cssText = 'width:16px;height:16px;margin:0;padding:0;flex:none;display:block';
        if (keyClear.el.lastElementChild) keyClear.el.lastElementChild.style.lineHeight = '18px';
        mid.append(keyClear.el);
      } else {
        getters.set(field.key, () => input.value);
      }
      controls.set(field.key, { kind: 'text', ctl: input, password: field.type === 'password' });
    }

    top.append(cap, mid);
    row.append(top);
    if (field.desc) row.append(desc);
    fieldsBox.append(row);
  }

  /* ---------------- 连接测试（只有 API 页） ---------------- */

  const bar = ui.rowbar();
  const saveBtn = ui.button(t.save, { variant: 'primary', size: 'sm' });
  bar.append(saveBtn);

  if (isApi) {
    const testBtn = ui.button(t.test, { size: 'sm' });
    testBtn.addEventListener('click', () => {
      testBtn.disabled = true;
      setNote(t.testing);
      const keyValue = keyClear && keyClear.checked ? '' : readValue('apiKey');
      ctx.invoke('probe', [{
        base: readValue('apiBase') || undefined,
        ...(keyValue ? { key: keyValue } : {}),
      }])
        .then((r) => {
          if (!r || typeof r !== 'object') return;
          if (!r.ok) {
            setNote(`✗ ${r.error || '—'}`, 'bad');
            return;
          }
          // 地址被规范化了（贴了整条端点、少写 /v1）就回填，省得下次再疑惑
          const baseCtl = controls.get('apiBase');
          if (r.base && baseCtl && baseCtl.ctl.value !== r.base) baseCtl.ctl.value = r.base;
          const voiceRows = Array.isArray(r.voiceRows) && r.voiceRows.length
            ? r.voiceRows
            : (r.voices || []).map((name) => ({ value: name, label: name }));
          const voiceCtl = controls.get('apiVoice');
          if (voiceRows.length && voiceCtl) fillSelect(voiceCtl.ctl, voiceRows, voiceCtl.ctl.value);
          const modelCtl = controls.get('apiModel');
          if ((r.models || []).length && modelCtl) {
            const rows = [{ value: '', label: t.modelNone || '（不发送）' }]
              .concat(r.models.map((name) => ({ value: name, label: name })));
            fillSelect(modelCtl.ctl, rows, modelCtl.ctl.value);
          }
          const voices = r.voices || [];
          const models = r.models || [];
          const text = t.testOk(r.ms, voices.length, models.length);
          setNote(voices.length || models.length ? text : `${text} · ${t.testNoList}`, 'ok');
        })
        .catch((err) => setNote(errText(err), 'bad'))
        .finally(() => { testBtn.disabled = false; });
    });
    bar.prepend(testBtn);
  }

  const readValue = (key) => {
    const get = getters.get(key);
    return get ? get() : undefined;
  };

  /** 整组的当前值，保存时原样提交；后端只认它认识的键。 */
  const readAll = () => {
    const out = {};
    for (const [key, get] of getters) out[key] = get();
    if (keyClear && keyClear.checked) out.clearKey = true;
    if (keyClear && !keyClear.checked && !out.apiKey) delete out.apiKey;
    return out;
  };

  /** 试听参数用短名（`preview()` 的约定），省得后端两套名字都认。 */
  const previewArgs = () => {
    const text = sampleInput.value.trim() || undefined;
    if (!isApi) {
      return {
        voice: readValue('voice'),
        rate: readValue('rate'),
        pitch: readValue('pitch'),
        volume: readValue('volume'),
        text,
      };
    }
    const all = readAll();
    return {
      base: all.apiBase,
      ...(all.apiKey ? { key: all.apiKey } : {}),
      voice: all.apiVoice,
      model: all.apiModel,
      instructions: all.apiInstructions,
      language: all.apiLanguage,
      speed: all.apiSpeedFactor,
      volume: all.apiVolume,
      text,
    };
  };

  /* ---------------- 试听 ---------------- */

  const sampleRow = el('div');
  sampleRow.style.cssText = 'display:flex;align-items:center;gap:12px;margin:12px 0';
  const sampleCap = el('span', null, t.sample);
  sampleCap.style.cssText = 'color:var(--ink-soft);font-size:var(--text-detail,12.5px);flex:0 0 100px';
  const sampleInput = ui.input({ value: t.sampleText });
  sampleInput.style.flex = '1';
  sampleInput.style.colorScheme = scheme;
  sampleInput.setAttribute('aria-label', t.sample);
  sampleRow.append(sampleCap, sampleInput);

  const tryBtn = ui.button(t.try, { size: 'sm', onClick: () => {
    tryBtn.disabled = true;
    setNote(t.trying);
    ctx.invoke('preview', [previewArgs()])
      .then((r) => {
        if (!r || typeof r !== 'object') return;
        if (r.ok) setNote(`${t.ok} · ${r.voiceName || r.voice} · 合成 ${fmt(r.synthMs)}`, 'ok');
        else setNote(`${r.error || '—'}`, 'bad');
      })
      .catch((err) => setNote(errText(err), 'bad'))
      .finally(() => { tryBtn.disabled = false; });
  } });
  // 试听排在保存前面：先听，再决定要不要留下
  bar.insertBefore(tryBtn, saveBtn);

  const note = el('div');
  note.style.cssText = 'font-size:var(--text-detail,12.5px);line-height:1.45;margin-top:10px;color:var(--ink-soft)';

  // 探测缓存：下拉里那些音色是几时拉的，说清楚，用户才知道要不要再点一次测试
  const cacheNote = el('div');
  cacheNote.style.cssText = 'font-size:var(--text-detail,12px);color:var(--ink-soft);line-height:1.5;margin-top:6px';
  if (isApi && initial && initial.apiCatalogAt) {
    cacheNote.textContent = t.cached(agoOf(Date.now() - initial.apiCatalogAt, en));
  }

  const other = el('div');
  other.textContent = t.otherTab(otherName);
  other.style.cssText = 'font-size:var(--text-detail,12px);color:var(--ink-soft);margin-top:8px';

  card.append(fieldsBox, cacheNote, sampleRow, bar, note, other);
  root.append(sheet.el);
  ctx.root.append(root);

  /* ---------------- 保存 ---------------- */

  saveBtn.addEventListener('click', () => {
    saveBtn.disabled = true;
    setNote(t.saving);
    const payload = readAll();
    // 令牌是掩码框：没输入就不提交，免得把已存的那份冲掉
    if (keyClear && keyClear.checked) payload.clearKey = true;
    ctx.invoke('save', [payload])
      .then((r) => {
        if (r && r.ok === false) {
          setNote(String(r.error || '—'), 'bad');
          return undefined;
        }
        if (keyClear && keyClear.checked) {
          keyClear.setChecked(false);
          const keyCtl = controls.get('apiKey');
          if (keyCtl) {
            keyCtl.ctl.value = '';
            keyCtl.ctl.disabled = false;
            keyCtl.ctl.placeholder = '';
          }
        }
        setNote((r && r.text) || t.saved, 'ok');
        return reload();
      })
      .catch((err) => setNote(errText(err), 'bad'))
      .finally(() => { saveBtn.disabled = false; });
  });

  /**
   * 启用开关：勾上就切到这套引擎（另一页的开关由后端归一化关掉），取消就说明为什么不行。
   * 无论成败都按后端的最新状态回填，用户看到的永远是真正生效的那个。
   */
  const saveSwitch = async (key, on) => {
    setNote(t.saving);
    try {
      const r = await ctx.invoke('save', [{ [key]: on }]);
      if (r && r.ok === false) setNote(String(r.error || t.switchOff), 'bad');
      else setNote(String((r && r.text) || t.switchOn(spec.title)), 'ok');
    } catch (err) {
      setNote(errText(err), 'bad');
    }
    await reload();
  };

  /** 视图按后端最新值回填；正在输入的那个控件不打断。 */
  async function reload() {
    let next;
    try {
      next = await ctx.invoke('fields');
    } catch {
      return;
    }
    if (!next || !Array.isArray(next.fields)) return;
    for (const field of next.fields) {
      const entry = controls.get(field.key);
      if (!entry) continue;
      const active = document.activeElement === entry.ctl || document.activeElement === entry.ctl.input;
      if (field.type === 'boolean') {
        entry.ctl.setChecked(field.value === true);
      } else if (field.type === 'select') {
        if (!active) fillSelect(entry.ctl, field.options || [], String(field.value ?? ''));
      } else if (field.type === 'slider') {
        if (!active) {
          entry.ctl.value = String(field.value ?? 1);
          if (entry.syncReadout) entry.syncReadout();
        }
      } else if (field.type === 'password') {
        if (!active && !entry.ctl.value && field.placeholder) entry.ctl.placeholder = field.placeholder;
      } else if (!active) {
        entry.ctl.value = String(field.value ?? '');
      }
    }
  }

  // 引擎在另一页被切换时提醒一句：这页的参数此刻已经不生效了
  let lastEngine = null;
  ctx.interval(async () => {
    try {
      const s = await ctx.invoke('state');
      if (!s || typeof s !== 'object') return;
      const engine = s.engine;
      if (lastEngine && engine !== lastEngine) setNote(t.engineMoved);
      lastEngine = engine;
    } catch {
      /* 轮询失败不吵人，保存时会报 */
    }
  }, 2500);
};

export default {
  panels: {
    stream: { mount: mountStatus },
    'edge-voice': { mount: (ctx) => mountVoice(ctx, 'edge') },
    'api-voice': { mount: (ctx) => mountVoice(ctx, 'api') },
  },
};

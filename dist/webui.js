/**
 * 「流式语音播报」页签的面板。
 *
 * 手写的 ESM，不 import 任何东西：服务端按 `cortico.webUiClient` 找到这个文件，浏览器直接
 * `import()` 它，所以要自带默认导出 `{ panels: { stream: { mount } } }`。
 *
 * 外观全部走宿主给的 `ctx.ui` 原语（卡片 `.sheet`、按钮 `.btn`、控件 `.field`、`.msgline`），
 * 这样深色/浅色主题、字号、圆角都跟控制台其他页一致；`ctx.ui` 不在时退回同样版式的裸 DOM。
 *
 * 两张卡：
 * 1. 状态——在说/待命、当前嗓音、切块与停顿、第一块多快出声，外加「立即静音」；
 * 2. 试听——音色、语速、音调、音量现场改，按一下真的合成并放出来；合成失败会说明原因。
 *    满意了按「写入配置」，和配置页是同一份值。
 */
const TEXT = {
  zh: {
    statusTitle: '运行状态',
    statusDesc: '参数在下面试听，或者去「配置」页慢慢调。',
    on: '在说',
    idle: '待命',
    off: '已关',
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
    tryTitle: '试听音色',
    tryDesc: '按这套参数合成一句并真的放出来：能不能出声、是不是想要的那个，一听就知道。',
    voiceSel: '音色',
    rateSel: '语速',
    pitchSel: '音调',
    volSel: '音量',
    sample: '试听文本',
    sampleText: '你好，这是现在的音色、语速和音调——听得清楚吗？',
    try: '试听',
    trying: '合成中…（冷启动要两三秒）',
    save: '写入配置',
    saving: '写入中…',
    ok: '可以用',
    fail: '没出声',
    loadFail: '选项加载失败：',
    staleSession: '和 Core 的连接失效了（刚重启过？），刷新一下这个页面就好。',
  },
  en: {
    statusTitle: 'Status',
    statusDesc: 'Audition the settings below, or tune them on the Config tab.',
    on: 'speaking',
    idle: 'ready',
    off: 'off',
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
    tryTitle: 'Audition a voice',
    tryDesc: 'Synthesise one line with these settings and play it: you hear at once whether it works and whether it suits.',
    voiceSel: 'Voice',
    rateSel: 'Rate',
    pitchSel: 'Pitch',
    volSel: 'Volume',
    sample: 'Sample',
    sampleText: 'Hello, this is the current voice, rate and pitch.',
    try: 'Play sample',
    trying: 'Synthesising… (a cold start takes 2–3s)',
    save: 'Save to config',
    saving: 'Saving…',
    ok: 'works',
    fail: 'no sound',
    loadFail: 'could not load options: ',
    staleSession: 'The connection to Core went stale (restart?). Reload this page.',
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
    input.type = 'text';
    if (opts.value != null) input.value = opts.value;
    return input;
  },
  field: (label, control) => {
    const wrap = el('label');
    wrap.append(el('span', 'tlabel', label), control);
    return wrap;
  },
});

export default {
  panels: {
    stream: {
      async mount(ctx) {
        const t = pick(ctx.language);
        const ui = ctx.ui && ctx.ui.sheet ? ctx.ui : fallbackUi();
        const root = el('div');

        /* 先把状态和选项拿回来，再按真实值把界面搭出来，避免下拉先亮一眼旧值 */
        const [state, opts] = await Promise.all([
          ctx.invoke('state').catch(() => null),
          ctx.invoke('options').catch(() => null),
        ]);
        const s = state && typeof state === 'object' ? state : {};
        const voices = (opts && opts.voices) || [];
        const rates = (opts && opts.rates) || [s.rate].filter(Boolean);
        const pitches = (opts && opts.pitches) || [s.pitch].filter(Boolean);
        const volumes = (opts && opts.volumes) || [s.volume].filter(Boolean);

        /* ---------------- 状态卡 ---------------- */

        const statusSheet = ui.sheet({ title: t.statusTitle, desc: t.statusDesc });
        const statusCard = statusSheet.body;

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

        const voiceValue = kvRow(t.voice, true);
        const chunkValue = kvRow(t.chunks);
        const firstValue = kvRow(t.first, true);
        const roundValue = kvRow(t.round);
        const totalValue = kvRow(t.total, true);
        const note = (marginTop) => {
          const node = el('div');
          node.style.cssText = `font-size:var(--text-detail,12.5px);line-height:1.45;min-height:0;margin-top:${marginTop};color:var(--ink-soft)`;
          return node;
        };
        /** 一行提示：tone 空=灰，ok=绿，bad=红。 */
        const setNote = (node, text, tone) => {
          node.textContent = text || '';
          node.className = tone === 'bad' ? 'msgline bad' : tone === 'ok' ? 'msgline' : '';
          if (!tone) node.style.color = 'var(--ink-soft)';
          else node.style.color = '';
          if (!text) node.style.minHeight = '0';
        };
        const statusMsg = note('10px');

        statusCard.append(bar, rows, statusMsg);

        const render = (next) => {
          const speaking = next.speaking === true;
          const on = next.enabled !== false;
          statePill.textContent = !on ? t.off : speaking ? t.on : t.idle;
          statePill.className = `pill ${on ? 'on' : 'off'}`;
          voiceValue.textContent = `${next.voiceName || next.voice || '—'} · ${next.rate || ''} · ${next.pitch || ''} · ${next.volume || ''}`;
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

        const fail = (err) => {
          const message = String(err && err.message ? err.message : err);
          setNote(statusMsg, /40[13]/.test(message) ? t.staleSession : message, 'bad');
        };

        if (state && typeof state === 'object') render(state);

        /* ---------------- 试听卡 ---------------- */

        const trySheet = ui.sheet({ title: t.tryTitle, desc: t.tryDesc });
        const tryCard = trySheet.body;

        /** 下拉里没有当前值（手写进 config.json 的自定义音色）时补一行，避免显示成空白。 */
        const fill = (control, values, current) => {
          if (!current || (values || []).some((v) => (typeof v === 'string' ? v : v.value) === current)) {
            if (current) control.value = current;
            return control;
          }
          const opt = el('option', null, `${current} · 自定义`);
          opt.value = current;
          control.append(opt);
          control.value = current;
          return control;
        };

        const voiceSel = fill(ui.select({ options: voices }), voices, s.voice);
        const rateSel = fill(ui.select({ options: rates }), rates, s.rate);
        const pitchSel = fill(ui.select({ options: pitches }), pitches, s.pitch);
        const volumeSel = fill(ui.select({ options: volumes }), volumes, s.volume);
        // 原生下拉的弹出列表由浏览器画，不设 color-scheme 会在深色主题里弹出白底
        const scheme = themeScheme();
        for (const control of [voiceSel, rateSel, pitchSel, volumeSel]) control.style.colorScheme = scheme;

        const fields = el('div');
        fields.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-bottom:12px';
        for (const [label, control] of [
          [t.voiceSel, voiceSel],
          [t.rateSel, rateSel],
          [t.pitchSel, pitchSel],
          [t.volSel, volumeSel],
        ]) {
          const row = el('div');
          row.style.cssText = 'display:flex;align-items:center;gap:12px';
          const cap = el('span', null, label);
          cap.style.cssText = 'color:var(--ink-soft);font-size:var(--text-detail,12.5px);flex:0 0 72px';
          control.style.minWidth = '180px';
          control.style.maxWidth = '260px';
          row.append(cap, control);
          fields.append(row);
        }

        const sampleInput = ui.input({ value: t.sampleText });
        sampleInput.style.flex = '1';
        sampleInput.style.colorScheme = scheme;
        sampleInput.setAttribute('aria-label', t.sample);
        const sampleRow = el('div');
        sampleRow.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:12px';
        const sampleCap = el('span', null, t.sample);
        sampleCap.style.cssText = 'color:var(--ink-soft);font-size:var(--text-detail,12.5px);flex:0 0 72px';
        sampleRow.append(sampleCap, sampleInput);

        const tryMsg = note('8px');

        const chosen = () => ({
          voice: voiceSel.value,
          rate: rateSel.value,
          pitch: pitchSel.value,
          volume: volumeSel.value,
          text: sampleInput.value.trim() || undefined,
        });

        const tryBtn = ui.button(t.try, {
          variant: 'primary',
          size: 'sm',
          onClick: () => {
            tryBtn.disabled = true;
            setNote(tryMsg, t.trying);
            ctx.invoke('preview', [chosen()])
              .then((r) => {
                if (!r || typeof r !== 'object') return;
                if (r.ok) setNote(tryMsg, `${t.ok} · ${r.voiceName || r.voice} · 合成 ${fmt(r.synthMs)}`, 'ok');
                else setNote(tryMsg, `${t.fail}：${r.error || '—'}`, 'bad');
              })
              .catch((err) => setNote(tryMsg, String(err && err.message ? err.message : err), 'bad'))
              .finally(() => { tryBtn.disabled = false; });
          },
        });

        const saveBtn = ui.button(t.save, {
          size: 'sm',
          onClick: () => {
            const style = chosen();
            saveBtn.disabled = true;
            setNote(tryMsg, t.saving);
            ctx.setConfig('world:streamvoice.voice', {
              'worlds.streamvoice.voice': style.voice,
              'worlds.streamvoice.rate': style.rate,
              'worlds.streamvoice.pitch': style.pitch,
              'worlds.streamvoice.volume': style.volume,
            })
              .then((msg) => {
                setNote(tryMsg, msg || t.ok, 'ok');
                return refresh();
              })
              .catch((err) => setNote(tryMsg, String(err && err.message ? err.message : err), 'bad'))
              .finally(() => { saveBtn.disabled = false; });
          },
        });

        const actions = ui.rowbar();
        actions.append(tryBtn, saveBtn);
        if (!opts || typeof opts !== 'object') setNote(tryMsg, `${t.loadFail}options`, 'bad');

        tryCard.append(fields, sampleRow, actions, tryMsg);

        root.append(statusSheet.el, trySheet.el);
        ctx.root.append(root);

        /* ---------------- 轮询 ---------------- */

        const refresh = async () => {
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
        };

        ctx.interval(refresh, 2000);
      },
    },
  },
};

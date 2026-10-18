// 固件加工面板：输入文件 → 处理步骤 → 结果预览（地址分布图 / 段列表）→ 输出。
// 配置保存在这里，每次修改发给扩展执行流水线，扩展返回预览结果。
// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // @ts-ignore
  const UI = window.HexppTools;
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const esc = UI.esc, fmtAddr = UI.fmtAddr;
  const t = UI.t;
  const num = (n) => n.toLocaleString('en-US');
  const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
  const post = (m) => vscode.postMessage(m);
  const COLORS = 6;

  /** @type {{inputs:any[], policy:string, steps:any[], output:any}} */
  const cfg = { inputs: [], policy: 'error', steps: [], output: { format: 'ihex', recordLength: 16, fill: 'FF', split: 'none', splitValue: '', path: '' } };
  /** @type {any[]} */
  let algos = [];
  /** @type {any[]} */
  let formats = [];
  /** @type {any} */
  let pv = null;
  let timer = 0;

  document.body.innerHTML = `
  <header class="phead">
    <div class="ptitle">${t('Firmware Processing')}<span class="muted">${t('Merge · Offset · Crop · Fill · Write · Split')}</span></div>
    <span class="spacer"></span>
    <button id="impBtn" class="sm" title="${t('Import inputs, steps and output settings from .hexpp.json')}">${t('Import recipe')}</button>
    <button id="expBtn" class="sm" title="${t('Export as .hexpp.json (paths relative to the recipe file) for reuse or version control')}">${t('Export recipe')}</button>
  </header>
  <main class="pcols">
    <div class="pcol">
      <section class="psec">
        <div class="thead"><span class="num">1</span>${t('Input files')}<span class="spacer"></span><button id="addBtn" class="sm accent">${t('+ Add files')}</button></div>
        <div id="inputs" class="inputs"></div>
        <div class="frow wide"><label>${t('Address overlap')}</label><div class="fctl"><span class="seg sm" id="policy">
          <button data-v="error" title="${t('Report an error on any overlap')}">${t('Error')}</button><button data-v="overwrite" title="${t('Files later in the list overwrite earlier ones')}">${t('Later overwrites')}</button><button data-v="keep" title="${t('Keep data from earlier files')}">${t('Earlier wins')}</button>
        </span></div></div>
      </section>
      <section class="psec">
        <div class="thead"><span class="num">2</span>${t('Steps')}<span class="muted lower">${t('Run in order')}</span><span class="spacer"></span><button id="stepBtn" class="sm accent">${t('+ Add step')}</button></div>
        <div id="steps"></div>
      </section>
    </div>
    <div class="pcol">
      <section class="psec">
        <div class="thead"><span class="num">3</span>${t('Result preview')}</div>
        <div class="mapbox"><canvas id="map"></canvas></div>
        <div id="summary" class="summary"></div>
        <div id="segs" class="segs"></div>
      </section>
      <section class="psec">
        <div class="thead"><span class="num">4</span>${t('Output')}</div>
        <div class="frow wide"><label>${t('Format')}</label><div class="fctl"><span class="seg sm" id="fmt"></span></div></div>
        <div class="frow wide" id="rlRow"><label>${t('Record length')}</label><div class="fctl"><span class="seg sm" id="rl"><button data-v="16">16</button><button data-v="32">32</button></span><span class="muted hint">${t('bytes / record')}</span></div></div>
        <div class="frow wide" id="fillRow"><label>${t('Gap fill')}</label><div class="fctl"><input id="fill" class="mono byte" spellcheck="false"><span class="muted hint">${t('BIN has no addresses; gaps are filled with this byte')}</span></div></div>
        <div class="frow wide"><label>${t('Split')}</label><div class="fctl"><span class="seg sm" id="split">
          <button data-v="none">${t('No split')}</button><button data-v="segment">${t('One per segment')}</button><button data-v="size">${t('By size')}</button><button data-v="boundary">${t('By address')}</button>
        </span><input id="splitValue" class="mono hidden" spellcheck="false"></div></div>
        <div class="frow wide"><label>${t('Output to')}</label><div class="fctl"><input id="outPath" class="mono" spellcheck="false" placeholder="${t('Output file path')}"><button id="browse" class="sm">${t('Browse…')}</button></div></div>
        <div id="files" class="files"></div>
        <div class="pact"><button id="genBtn" class="primary">${t('Generate')}</button><button id="genOpen" class="secondary">${t('Generate and open')}</button><span id="genInfo" class="muted"></span></div>
      </section>
    </div>
  </main>`;

  // ---------------- 配置变更 ----------------
  function changed() {
    clearTimeout(timer);
    timer = setTimeout(() => post({ type: 'config', config: { ...cfg, inputs: cfg.inputs.map((i) => ({ id: i.id, offset: i.offset || '' })) } }), 150);
  }
  function segBind(id, get, set) {
    const el = $(id);
    const sync = () => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(get())));
    el.addEventListener('click', (e) => {
      const b = /** @type {HTMLElement} */ (e.target).closest('button');
      if (!b) return;
      set(b.dataset.v);
      sync();
      syncOutput();
      changed();
    });
    return sync;
  }
  const syncPolicy = segBind('policy', () => cfg.policy, (v) => (cfg.policy = v));
  const syncRl = segBind('rl', () => cfg.output.recordLength, (v) => (cfg.output.recordLength = +v));
  const syncSplit = segBind('split', () => cfg.output.split, (v) => (cfg.output.split = v));
  let syncFmt = () => {};

  function buildFormats() {
    $('fmt').innerHTML = formats.map((f) => `<button data-v="${f.id}">${esc(f.label)}</button>`).join('');
    syncFmt = segBind('fmt', () => cfg.output.format, (v) => {
      cfg.output.format = v;
      const f = formats.find((x) => x.id === v);
      if (cfg.output.path && f) cfg.output.path = cfg.output.path.replace(/(\.[^./\\]*)?$/, '.' + f.ext);
    });
  }
  function syncOutput() {
    const o = cfg.output;
    syncFmt(); syncRl(); syncSplit(); syncPolicy();
    $('rlRow').classList.toggle('hidden', o.format === 'bin');
    $('fillRow').classList.toggle('hidden', o.format !== 'bin');
    const sv = /** @type {HTMLInputElement} */ ($('splitValue'));
    sv.classList.toggle('hidden', o.split !== 'size' && o.split !== 'boundary');
    sv.placeholder = o.split === 'size' ? t('Size per file, e.g. 0x10000') : t('Split addresses, e.g. 0800_4000, 0802_0000');
    if (document.activeElement !== sv) sv.value = o.splitValue;
    const fill = /** @type {HTMLInputElement} */ ($('fill'));
    if (document.activeElement !== fill) fill.value = o.fill;
    const p = /** @type {HTMLInputElement} */ ($('outPath'));
    if (document.activeElement !== p) p.value = o.path;
  }
  $('splitValue').addEventListener('input', (e) => { cfg.output.splitValue = /** @type {HTMLInputElement} */ (e.target).value; changed(); });
  $('fill').addEventListener('input', (e) => { cfg.output.fill = /** @type {HTMLInputElement} */ (e.target).value; changed(); });
  $('outPath').addEventListener('input', (e) => { cfg.output.path = /** @type {HTMLInputElement} */ (e.target).value; changed(); });
  $('browse').addEventListener('click', () => post({ type: 'browseOutput' }));
  $('addBtn').addEventListener('click', () => post({ type: 'addFiles' }));
  $('impBtn').addEventListener('click', () => post({ type: 'importRecipe' }));
  $('expBtn').addEventListener('click', () => post({ type: 'exportRecipe' }));
  const gen = (open) => { flushNow(); $('genInfo').textContent = ''; post({ type: 'generate', open }); };
  $('genBtn').addEventListener('click', () => gen(false));
  $('genOpen').addEventListener('click', () => gen(true));
  function flushNow() {
    clearTimeout(timer);
    post({ type: 'config', config: { ...cfg, inputs: cfg.inputs.map((i) => ({ id: i.id, offset: i.offset || '' })) } });
  }

  // ---------------- 输入文件 ----------------
  /** 预览返回后就地更新各输入的地址范围与错误（不重建输入框，避免打断输入） */
  function updateInputs() {
    document.querySelectorAll('.inp').forEach((el) => {
      const inp = cfg.inputs[+(/** @type {any} */ (el).dataset.k)];
      const p = inp && pv && pv.inputs.find((x) => x.id === inp.id);
      if (!p) return;
      const range = /** @type {HTMLElement} */ (el.querySelector('.irange'));
      range.textContent = p.ranges.length ? `${fmtAddr(p.ranges[0][0])} – ${fmtAddr(p.ranges[p.ranges.length - 1][1] - 1)}` : t('No data');
      /** @type {HTMLElement} */ (el.querySelector('[data-off]')).classList.toggle('bad', !!p.error);
      const err = /** @type {HTMLElement} */ (el.querySelector('.ierr'));
      err.textContent = p.error ? '✕ ' + p.error : '';
      err.classList.toggle('hidden', !p.error);
    });
  }
  function renderInputs() {
    const el = $('inputs');
    if (!cfg.inputs.length) {
      el.innerHTML = `<div class="cempty">${t('Add one or more firmware files (BIN / HEX / S-Record / TI-TXT / ELF).')}<br><span class="muted">${t('Multiple files are merged by address, e.g. Bootloader + App.')}</span></div>`;
      return;
    }
    el.innerHTML = cfg.inputs.map((inp, k) => {
      const p = pv && pv.inputs.find((x) => x.id === inp.id);
      const r = p && p.ranges.length ? [p.ranges[0][0], p.ranges[p.ranges.length - 1][1]] : inp.start !== undefined ? [inp.start, inp.end] : null;
      return `<div class="inp" data-k="${k}">
        <div class="ihead"><span class="swatch c${k % COLORS}"></span><span class="iname" title="${esc(inp.path)}">${esc(inp.name)}</span><span class="badge">${esc(inp.format)}</span>
          <span class="spacer"></span><span class="iact"><button data-a="up" title="${t('Move up (affects priority on overlap)')}">▲</button><button data-a="down" title="${t('Move down')}">▼</button><button data-a="del" title="${t('Remove')}">✕</button></span></div>
        <div class="imeta"><span class="mono irange">${r ? `${fmtAddr(r[0])} – ${fmtAddr(r[1] - 1)}` : t('No data')}</span> · ${t('{0} bytes', num(inp.size))} · ${t('{0} segments', inp.segs)}${inp.note ? ` · <span class="muted">${esc(inp.note)}</span>` : ''}${inp.warnings ? ` · <span class="warn">⚠ ${t('{0} parse warnings', inp.warnings)}</span>` : ''}</div>
        <div class="frow"><label>${inp.isBin ? t('Base') : t('Offset')}</label><div class="fctl"><input data-off class="mono${p && p.error ? ' bad' : ''}" value="${esc(inp.offset || '')}" spellcheck="false"
          placeholder="${inp.isBin ? t('BIN load address, e.g. 0800_4000') : t('+/- hex, e.g. +1000; leave empty for no offset')}"></div></div>
        <div class="err ierr${p && p.error ? '' : ' hidden'}">${p && p.error ? '✕ ' + esc(p.error) : ''}</div>
      </div>`;
    }).join('');
  }
  $('inputs').addEventListener('input', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (!t.hasAttribute('data-off')) return;
    const k = +(/** @type {any} */ (t.closest('.inp')).dataset.k);
    cfg.inputs[k].offset = t.value;
    t.classList.remove('bad');
    changed();
  });
  $('inputs').addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!b) return;
    const k = +(/** @type {any} */ (b.closest('.inp')).dataset.k);
    const a = b.dataset.a;
    if (a === 'del') cfg.inputs.splice(k, 1);
    else if (a === 'up' && k > 0) [cfg.inputs[k - 1], cfg.inputs[k]] = [cfg.inputs[k], cfg.inputs[k - 1]];
    else if (a === 'down' && k < cfg.inputs.length - 1) [cfg.inputs[k + 1], cfg.inputs[k]] = [cfg.inputs[k], cfg.inputs[k + 1]];
    else return;
    renderInputs();
    changed();
  });

  // ---------------- 步骤 ----------------
  const STEP_HINT = {
    offset: t('Add or subtract a value from all addresses'), moveTo: t('Shift to a new start address'), crop: t('Keep only data within the range'), remove: t('Delete data within the range'),
    fill: t('Fill gaps or overwrite with a fixed byte'), align: t('Extend segment ends to N-byte boundaries'), patch: t('CRC / version / timestamp / serial number'),
  };
  const stepList = UI.cardList($('steps'), {
    title: (s) => UI.stepTitle(s, algos),
    fields: (s) => UI.stepFields(s, algos),
    empty: `${t('No steps: inputs are merged and written as is.')}<br><span class="muted">${t('Add offset, crop, fill, write CRC and more.')}</span>`,
    onChange: (list) => { cfg.steps = list; changed(); },
  });
  $('stepBtn').addEventListener('click', () => UI.menu($('stepBtn'), UI.STEP_OPS.map(([op, l]) => [op, l, STEP_HINT[op]]), (op) => {
    const r = pv && pv.result && pv.result.start !== undefined ? { start: fmtAddr(pv.result.start), end: fmtAddr(pv.result.end - 1) } : {};
    const ctx = op === 'patch' && pv && pv.result ? { ...r, address: fmtAddr(pv.result.end - 4), end: fmtAddr(pv.result.end - 5) } : r;
    stepList.add(UI.stepDefaults(op, ctx));
  }));

  // ---------------- 预览 ----------------
  function renderPreview() {
    updateInputs();
    stepList.preview(pv.steps);
    const sum = $('summary');
    const res = pv.result;
    let h = '';
    if (pv.error) h += `<div class="err">✕ ${esc(pv.error)}</div>`;
    if (res) {
      h += `<div class="stats">
        <div><span class="sk">${t('Segments')}</span><span class="sv">${num(res.segs)}</span></div>
        <div><span class="sk">${t('Data')}</span><span class="sv">${size(res.size)}</span><span class="muted">${t('{0} bytes', num(res.size))}</span></div>
        <div><span class="sk">${t('Address')}</span><span class="sv mono">${res.start !== undefined ? `${fmtAddr(res.start)} – ${fmtAddr(res.end - 1)}` : '—'}</span></div>
        <div><span class="sk">CRC-32</span><span class="sv mono copy" title="${t('Click to copy (gaps skipped)')}">${esc(res.crc)}</span></div>
      </div>`;
    }
    if (pv.overlaps.length && cfg.policy !== 'error') {
      h += pv.overlaps.slice(0, 3).map((o) => `<div class="warn">⚠ ${t('Inputs {0} and {1} overlap {2} ({3})', o[2] + 1, o[3] + 1, `<span class="mono">${fmtAddr(o[0])}–${fmtAddr(o[1] - 1)}</span>`, cfg.policy === 'overwrite' ? t('Later overwrites') : t('Earlier wins'))}</div>`).join('');
      if (pv.overlaps.length > 3) h += `<div class="warn">⚠ ${t('…{0} overlaps in total', pv.overlaps.length)}</div>`;
    }
    sum.innerHTML = h;
    const crc = sum.querySelector('.copy');
    if (crc) crc.addEventListener('click', () => post({ type: 'clipboard', text: res.crc }));

    const segs = $('segs');
    if (res && res.ranges.length) {
      const rows = res.ranges.slice(0, 200).map((r, i) => `<tr><td class="muted">${i + 1}</td><td class="mono">${fmtAddr(r[0])}</td><td class="mono">${fmtAddr(r[1] - 1)}</td><td class="num">${num(r[1] - r[0])}</td>
        <td class="mono muted">${i + 1 < res.ranges.length ? `+${num(res.ranges[i + 1][0] - r[1])}` : ''}</td></tr>`).join('');
      segs.innerHTML = `<table><thead><tr><th>#</th><th>${t('Start')}</th><th>${t('End')}</th><th class="num">${t('Bytes')}</th><th>${t('Gap to next segment')}</th></tr></thead><tbody>${rows}</tbody></table>` +
        (res.segs > 200 ? `<div class="muted more">${t('…{0} more segments', num(res.segs - 200))}</div>` : '');
    } else segs.innerHTML = '';

    const files = $('files');
    ['outPath', 'splitValue', 'fill'].forEach((id) => $(id).classList.remove('bad'));
    if (pv.outError) {
      files.innerHTML = `<div class="err">✕ ${esc(pv.outError)}</div>`;
      const f = { path: 'outPath', splitValue: 'splitValue', fill: 'fill' }[pv.outField];
      if (f) $(f).classList.add('bad');
    } else if (pv.files.length) {
      files.innerHTML = `<div class="muted">${t('Will generate {0} files:', pv.files.length)}</div>` + pv.files.slice(0, 50).map((f) =>
        `<div class="file"><span class="mono">${esc(f.name)}</span><span class="muted">${size(f.size)}${f.holes ? ' · ' + t('Gaps filled') : ''}</span></div>`).join('') +
        (pv.files.length > 50 ? `<div class="muted">…</div>` : '');
    } else files.innerHTML = '';
    const ok = !!res && !pv.outError && pv.files.length > 0;
    /** @type {HTMLButtonElement} */ ($('genBtn')).disabled = !ok;
    /** @type {HTMLButtonElement} */ ($('genOpen')).disabled = !ok;
    drawMap();
  }

  // ---------------- 地址分布图 ----------------
  // 横轴按地址分段压缩：有数据的区间按大小占宽度，大空洞压缩成固定宽度并画折断标记
  const canvas = /** @type {HTMLCanvasElement} */ ($('map'));
  let axis = null;
  function buildAxis(all) {
    const sorted = all.slice().sort((a, b) => a[0] - b[0]);
    const u = [];
    for (const r of sorted) {
      const last = u[u.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else u.push([r[0], r[1]]);
    }
    if (!u.length) return null;
    const data = u.reduce((n, r) => n + r[1] - r[0], 0);
    const gapW = Math.max(1, data * 0.05);
    const pieces = [];
    let pos = 0;
    u.forEach((r, i) => {
      if (i > 0) {
        const g = r[0] - u[i - 1][1];
        const w = Math.min(g, gapW);
        pieces.push({ a: u[i - 1][1], b: r[0], v0: pos, v1: pos + w, gap: g > gapW });
        pos += w;
      }
      pieces.push({ a: r[0], b: r[1], v0: pos, v1: pos + r[1] - r[0], gap: false });
      pos += r[1] - r[0];
    });
    return { pieces, total: pos, u };
  }
  function vOf(ax, addr) {
    const ps = ax.pieces;
    let lo = 0, hi = ps.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ps[m].a <= addr) lo = m; else hi = m - 1; }
    const p = ps[lo];
    const t = p.b > p.a ? Math.min(1, Math.max(0, (addr - p.a) / (p.b - p.a))) : 0;
    return p.v0 + t * (p.v1 - p.v0);
  }
  function addrOf(ax, v) {
    const p = ax.pieces.find((x) => v >= x.v0 && v <= x.v1) || ax.pieces[ax.pieces.length - 1];
    return Math.round(p.a + ((v - p.v0) / Math.max(1e-9, p.v1 - p.v0)) * (p.b - p.a));
  }
  const LABEL_W = 44, LANE = 12, LANE_GAP = 5, AXIS_H = 18;
  function drawMap() {
    const lanes = [];
    if (pv) {
      cfg.inputs.forEach((inp, k) => {
        const p = pv.inputs.find((x) => x.id === inp.id);
        lanes.push({ label: t('Input {0}', k + 1), ranges: p ? p.ranges : [], color: k % COLORS });
      });
      if (pv.result) lanes.push({ label: t('Results'), ranges: pv.result.ranges, color: -1 });
    }
    const all = lanes.flatMap((l) => l.ranges);
    axis = buildAxis(all);
    const css = getComputedStyle(document.body);
    const W = canvas.clientWidth;
    const H = lanes.length ? lanes.length * (LANE + LANE_GAP) + AXIS_H + 6 : 40;
    canvas.style.height = H + 'px';
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const fg = css.getPropertyValue('--vscode-foreground') || '#ccc';
    const muted = css.getPropertyValue('--muted') || '#888';
    const font = css.getPropertyValue('--vscode-font-family') || 'sans-serif';
    const mono = css.getPropertyValue('--vscode-editor-font-family') || 'monospace';
    if (!axis) {
      ctx.fillStyle = muted; ctx.font = `12px ${font}`; ctx.fillText(t('Add input files to show the address map'), 8, 24);
      return;
    }
    const plotW = W - LABEL_W - 8;
    const x = (addr) => LABEL_W + (vOf(axis, addr) / axis.total) * plotW;
    lanes.forEach((ln, i) => {
      const y = 4 + i * (LANE + LANE_GAP);
      ctx.fillStyle = 'rgba(128,128,128,0.10)';
      ctx.fillRect(LABEL_W, y, plotW, LANE);
      ctx.fillStyle = ln.color < 0 ? fg : muted;
      ctx.font = `${ln.color < 0 ? '600 ' : ''}11px ${font}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(ln.label, 2, y + LANE / 2);
      ctx.fillStyle = ln.color < 0 ? css.getPropertyValue('--res-color') || '#3794ff' : css.getPropertyValue(`--c${ln.color}`) || '#888';
      for (const r of ln.ranges) {
        const x0 = x(r[0]), x1 = x(r[1]);
        ctx.fillRect(x0, y, Math.max(1.5, x1 - x0), LANE);
      }
    });
    // 重叠区域标红
    if (pv && pv.result && pv.overlaps.length) {
      const y = 4 + (lanes.length - 1) * (LANE + LANE_GAP);
      ctx.fillStyle = css.getPropertyValue('--err') || '#f14c4c';
      for (const o of pv.overlaps) ctx.fillRect(x(o[0]), y - 2, Math.max(2, x(o[1]) - x(o[0])), 3);
    }
    // 压缩的空洞：折断标记
    const yb = 4 + lanes.length * (LANE + LANE_GAP);
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1;
    for (const p of axis.pieces) {
      if (!p.gap) continue;
      const xm = LABEL_W + ((p.v0 + p.v1) / 2 / axis.total) * plotW;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(xm + 2, 4); ctx.lineTo(xm + 2, yb - 3);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(xm - 3, yb + 4); ctx.lineTo(xm + 3, yb - 2); ctx.moveTo(xm + 1, yb + 4); ctx.lineTo(xm + 7, yb - 2);
      ctx.stroke();
    }
    // 地址刻度：各连续区间的起点，放得下才画
    ctx.fillStyle = muted;
    ctx.font = `10px ${mono}`;
    ctx.textBaseline = 'top';
    let lastX = -1e9;
    const ticks = axis.u.map((r) => r[0]).concat([axis.u[axis.u.length - 1][1] - 1]);
    ticks.forEach((a, i) => {
      const tx = x(a);
      const text = fmtAddr(a);
      const w = ctx.measureText(text).width;
      const isLast = i === ticks.length - 1;
      const px = isLast ? Math.min(W - w - 2, tx - w) : Math.min(tx, W - w - 2);
      if (px < lastX + 8) return;
      ctx.fillText(text, px, yb + 2);
      lastX = px + w;
    });
  }
  canvas.addEventListener('mousemove', (e) => {
    if (!axis) { canvas.title = ''; return; }
    const r = canvas.getBoundingClientRect();
    const v = ((e.clientX - r.left - LABEL_W) / (r.width - LABEL_W - 8)) * axis.total;
    canvas.title = v >= 0 && v <= axis.total ? fmtAddr(addrOf(axis, v)) : '';
  });
  new ResizeObserver(() => drawMap()).observe(canvas);

  // ---------------- 消息 ----------------
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'init':
        algos = m.algos;
        formats = m.formats;
        cfg.output.recordLength = m.defaults.recordLength;
        cfg.output.fill = m.defaults.fill;
        if (m.defaults.format) cfg.output.format = m.defaults.format;
        buildFormats();
        syncOutput();
        renderInputs();
        drawMap();
        changed();
        break;
      case 'inputsAdded':
        for (const i of m.inputs) cfg.inputs.push({ ...i, offset: i.offset || '' });
        if (!cfg.output.path && m.suggestPath) {
          const f = formats.find((x) => x.id === cfg.output.format);
          cfg.output.path = m.suggestPath + '.' + (f ? f.ext : 'hex');
        }
        renderInputs();
        syncOutput();
        changed();
        break;
      case 'outputPath': {
        cfg.output.path = m.path;
        const ext = (m.path.match(/\.([^./\\]+)$/) || [])[1];
        const f = ext && formats.find((x) => x.ext === ext.toLowerCase() || (x.id === 'srec' && /^(s19|s28|s37|mot)$/i.test(ext)));
        if (f) cfg.output.format = f.id;
        syncOutput();
        changed();
        break;
      }
      case 'state':
        cfg.inputs = m.inputs;
        cfg.policy = m.policy;
        cfg.steps = m.steps;
        Object.assign(cfg.output, m.output);
        stepList.set(cfg.steps);
        cfg.steps = stepList.get();
        renderInputs();
        syncOutput();
        changed();
        break;
      case 'steps':
        stepList.set(m.steps);
        cfg.steps = stepList.get();
        break;
      case 'preview': pv = m; renderPreview(); break;
      case 'generated': $('genInfo').textContent = '✓ ' + m.text; setTimeout(() => ($('genInfo').textContent = ''), 5000); break;
    }
  });

  syncOutput();
  renderInputs();
  post({ type: 'ready' });
})();

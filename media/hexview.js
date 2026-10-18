// Hex++ webview：单文件查看/编辑（mode = edit | view）与双文件对比（mode = compare）共用的虚拟滚动网格。
// 布局（Run 列表）、差异块由扩展侧计算，这里只负责渲染与交互。
// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const ROW = 16;
  const MAX_SCROLL_PX = 8000000;
  // @ts-ignore
  const t = window.HexppTools.t;
  const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0'));

  /** @type {any} */
  let S = null;
  let rowH = 20;
  let firstRow = 0;
  let dragging = false;

  // ---------------- 工具函数 ----------------
  function fmtAddr(a) {
    const h = a.toString(16).toUpperCase().padStart(8, '0');
    return h.length === 8 ? h.slice(0, 4) + '_' + h.slice(4) : h;
  }
  const hx = (a) => '0x' + a.toString(16).toUpperCase();
  const num = (n) => n.toLocaleString('en-US');
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function asciiOf(v) {
    if (v < 0) return ' ';
    // 0xAD 是软连字符，渲染宽度为 0，会使 ASCII 列错位
    if ((v >= 0x20 && v < 0x7f) || (v >= 0xa0 && v !== 0xad)) return esc(String.fromCharCode(v));
    return '.';
  }
  function post(msg) { vscode.postMessage(msg); }

  // 工具栏图标：16×16 线条图，颜色随 currentColor（CSP 不允许内联 style，只用 SVG 属性）
  const ICONS = {
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
    unlock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/>',
    insp: '<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 6h11M2.5 9.5h11M6.5 6v7.5"/>',
    sum: '<path d="M6.5 2.5 5 13.5M11 2.5 9.5 13.5M3 6h10.5M2.5 10h10.5"/>',
    patch: '<path d="M10.5 2.5l3 3-8 8h-3v-3z"/><path d="M9 4l3 3"/>',
    swap: '<path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/>',
    reload: '<path d="M13 8a5 5 0 1 1-1.46-3.54"/><path d="M13 2.5v3h-3"/>',
    down: '<path d="M8 2.5v11M3.5 9 8 13.5 12.5 9"/>',
    up: '<path d="M8 13.5v-11M3.5 7 8 2.5 12.5 7"/>',
    close: '<path d="M4 4l8 8M12 4l-8 8"/>',
    export: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M2.5 11.5v2h11v-2"/>',
    compare: '<rect x="2" y="2.5" width="5" height="11" rx="1"/><rect x="9" y="2.5" width="5" height="11" rx="1"/><path d="M3.5 6h2M10.5 6h2M3.5 9h2M10.5 9h2"/>',
    save: '<path d="M2.5 3.5a1 1 0 0 1 1-1h7l3 3v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M5 2.5v3h5v-3M5 13.5v-4h6v4"/>',
    process: '<rect x="2" y="2.5" width="4.5" height="4.5" rx=".5"/><rect x="9.5" y="9" width="4.5" height="4.5" rx=".5"/><path d="M6.5 4.75h3.25a2 2 0 0 1 2 2V9"/>',
  };
  const icon = (name) => `<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  /** 图标按钮；有 label 时工具栏宽裕时显示文字，紧凑时只剩图标 */
  const ibtn = (id, ic, title, label = '', attrs = '') =>
    `<button ${id ? `id="${id}" ` : ''}class="ib" title="${title}"${attrs}>${icon(ic)}${label ? `<span class="lbl">${label}</span>` : ''}</button>`;

  // ---------------- 数据访问 ----------------
  /** 第一个结束地址 > addr 的段下标 */
  function segFrom(segs, addr) {
    let lo = 0, hi = segs.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (segs[m].address + segs[m].data.length <= addr) lo = m + 1; else hi = m;
    }
    return lo;
  }
  /** 读取 [addr, addr+n) 的字节，空洞为 -1 */
  function bytesAt(side, addr, n) {
    const out = new Int16Array(n).fill(-1);
    const segs = S.sides[side].segs;
    for (let i = segFrom(segs, addr); i < segs.length; i++) {
      const s = segs[i];
      if (s.address >= addr + n) break;
      const a = Math.max(addr, s.address), b = Math.min(addr + n, s.address + s.data.length);
      for (let x = a; x < b; x++) out[x - addr] = s.data[x - s.address];
    }
    return out;
  }
  function writeLocal(side, addr, bytes) {
    const segs = S.sides[side].segs;
    for (let i = segFrom(segs, addr); i < segs.length; i++) {
      const s = segs[i];
      if (s.address >= addr + bytes.length) break;
      const a = Math.max(addr, s.address), b = Math.min(addr + bytes.length, s.address + s.data.length);
      for (let x = a; x < b; x++) s.data[x - s.address] = bytes[x - addr];
    }
  }

  // ---------------- 行布局 ----------------
  function setRuns(runs) {
    S.runs = runs;
    S.runStart = [];
    let n = 0;
    for (const r of runs) {
      S.runStart.push(n);
      n += r.kind === 'rows' ? r.count : 1;
    }
    S.total = n;
  }
  function runAt(row) {
    let lo = 0, hi = S.runs.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (S.runStart[m] <= row) lo = m; else hi = m - 1;
    }
    return lo;
  }
  /** 第 row 行：{kind:'rows', addr} 或 gap/fold 描述 */
  function rowInfo(row) {
    const i = runAt(row);
    const r = S.runs[i];
    return r.kind === 'rows' ? { kind: 'rows', addr: r.addr + (row - S.runStart[i]) * ROW } : r;
  }
  /** 地址所在（或其后第一个）行号 */
  function addrToRow(addr) {
    for (let i = 0; i < S.runs.length; i++) {
      const r = S.runs[i];
      if (r.kind === 'rows') {
        if (addr < r.addr) return S.runStart[i];
        if (addr < r.addr + r.count * ROW) return S.runStart[i] + Math.floor((addr - r.addr) / ROW);
      } else if (addr < r.to) {
        return S.runStart[i];
      }
    }
    return Math.max(0, S.total - 1);
  }
  function firstAddr() { const r = S.runs.find((x) => x.kind === 'rows'); return r ? r.addr : 0; }
  function lastAddr() {
    for (let i = S.runs.length - 1; i >= 0; i--) if (S.runs[i].kind === 'rows') return S.runs[i].addr + S.runs[i].count * ROW - S.unit;
    return 0;
  }

  // ---------------- 虚拟滚动 ----------------
  const scroller = $('scroller');
  const sticky = $('sticky');
  const spacer = $('spacer');
  const rowsEl = $('rows');
  const headEl = $('head');

  function viewRows() { return Math.max(1, Math.floor((scroller.clientHeight - headEl.offsetHeight) / rowH)); }
  function virtualHeight() { return Math.min(S.total * rowH, MAX_SCROLL_PX); }
  function layoutScroll() {
    const h = scroller.clientHeight;
    sticky.style.height = h + 'px';
    spacer.style.height = Math.max(0, virtualHeight() + headEl.offsetHeight - h + rowH) + 'px';
  }
  function rowFromScroll() {
    const maxFirst = Math.max(0, S.total - viewRows());
    if (S.total * rowH <= MAX_SCROLL_PX) return Math.min(maxFirst, Math.floor(scroller.scrollTop / rowH));
    const maxTop = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    return Math.round((scroller.scrollTop / maxTop) * maxFirst);
  }
  function scrollToRow(row) {
    const maxFirst = Math.max(0, S.total - viewRows());
    row = Math.max(0, Math.min(maxFirst, row));
    if (S.total * rowH <= MAX_SCROLL_PX) scroller.scrollTop = row * rowH;
    else scroller.scrollTop = (row / Math.max(1, maxFirst)) * (scroller.scrollHeight - scroller.clientHeight);
    firstRow = row;
    render();
  }
  /** 保证行可见；center 时居中偏上 */
  function revealRow(row, center) {
    const vr = viewRows();
    if (center) scrollToRow(row - Math.floor(vr / 3));
    else if (row < firstRow) scrollToRow(row);
    else if (row >= firstRow + vr) scrollToRow(row - vr + 1);
    else render();
  }
  scroller.addEventListener('scroll', () => {
    const r = rowFromScroll();
    if (r !== firstRow) { firstRow = r; render(); }
  });
  new ResizeObserver(() => { if (S) { layoutScroll(); render(); drawOverview(); } }).observe(scroller);

  // ---------------- 选区 ----------------
  function selRange() {
    const sel = S.sel;
    const a = Math.min(sel.anchor, sel.cursor), b = Math.max(sel.anchor, sel.cursor) + S.unit;
    return { start: a, end: b };
  }
  function postSel() {
    const r = selRange();
    post({ type: 'sel', side: S.sel.side, start: r.start, end: r.end, cursor: S.sel.cursor, unit: S.unit, le: S.le, ro: S.readOnly });
  }
  function setCursor(addr, extend, side) {
    if (side !== undefined && side !== S.sel.side) { S.sel.side = side; extend = false; }
    addr -= addr % S.unit;
    S.sel.cursor = addr;
    if (!extend) S.sel.anchor = addr;
    S.nib = 0;
    revealRow(addrToRow(addr), false);
    postSel();
    updateInspector();
    updateStatus();
  }

  // ---------------- 渲染 ----------------
  function render() {
    if (!S) return;
    layoutScroll();
    const vr = viewRows() + 1;
    const html = [];
    if (S.total === 0) {
      html.push(`<div class="empty">${S.mode === 'compare' ? (S.filter === 'diff' ? t('✔ The two files are identical (no differences).') : t('Both files have no data.')) : t('The file is empty.')}</div>`);
    }
    const sel = selRange();
    const blk = S.blocks && S.curBlock >= 0 ? S.blocks[S.curBlock] : null;
    for (let row = firstRow; row < Math.min(S.total, firstRow + vr); row++) {
      const info = rowInfo(row);
      if (info.kind === 'gap') {
        html.push(`<div class="gap">${t('··· No data {0} – {1} ({2} bytes) ···', fmtAddr(info.from), fmtAddr(info.to - 1), num(info.to - info.from))}</div>`);
        continue;
      }
      if (info.kind === 'fold') {
        html.push(`<div class="fold" data-fold="${info.from}" title="${t('Click to expand (switches to All and jumps there)')}">${t('⊞ Folded {0} – {1}: {2} identical bytes', fmtAddr(info.from), fmtAddr(info.to - 1), num(info.to - info.from))}</div>`);
        continue;
      }
      const addr = info.addr;
      const vals = S.sides.map((_, s) => bytesAt(s, addr, ROW));
      const cmp = S.mode === 'compare';
      let rowDiff = false;
      if (cmp) for (let i = 0; i < ROW; i++) if (vals[0][i] !== vals[1][i]) { rowDiff = true; break; }
      const inBlk = blk && blk.start < addr + ROW && blk.end > addr;
      let h = '<div class="row">';
      for (let s = 0; s < S.sides.length; s++) {
        h += renderSide(s, addr, vals[s], cmp ? vals[1 - s] : null, sel, rowDiff, inBlk);
      }
      html.push(h + '</div>');
    }
    rowsEl.innerHTML = html.join('');
    drawOverviewViewport();
  }

  function renderSide(s, addr, vals, other, sel, rowDiff, inBlk) {
    const u = S.unit;
    const isSelSide = s === S.sel.side;
    const fm = findMarks(s, addr);
    let h = `<span class="side"><span class="off${rowDiff ? ' rd' : ''}${inBlk ? ' cb' : ''}">${fmtAddr(addr)}</span><span class="hex">`;
    for (let i = 0; i < ROW; i += u) {
      let txt = '', present = false, diff = false, edited = false;
      for (let j = 0; j < u; j++) {
        const k = S.le ? i + u - 1 - j : i + j;
        const v = vals[k];
        txt += v < 0 ? '··' : HEX[v];
        if (v >= 0) present = true;
        if (other && v !== other[k]) diff = true;
        if (S.edited.has(addr + k) && s === 0) edited = true;
      }
      const a = addr + i;
      let cls = 'c';
      if (u === 1 && i === 7) cls += ' g';
      if (!present) cls += ' miss';
      if (diff) cls += ' d';
      if (edited) cls += ' e';
      if (fm && fm[i]) cls += ' f';
      if (isSelSide && a >= sel.start && a < sel.end) cls += ' s';
      if (a === S.sel.cursor) cls += isSelSide ? (S.ascii ? ' k2' : ' k') : ' k2';
      h += `<span class="${cls}" data-a="${a}" data-s="${s}">${txt}</span>`;
    }
    h += '</span><span class="asc">';
    for (let i = 0; i < ROW; i++) {
      const v = vals[i], a = addr + i;
      let cls = 'a';
      if (v < 0) cls += ' miss';
      if (other && v !== other[i]) cls += ' d';
      if (s === 0 && S.edited.has(a)) cls += ' e';
      if (fm && fm[i]) cls += ' f';
      if (isSelSide && a >= sel.start && a < sel.end) cls += ' s';
      if (isSelSide && S.ascii && a === S.sel.cursor) cls += ' k';
      h += `<span class="${cls}" data-a="${a}" data-s="${s}" data-x="1">${asciiOf(v)}</span>`;
    }
    return h + '</span></span>';
  }

  function renderHead() {
    const cols = [];
    for (let i = 0; i < ROW; i += S.unit) {
      const t = HEX[i].padStart(S.unit * 2, ' ');
      cols.push(`<span class="c${S.unit === 1 && i === 7 ? ' g' : ''}">${t}</span>`);
    }
    const colLine = `<span class="off">Offset</span><span class="hex">${cols.join('')}</span><span class="asc">${'0123456789ABCDEF'}</span>`;
    let h = '<div class="head">';
    S.sides.forEach((side) => {
      h += '<span class="headside">';
      if (S.mode === 'compare') {
        h += `<span class="file" title="${esc(side.path)}"><b>${esc(side.name)}</b>  <span class="meta">${esc(side.meta)}</span></span>`;
      }
      h += `<span class="side">${colLine}</span></span>`;
    });
    headEl.innerHTML = h + '</div>';
  }

  // ---------------- 对比概览条 ----------------
  const overview = /** @type {HTMLCanvasElement} */ ($('overview'));
  let overviewBase = null;
  function drawOverview() {
    if (!S || S.mode !== 'compare') return;
    const dpr = window.devicePixelRatio || 1;
    const H = overview.clientHeight, W = overview.clientWidth;
    overview.width = W * dpr; overview.height = H * dpr;
    const ctx = /** @type {CanvasRenderingContext2D} */ (overview.getContext('2d'));
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--diff-fg') || '#e51400';
    const total = Math.max(1, S.total);
    for (const b of S.blocks) {
      const r0 = addrToRow(b.start), r1 = addrToRow(b.end - 1);
      ctx.fillRect(1, (r0 / total) * H, W - 2, Math.max(2, ((r1 - r0 + 1) / total) * H));
    }
    overviewBase = ctx.getImageData(0, 0, overview.width, overview.height);
    drawOverviewViewport();
  }
  function drawOverviewViewport() {
    if (!S || S.mode !== 'compare' || !overviewBase) return;
    const ctx = /** @type {CanvasRenderingContext2D} */ (overview.getContext('2d'));
    const dpr = window.devicePixelRatio || 1;
    ctx.putImageData(overviewBase, 0, 0);
    const H = overview.clientHeight, W = overview.clientWidth, total = Math.max(1, S.total);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--vscode-foreground') || '#888';
    ctx.globalAlpha = 0.6;
    ctx.strokeRect(0.5, (firstRow / total) * H + 0.5, W - 1, Math.max(3, (viewRows() / total) * H) - 1);
    ctx.restore();
  }
  overview.addEventListener('mousedown', (e) => {
    const go = (/** @type {MouseEvent} */ ev) => {
      const y = ev.clientY - overview.getBoundingClientRect().top;
      scrollToRow(Math.floor((y / overview.clientHeight) * S.total - viewRows() / 2));
    };
    go(e);
    const mv = (/** @type {MouseEvent} */ ev) => go(ev);
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  });

  // ---------------- 鼠标 ----------------
  function cellOf(t) {
    const el = /** @type {HTMLElement} */ (t).closest('[data-a]');
    return el ? { addr: +(/** @type {string} */ (el.dataset.a)), side: +(/** @type {string} */ (el.dataset.s)), ascii: !!el.dataset.x } : null;
  }
  rowsEl.addEventListener('mousedown', (e) => {
    const fold = /** @type {HTMLElement} */ (e.target).closest('[data-fold]');
    if (fold) { setFilter('all'); goToAddr(+(/** @type {any} */ (fold).dataset.fold)); return; }
    const c = cellOf(e.target);
    if (!c || e.button !== 0) return;
    scroller.focus();
    S.ascii = c.ascii;
    setCursor(c.addr, e.shiftKey, c.side);
    dragging = true;
  });
  rowsEl.addEventListener('mousemove', (e) => {
    const c = cellOf(e.target);
    if (dragging && c && c.side === S.sel.side) {
      const a = c.addr - (c.addr % S.unit);
      if (a !== S.sel.cursor) { S.sel.cursor = a; render(); updateStatus(); }
    }
    if (c && !dragging) hoverTip(/** @type {HTMLElement} */ (e.target), c);
  });
  window.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; postSel(); updateInspector(); }
  });
  // 右键时若点在选区外，先把光标移过去，保证上下文菜单作用于所点位置
  rowsEl.addEventListener('contextmenu', (e) => {
    const c = cellOf(e.target);
    if (!c) return;
    const r = selRange();
    if (c.side !== S.sel.side || c.addr < r.start || c.addr >= r.end) setCursor(c.addr, false, c.side);
  });

  /** 悬停提示：该位置作为 u8/u16/u32 的值 */
  function hoverTip(el, c) {
    const b = bytesAt(c.side, c.addr, 4);
    if (b[0] < 0) { el.title = ''; return; }
    const parts = [`${fmtAddr(c.addr)}  u8=${b[0]}`];
    const n = (len) => {
      let v = 0;
      for (let i = 0; i < len; i++) { const x = b[S.le ? len - 1 - i : i]; if (x < 0) return null; v = v * 256 + x; }
      return v;
    };
    const u16 = n(2), u32 = n(4);
    if (u16 !== null) parts.push(`u16=${u16}`);
    if (u32 !== null) parts.push(`u32=${u32} (${hx(u32)})`);
    el.title = parts.join('  ');
  }

  // ---------------- 键盘 ----------------
  /** 按行移动 dRow 行（跳过空洞/折叠行），保持列 */
  function moveRows(dRow, extend) {
    const col = S.sel.cursor % ROW;
    let row = addrToRow(S.sel.cursor) + dRow;
    row = Math.max(0, Math.min(S.total - 1, row));
    const step = dRow >= 0 ? 1 : -1;
    let info = rowInfo(row);
    while (info.kind !== 'rows') {
      row += step;
      if (row < 0 || row >= S.total) return;
      info = rowInfo(row);
    }
    setCursor(info.addr + col, extend);
  }
  function moveCols(d, extend) {
    let a = S.sel.cursor + d * S.unit;
    const row = addrToRow(S.sel.cursor);
    const info = rowInfo(row);
    if (info.kind === 'rows' && (a < info.addr || a >= info.addr + ROW)) {
      // 换行：跳到相邻数据行的行首/行尾
      let r = row + (d > 0 ? 1 : -1);
      while (r >= 0 && r < S.total && rowInfo(r).kind !== 'rows') r += d > 0 ? 1 : -1;
      if (r < 0 || r >= S.total) return;
      const ni = rowInfo(r);
      a = d > 0 ? ni.addr : ni.addr + ROW - S.unit;
    }
    setCursor(a, extend);
  }

  scroller.addEventListener('keydown', (e) => {
    if (!S || S.total === 0) return;
    const ext = e.shiftKey;
    const ctrl = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case 'ArrowLeft': moveCols(-1, ext); break;
      case 'ArrowRight': moveCols(1, ext); break;
      case 'ArrowUp': moveRows(-1, ext); break;
      case 'ArrowDown': moveRows(1, ext); break;
      case 'PageUp': moveRows(-viewRows(), ext); break;
      case 'PageDown': moveRows(viewRows(), ext); break;
      case 'Home': ctrl ? setCursor(firstAddr(), ext) : setCursor(S.sel.cursor - (S.sel.cursor % ROW), ext); break;
      case 'End': ctrl ? setCursor(lastAddr(), ext) : setCursor(S.sel.cursor - (S.sel.cursor % ROW) + ROW - S.unit, ext); break;
      case 'Escape':
        if (findOpen()) { closeFind(); break; }
        S.sel.anchor = S.sel.cursor; render(); postSel(); updateStatus(); break;
      case 'Tab': S.ascii = !S.ascii; S.nib = 0; render(); break;
      default:
        if (ctrl && e.key.toLowerCase() === 'a') { selectRange(firstAddr(), lastAddr() + S.unit); break; }
        if (!ctrl && !e.altKey && e.key.length === 1 && typeEdit(e.key)) break;
        return;
    }
    e.preventDefault();
  });

  /** 直接在网格中改写：hex 区按半字节输入（2/4 字节单元按显示的字节序），ASCII 区按字符输入 */
  function typeEdit(ch) {
    if (S.mode !== 'edit') return false;
    if (S.readOnly) { flash(t('Read-only mode: press Insert to switch to Read/Write')); return true; }
    const u = S.unit, U = S.sel.cursor;
    if (S.ascii) {
      if (u !== 1) { flash(t('Switch to 1-byte units to type in the ASCII area')); return true; }
      const code = ch.charCodeAt(0);
      if (code > 0xff) return true;
      if (applyEdit(U, [code])) moveCols(1, false);
      return true;
    }
    const d = parseInt(ch, 16);
    if (isNaN(d)) return false;
    const di = S.nib >> 1;
    const a = U + (S.le ? u - 1 - di : di);
    const old = bytesAt(0, a, 1)[0];
    if (old < 0) { flash(t('No data at this address; cannot edit')); return true; }
    const nv = S.nib % 2 === 0 ? (d << 4) | (old & 0x0f) : (old & 0xf0) | d;
    applyEdit(a, [nv]);
    const nib = S.nib + 1;
    if (nib >= u * 2) moveCols(1, false);
    else { S.nib = nib; S.sel.anchor = S.sel.cursor; render(); }
    return true;
  }
  function applyEdit(addr, data) {
    if (bytesAt(0, addr, data.length).some((v) => v < 0)) return false;
    writeLocal(0, addr, data);
    data.forEach((_, i) => S.edited.add(addr + i));
    post({ type: 'edit', addr, data });
    render();
    updateInspector();
    return true;
  }

  // 复制：拦截 Ctrl+C（VS Code 会在 webview 内触发 copy 事件），交给扩展按配置格式转换
  document.addEventListener('copy', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t && (t.tagName === 'INPUT' || t.closest('#panel'))) return;
    e.preventDefault();
    postSel();
    post({ type: 'copy' });
  });

  // ---------------- 跳转 / 选择范围 ----------------
  const gotoInput = () => /** @type {HTMLInputElement} */ ($('goto'));
  /** 解析地址：默认十六进制；#123 为十进制；+/- 为相对光标偏移 */
  function parseAddr(text) {
    let t = text.trim().replace(/_/g, '');
    if (!t) return NaN;
    let rel = 0;
    if (t[0] === '+' || t[0] === '-') { rel = t[0] === '+' ? 1 : -1; t = t.slice(1).trim(); }
    let v;
    if (t[0] === '#') v = /^\d+$/.test(t.slice(1)) ? parseInt(t.slice(1), 10) : NaN;
    else v = /^(0x)?[0-9a-f]+h?$/i.test(t) ? parseInt(t.replace(/^0x/i, '').replace(/h$/i, ''), 16) : NaN;
    return rel ? S.sel.cursor + rel * v : v;
  }
  function goToAddr(addr) {
    S.ascii = false;
    setCursor(addr, false);
    revealRow(addrToRow(addr), true);
  }
  function selectRange(start, end) {
    if (end <= start) return;
    S.sel.anchor = start - (start % S.unit);
    const last = end - S.unit;
    S.sel.cursor = Math.max(S.sel.anchor, last - (last % S.unit));
    revealRow(addrToRow(start), false);
    postSel();
    updateInspector();
    updateStatus();
  }

  // ---------------- 单元 / 字节序 / 只读 ----------------
  function setUnit(u) {
    S.unit = u;
    S.sel.anchor -= S.sel.anchor % u;
    S.sel.cursor -= S.sel.cursor % u;
    S.nib = 0;
    document.querySelectorAll('[data-unit]').forEach((b) => b.classList.toggle('on', +(/** @type {any} */ (b).dataset.unit) === u));
    renderHead();
    render();
    updateStatus();
    postSel();
  }
  function setLe(le) {
    S.le = le;
    const eb = $('endian');
    eb.textContent = le ? 'LE' : 'BE';
    eb.title = t('Byte order for 2/4-byte units and the inspector') + ': ' + (le ? t('Little-endian') : t('Big-endian'));
    render();
    updateInspector();
    postSel();
    requestSum();
  }
  function setReadOnly(ro) {
    S.readOnly = ro;
    const b = $('ro');
    if (b) {
      b.innerHTML = icon(ro ? 'lock' : 'unlock') + `<span class="lbl">${ro ? t('Read-only') : t('Read/Write')}</span>`;
      b.classList.toggle('on', !ro);
      fitToolbar();
    }
    updateStatus();
    postSel();
  }

  // ---------------- 查找（流式） ----------------
  let findToken = 0;
  function findMarks(side, addr) {
    const res = S.find.results;
    if (!res.length || side !== S.find.side) return null;
    let lo = 0, hi = res.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (res[m].addr + res[m].len <= addr) lo = m + 1; else hi = m; }
    let marks = null;
    for (let i = lo; i < res.length && res[i].addr < addr + ROW; i++) {
      marks = marks || new Uint8Array(ROW);
      for (let x = Math.max(addr, res[i].addr); x < Math.min(addr + ROW, res[i].addr + res[i].len); x++) {
        marks[x - addr] = 1;
        marks[(x - addr) - ((x - addr) % S.unit)] = 1;
      }
    }
    return marks;
  }
  function parseHexPattern(text) {
    const out = [];
    for (const tok of text.trim().split(/[\s,]+/)) {
      if (!tok) continue;
      if (tok === '*' || tok === '??') { out.push(-1); continue; }
      const t = tok.replace(/^0x/i, '');
      if (!/^([0-9a-f]{2})+$/i.test(t)) return null;
      for (let i = 0; i < t.length; i += 2) out.push(parseInt(t.substr(i, 2), 16));
    }
    return out.length ? out : null;
  }
  async function runFind() {
    const token = ++findToken;
    const text = /** @type {HTMLInputElement} */ ($('findText')).value;
    const mode = /** @type {HTMLSelectElement} */ ($('findMode')).value;
    const cs = $('findCase').classList.contains('on');
    const side = S.sel.side;
    S.find = { results: [], idx: -1, side };
    if (!text) { findInfo(''); render(); return; }
    let matcher;
    if (mode === 'regex') {
      try { matcher = new RegExp(text, cs ? 'g' : 'gi'); } catch (err) { findInfo(t('Invalid regex'), true); return; }
    } else {
      let pat = mode === 'hex' ? parseHexPattern(text) : Array.from(text, (c) => c.charCodeAt(0) & 0xff);
      if (!pat) { findInfo(t('Invalid hex'), true); return; }
      if (mode === 'text' && !cs) pat = pat.map((c) => (c >= 0x41 && c <= 0x5a ? c + 32 : c));
      matcher = pat;
    }
    const fold = mode === 'text' && !cs;
    const LIMIT = 100000;
    let last = performance.now();
    for (const seg of S.sides[side].segs) {
      const d = seg.data;
      if (Array.isArray(matcher)) {
        const pat = matcher, n = pat.length;
        for (let i = 0; i + n <= d.length; i++) {
          let ok = true;
          for (let j = 0; j < n; j++) {
            const p = pat[j];
            if (p < 0) continue;
            let v = d[i + j];
            if (fold && v >= 0x41 && v <= 0x5a) v += 32;
            if (v !== p) { ok = false; break; }
          }
          if (ok) S.find.results.push({ addr: seg.address + i, len: n });
          if ((i & 0xffff) === 0 && performance.now() - last > 30) {
            findInfo(t('{0} matches…', num(S.find.results.length)));
            await new Promise((r) => setTimeout(r));
            last = performance.now();
            if (token !== findToken) return;
          }
          if (S.find.results.length >= LIMIT) break;
        }
      } else {
        let str = '';
        for (let i = 0; i < d.length; i += 0x8000) str += String.fromCharCode.apply(null, Array.from(d.subarray(i, i + 0x8000)));
        matcher.lastIndex = 0;
        let m;
        while ((m = matcher.exec(str)) && S.find.results.length < LIMIT) {
          S.find.results.push({ addr: seg.address + m.index, len: Math.max(1, m[0].length) });
          if (m[0].length === 0) matcher.lastIndex++;
          if (performance.now() - last > 30) {
            findInfo(t('{0} matches…', num(S.find.results.length)));
            await new Promise((r) => setTimeout(r));
            last = performance.now();
            if (token !== findToken) return;
          }
        }
      }
      if (S.find.results.length >= LIMIT) break;
    }
    findInfo(S.find.results.length ? t('{0} matches', num(S.find.results.length) + (S.find.results.length >= LIMIT ? '+' : '')) : t('No results'), !S.find.results.length);
    if (S.find.results.length) findStep(1, true);
    else render();
  }
  function findStep(dir, fromCursor) {
    const res = S.find.results;
    if (!res.length) return;
    let i;
    if (fromCursor || S.find.idx < 0) {
      const c = S.sel.cursor;
      i = dir > 0 ? res.findIndex((r) => r.addr >= c) : res.length - 1 - [...res].reverse().findIndex((r) => r.addr < c);
      if (i < 0 || i >= res.length) i = dir > 0 ? 0 : res.length - 1;
    } else {
      i = (S.find.idx + dir + res.length) % res.length;
    }
    S.find.idx = i;
    const r = res[i];
    findInfo(`${num(i + 1)}/${num(res.length)}`);
    S.sel.side = S.find.side;
    S.ascii = false;
    selectRange(r.addr, r.addr + r.len);
    revealRow(addrToRow(r.addr), true);
  }
  let findTimer = 0;

  // ---------------- 查找框 ----------------
  const findEl = $('findWidget');
  const findText = () => /** @type {HTMLInputElement} */ ($('findText'));
  function findInfo(text, bad = false) {
    const el = $('findInfo');
    el.textContent = text;
    el.classList.toggle('bad', bad);
  }
  function findOpen() { return !findEl.classList.contains('hidden'); }
  function openFind() {
    findEl.classList.remove('hidden');
    const b = document.getElementById('findBtn');
    if (b) b.classList.add('on');
    findText().focus();
    findText().select();
    if (findText().value && !S.find.results.length) runFind();
  }
  /** 关闭时同 VS Code：清掉匹配高亮，保留输入文本，下次打开重新查找 */
  function closeFind() {
    findEl.classList.add('hidden');
    const b = document.getElementById('findBtn');
    if (b) b.classList.remove('on');
    findToken++;
    clearTimeout(findTimer);
    S.find = { results: [], idx: -1, side: S.sel.side };
    findInfo('');
    render();
    scroller.focus();
  }
  function buildFind() {
    findEl.innerHTML = `<select id="findMode" title="${t('Find mode')}"><option value="hex">Hex</option><option value="text">${t('Text')}</option><option value="regex">${t('Regex')}</option></select>
      <input id="findText" placeholder="${t('Find')}" title="${t('Hex mode: DE AD * EF; * or ?? matches any byte')}">
      <button id="findCase" class="ib" title="${t('Match case')}">Aa</button><span id="findInfo"></span>
      ${ibtn('findPrev', 'up', t('Previous (Shift+Enter)'))}${ibtn('findNext', 'down', t('Next (Enter)'))}${ibtn('findClose', 'close', t('Close (Escape)'))}`;
    findText().addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 250); });
    findText().addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1, false); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    $('findMode').addEventListener('change', runFind);
    $('findCase').addEventListener('click', () => { $('findCase').classList.toggle('on'); runFind(); });
    $('findPrev').addEventListener('click', () => findStep(-1, false));
    $('findNext').addEventListener('click', () => findStep(1, false));
    $('findClose').addEventListener('click', closeFind);
  }
  buildFind();

  // ---------------- 数据检查器 ----------------
  function updateInspector() {
    const el = $('inspector');
    if (!S || !panelOpen() || tab !== 'insp') return;
    const b = bytesAt(S.sel.side, S.sel.cursor, 8);
    const n = b.findIndex((v) => v < 0);
    const avail = n < 0 ? 8 : n;
    const buf = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < avail; i++) buf.setUint8(i, b[i]);
    const le = S.le;
    const rows = [[t('Address'), `${fmtAddr(S.sel.cursor)} (${num(S.sel.cursor)})`]];
    if (avail >= 1) {
      rows.push(['Binary', b[0].toString(2).padStart(8, '0')]);
      rows.push(['Int8', String(buf.getInt8(0))], ['Uint8', String(buf.getUint8(0))]);
    }
    if (avail >= 2) rows.push(['Int16', String(buf.getInt16(0, le))], ['Uint16', `${buf.getUint16(0, le)}  (${hx(buf.getUint16(0, le))})`]);
    if (avail >= 4) {
      rows.push(['Int32', String(buf.getInt32(0, le))], ['Uint32', `${buf.getUint32(0, le)}  (${hx(buf.getUint32(0, le))})`]);
      rows.push(['Float', String(buf.getFloat32(0, le))]);
    }
    if (avail >= 8) {
      rows.push(['Int64', String(buf.getBigInt64(0, le))], ['Uint64', String(buf.getBigUint64(0, le))]);
      rows.push(['Double', String(buf.getFloat64(0, le))]);
    }
    if (avail === 0) rows.push(['', t('(no data)')]);
    el.innerHTML = `<h4>${t('Data Inspector')} · ${le ? t('Little-endian') : t('Big-endian')}</h4><table>${rows.map((r) => `<tr><td>${r[0]}</td><td>${esc(r[1])}</td></tr>`).join('')}</table>`;
  }

  // ---------------- 侧面板：检查器 / 校验 / 补丁 ----------------
  // @ts-ignore
  const UI = window.HexppTools;
  const panelEl = $('panel');
  const TAB_NAMES = { insp: t('Inspector'), sum: t('Checksum'), patch: t('Patch') };
  let tab = 'insp';
  /** 校验页状态；scope: sel 选区 / all 全部 / custom 自定义 */
  const T = { note: '', algos: [], selected: new Set(), custom: {}, canPatch: false, scope: 'sel', skip: false, fill: 'FF', start: '', end: '', req: 0, timer: 0, big: false };
  /** @type {any} */
  let patchList = null;
  let patchTimer = 0;
  const ui = Object.assign({ open: false, tab: 'insp', w: 300 }, vscode.getState() || {});
  function saveUi() {
    vscode.setState({ open: panelOpen(), tab, w: panelEl.offsetWidth || ui.w, scope: T.scope, skip: T.skip, fill: T.fill, start: T.start, end: T.end });
  }

  function panelOpen() { return !panelEl.classList.contains('hidden'); }
  function tabsFor() { return S.mode === 'compare' ? ['insp', 'sum'] : ['insp', 'sum', 'patch']; }
  function showTab(t, toggle) {
    if (!S || !tabsFor().includes(t)) return;
    if (toggle && panelOpen() && tab === t) panelEl.classList.add('hidden');
    else { tab = t; panelEl.classList.remove('hidden'); }
    const open = panelOpen();
    $('inspector').classList.toggle('hidden', tab !== 'insp');
    $('sumPane').classList.toggle('hidden', tab !== 'sum');
    $('patchPane').classList.toggle('hidden', tab !== 'patch');
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', open && /** @type {any} */ (b).dataset.tab === tab));
    if (open && tab === 'insp') updateInspector();
    if (open && tab === 'sum') requestSum(true);
    if (open && tab === 'patch' && T.canPatch) post({ type: 'patchPreview' });
    saveUi();
  }
  function buildTabs() {
    $('tabs').innerHTML = tabsFor().map((t) => `<button data-tab="${t}">${TAB_NAMES[t]}</button>`).join('') +
      '<span class="spacer"></span><button id="panelClose" title="' + t('Close panel') + '">✕</button>';
    $('tabs').querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(/** @type {any} */ (b).dataset.tab, false)));
    $('panelClose').addEventListener('click', () => { panelEl.classList.add('hidden'); document.querySelectorAll('[data-tab]').forEach((b) => b.classList.remove('on')); saveUi(); });
  }
  $('resizer').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const right = panelEl.getBoundingClientRect().right;
    const mv = (/** @type {MouseEvent} */ ev) => { panelEl.style.width = Math.max(240, Math.min(720, right - ev.clientX)) + 'px'; };
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); saveUi(); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  });

  function initTools(tools, first) {
    T.algos = tools.algos;
    T.canPatch = tools.canPatch;
    if (first) {
      T.selected = new Set(tools.selected);
      T.custom = tools.custom;
      T.scope = ui.scope || 'sel';
      T.skip = !!ui.skip;
      T.fill = ui.fill || tools.fill;
      T.start = ui.start || '';
      T.end = ui.end || '';
      panelEl.style.width = ui.w + 'px';
      buildTabs();
      buildSumPane();
      buildPatchPane();
      if (patchList) patchList.set(tools.patches);
      if (ui.open) showTab(tabsFor().includes(ui.tab) ? ui.tab : 'insp', false);
    } else if (panelOpen()) {
      showTab(tab, false);
    }
  }

  // ---------- 校验 ----------
  const hexStr = (a) => a.toString(16).toUpperCase().padStart(8, '0').replace(/^(.{4})(.{4})$/, '$1_$2');
  function sumRange() {
    const segs = S.sides[S.sel.side].segs;
    const all = () => segs.length ? { start: hexStr(segs[0].address), end: hexStr(segs[segs.length - 1].address + segs[segs.length - 1].data.length - 1), note: '' } : null;
    if (T.scope === 'custom') return { start: T.start, end: T.end, note: '' };
    if (T.scope === 'sel') {
      const r = selRange();
      if (r.end - r.start > S.unit) return { start: hexStr(r.start), end: hexStr(r.end - 1), note: '' };
      const a = all();
      return a && { ...a, note: t('No selection; using all') };
    }
    return all();
  }
  function buildSumPane() {
    const el = $('sumPane');
    el.innerHTML = `<div class="tsec">
        <div class="frow"><label>${t('Range')}</label><div class="fctl"><span class="seg sm" id="sumScope"><button data-v="sel">${t('Selection')}</button><button data-v="all">${t('All')}</button><button data-v="custom">${t('Custom')}</button></span></div></div>
        <div class="frow"><label></label><div class="fctl"><span class="pair"><input id="sumStart" class="mono" placeholder="${t('Start')}" spellcheck="false"><span class="dash">–</span><input id="sumEnd" class="mono" placeholder="${t('End (incl.) or +length')}" spellcheck="false"></span></div></div>
        <div class="frow"><label>${t('Gaps')}</label><div class="fctl"><span class="seg sm" id="sumHoles"><button data-v="fill">${t('Fill')}</button><button data-v="skip">${t('Skip')}</button></span><input id="sumFill" class="mono byte" spellcheck="false" title="${t('Fill byte (hex)')}"></div></div>
      </div>
      <div class="tsec grow">
        <div class="thead"><span>${t('Results')}</span><span class="spacer"></span><button id="sumAlgoBtn" class="sm" title="${t('Choose the algorithms to compute')}">${t('Algorithm ▾')}</button></div>
        <div id="sumAlgos" class="algos hidden"></div>
        <div id="sumList" class="results"></div>
        <div id="sumInfo" class="tinfo"></div>
      </div>`;
    const startEl = /** @type {HTMLInputElement} */ ($('sumStart')), endEl = /** @type {HTMLInputElement} */ ($('sumEnd'));
    $('sumScope').addEventListener('click', (e) => {
      const b = /** @type {HTMLElement} */ (e.target).closest('button');
      if (!b) return;
      if (b.dataset.v === 'custom' && T.scope !== 'custom' && !T.start) { const r = sumRange(); if (r) { T.start = r.start; T.end = r.end; } }
      T.scope = /** @type {string} */ (b.dataset.v);
      syncSumForm();
      requestSum(true);
      saveUi();
    });
    $('sumHoles').addEventListener('click', (e) => {
      const b = /** @type {HTMLElement} */ (e.target).closest('button');
      if (!b) return;
      T.skip = b.dataset.v === 'skip';
      syncSumForm();
      requestSum(true);
      saveUi();
    });
    const onInput = () => { T.start = startEl.value; T.end = endEl.value; T.fill = /** @type {HTMLInputElement} */ ($('sumFill')).value; requestSum(true); saveUi(); };
    [startEl, endEl, $('sumFill')].forEach((x) => x.addEventListener('input', onInput));
    $('sumAlgoBtn').addEventListener('click', () => { $('sumAlgos').classList.toggle('hidden'); $('sumAlgoBtn').classList.toggle('on'); });
    buildAlgoChooser();
    $('sumList').addEventListener('click', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      const res = /** @type {HTMLElement | null} */ (t.closest('.res'));
      if (!res) return;
      const val = /** @type {HTMLElement} */ (res.querySelector('.rval')).textContent || '';
      if (t.closest('[data-write]')) addChecksumPatch(/** @type {string} */ (res.dataset.id));
      else if (t.closest('[data-big]')) requestSum(true, true);
      else if (val && !res.classList.contains('bad')) post({ type: 'clipboard', text: val });
    });
    syncSumForm();
  }
  /** 算法分组 id（扩展侧为英文）→ 显示名 */
  function groupLabel(g) {
    return g === 'Checksum' ? t('Checksums') : g === 'Hash' ? t('Hash') : g;
  }
  function buildAlgoChooser() {
    const groups = [];
    for (const a of T.algos) {
      let g = groups.find((x) => x.name === a.group);
      if (!g) groups.push((g = { name: a.group, list: [] }));
      g.list.push(a);
    }
    const c = T.custom;
    const cin = (k, ph) => `<label><span>${ph}</span><input data-c="${k}" class="mono" value="${UI.esc(c[k])}" spellcheck="false"></label>`;
    $('sumAlgos').innerHTML = groups.map((g) => `<div class="agroup"><div class="aglabel">${groupLabel(g.name)}</div>${g.list.map((a) =>
      `<label class="chk" title="${UI.esc(a.note || '')}"><input type="checkbox" data-algo="${a.id}"${T.selected.has(a.id) ? ' checked' : ''}><span>${UI.esc(a.name)}</span>${a.note ? `<span class="muted">${UI.esc(a.note)}</span>` : ''}</label>`).join('')}</div>`).join('') +
      `<div class="crcp${T.selected.has('custom') ? '' : ' hidden'}" id="crcParams">${cin('width', t('Width'))}${cin('poly', t('Polynomial'))}${cin('init', t('Init'))}${cin('xorout', t('XOR out'))}
        <label class="chk"><input type="checkbox" data-c="refin"${c.refin ? ' checked' : ''}><span>${t('Reflect input')}</span></label><label class="chk"><input type="checkbox" data-c="refout"${c.refout ? ' checked' : ''}><span>${t('Reflect output')}</span></label></div>`;
    const el = $('sumAlgos');
    const changed = () => { post({ type: 'toolsState', selected: [...T.selected], custom: T.custom }); requestSum(true); };
    el.addEventListener('change', (e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      if (t.dataset.algo) {
        t.checked ? T.selected.add(t.dataset.algo) : T.selected.delete(t.dataset.algo);
        $('crcParams').classList.toggle('hidden', !T.selected.has('custom'));
      } else if (t.dataset.c) T.custom[t.dataset.c] = t.type === 'checkbox' ? t.checked : t.value;
      changed();
    });
    el.addEventListener('input', (e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      if (t.dataset.c && t.type !== 'checkbox') { T.custom[t.dataset.c] = t.value; changed(); }
    });
  }
  function syncSumForm() {
    const custom = T.scope === 'custom';
    $('sumScope').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === T.scope));
    $('sumHoles').querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'skip') === T.skip));
    const startEl = /** @type {HTMLInputElement} */ ($('sumStart')), endEl = /** @type {HTMLInputElement} */ ($('sumEnd'));
    startEl.readOnly = endEl.readOnly = !custom;
    startEl.classList.toggle('ro', !custom);
    endEl.classList.toggle('ro', !custom);
    if (custom) { startEl.value = T.start; endEl.value = T.end; }
    const f = /** @type {HTMLInputElement} */ ($('sumFill'));
    f.value = T.fill;
    f.classList.toggle('hidden', T.skip);
  }
  /** 请求计算（去抖）；force 缩短等待，big 为用户确认计算大范围 */
  function requestSum(force, big) {
    if (!S || !panelOpen() || tab !== 'sum') return;
    clearTimeout(T.timer);
    T.timer = setTimeout(() => {
      const r = sumRange();
      if (!r) { $('sumList').innerHTML = `<div class="cempty">${t('No data available')}</div>`; $('sumInfo').textContent = ''; return; }
      if (T.scope !== 'custom') {
        /** @type {HTMLInputElement} */ ($('sumStart')).value = r.start;
        /** @type {HTMLInputElement} */ ($('sumEnd')).value = r.end;
      }
      const ids = T.algos.map((a) => a.id).filter((id) => T.selected.has(id));
      if (!ids.length) { $('sumList').innerHTML = `<div class="cempty">${t('Click Algorithm ▾ to choose the algorithms to compute')}</div>`; $('sumInfo').textContent = ''; return; }
      // 空洞填充且范围很大时（如 Flash 与 RAM 段相距很远）需要确认后再算
      const span = parseInt(r.end.replace(/_/g, ''), 16) - parseInt(r.start.replace(/_/g, ''), 16) + 1;
      if (!big && !T.skip && span > 64 * 1024 * 1024 && T.scope !== 'custom') {
        $('sumList').innerHTML = `<div class="res big" data-id=""><div class="rname">${t('Range is about {0} MB (includes a large gap)', num(Math.round(span / 1048576)))}</div><div class="rval"></div><div class="ract show"><button data-big>${t('Compute anyway')}</button></div></div>`;
        $('sumInfo').textContent = t('Switch gaps to Skip, or use a custom range');
        return;
      }
      T.req++;
      T.note = r.note;
      $('sumInfo').classList.add('busy');
      post({ type: 'checksum', req: T.req, side: S.sel.side, algos: ids, start: r.start, end: r.end, skip: T.skip, fill: T.fill, le: S.le });
    }, force ? 30 : 150);
  }
  function onSumResult(m) {
    if (m.req !== T.req) return;
    const info = $('sumInfo');
    info.classList.remove('busy');
    ['sumStart', 'sumEnd', 'sumFill'].forEach((id) => $(id).classList.remove('bad'));
    if (m.error) {
      info.innerHTML = `<span class="err">✕ ${UI.esc(m.error)}</span>`;
      const f = { start: 'sumStart', end: 'sumEnd', fill: 'sumFill' }[m.field];
      if (f) $(f).classList.add('bad');
      return;
    }
    const canWrite = T.canPatch && S.mode === 'edit';
    $('sumList').innerHTML = m.results.map((r) => `<div class="res${r.error ? ' bad' : ''}" data-id="${r.id}">
        <div class="rname">${UI.esc(r.name)}</div>
        <div class="rval mono" title="${r.error ? '' : t('Click to copy')}">${UI.esc(r.error || r.text)}</div>
        <div class="ract">${r.error ? '' : `<button data-copy title="${t('Copy')}">${t('Copy')}</button>${canWrite ? `<button data-write title="${t('Create a Write Patch with this algorithm and range')}">${t('Write…')}</button>` : ''}`}</div>
      </div>`).join('');
    const side = S.mode === 'compare' ? (S.sel.side === 0 ? t('Left') : t('Right')) + ' · ' : '';
    const holes = m.end - m.start - m.count;
    info.textContent = `${side}${fmtAddr(m.start)} – ${fmtAddr(m.end - 1)} · ${t('{0} bytes', num(m.count))}` +
      (holes > 0 ? ' ' + t('(gaps skipped: {0})', num(holes)) : '') + ` · ${m.ms} ms` + (T.note ? ` · ${T.note}` : '');
  }
  function addChecksumPatch(algo) {
    const r = sumRange();
    if (!r || !patchList) return;
    const after = parseInt(r.end.replace(/_/g, ''), 16) + 1;
    showTab('patch', false);
    patchList.add(Object.assign(UI.patchDefaults('checksum', { algo, start: r.start, end: r.end, address: hexStr(after), fill: T.fill }), { holes: T.skip ? 'skip' : 'fill' }));
    flash(t('Patch added: the write address defaults to just after the range; adjust as needed'));
  }

  // ---------- 补丁 ----------
  function buildPatchPane() {
    const el = $('patchPane');
    if (!T.canPatch) {
      el.innerHTML = `<div class="cempty">${S.mode === 'view' ? t('The read-only viewer cannot write.<br>Open the file with "Hex++ Editor" to apply patches,<br>or add a "Write Patch" step in "Process…" to generate a new file.') : t('Patches are not supported in this view.')}</div>`;
      return;
    }
    el.innerHTML = `<div class="thead"><button id="patchAdd" class="sm accent" title="${t('Add patch')}">${t('+ Add')}</button><span class="spacer"></span>
        <button id="patchImport" class="sm" title="${t('Import a patch recipe from JSON')}">${t('Import')}</button><button id="patchExport" class="sm" title="${t('Export as JSON for team sharing or batch processing')}">${t('Export')}</button></div>
      <div id="patchList"></div>
      <div class="tfoot"><button id="patchApply" class="primary" title="${t('Write all enabled patches in order (Ctrl+Enter)')}">${t('Apply patches')}</button><span class="muted">${t('Written in order; can be undone in one step')}</span></div>`;
    patchList = UI.cardList($('patchList'), {
      title: (p) => UI.patchTitle(p, T.algos),
      fields: (p) => UI.patchFields(p, '', T.algos),
      empty: t('No patches yet.<br>Click "+ Add", or click "Write…" next to a result on the Checksum tab.<br><span class="muted">Patch recipes are saved per file automatically.</span>'),
      onChange: (list) => { clearTimeout(patchTimer); patchTimer = setTimeout(() => post({ type: 'patchSave', patches: list }), 200); },
    });
    $('patchAdd').addEventListener('click', () => UI.menu($('patchAdd'), UI.PATCH_KINDS.map(([k, l]) => [k, l, PATCH_HINT[k]]), (kind) => {
      const r = selRange();
      const hasSel = r.end - r.start > S.unit;
      const ctx = kind === 'checksum' && hasSel
        ? { start: hexStr(r.start), end: hexStr(r.end - 1), address: hexStr(r.end), fill: T.fill }
        : { address: hexStr(r.start), fill: T.fill };
      patchList.add(UI.patchDefaults(kind, ctx));
    }));
    $('patchImport').addEventListener('click', () => post({ type: 'patchImport' }));
    $('patchExport').addEventListener('click', () => post({ type: 'patchExport' }));
    $('patchApply').addEventListener('click', applyPatches);
    el.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); applyPatches(); } });
  }
  const PATCH_HINT = { checksum: t('CRC / checksum / hash'), number: t('u8 / u16 / u32 constants'), serial: t('Auto-increments after applying'), time: t('Unix / BCD / text'), text: t('Version string, etc.'), bytes: t('Arbitrary hex bytes') };
  function applyPatches() {
    clearTimeout(patchTimer);
    post({ type: 'patchApply', ro: S.readOnly, patches: patchList.get() });
  }

  // ---------------- 状态栏 ----------------
  let flashTimer = 0;
  function flash(msg) {
    const el = $('flash');
    el.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (el.textContent = ''), 3000);
  }
  function updateStatus() {
    if (!S) return;
    const r = selRange();
    const side = S.sides[S.sel.side];
    const parts = [t('Offset {0} ({1})', fmtAddr(S.sel.cursor), num(S.sel.cursor))];
    if (r.end - r.start > S.unit) parts.push(t('Selected {0} bytes [{1} – {2}]', num(r.end - r.start), fmtAddr(r.start), fmtAddr(r.end - 1)));
    parts.push(side.info);
    if (S.mode === 'edit') parts.push(`<span class="ro">${S.readOnly ? t('Read-only') : t('Read/Write')}</span>`);
    if (S.mode === 'view') parts.push(t('Read-only view'));
    const warns = S.sides.reduce((n, s) => n + s.warnings.length, 0);
    if (warns) parts.push(`<span class="warn" id="warnLink" title="${t('Click to view')}">${t('⚠ {0} parse warnings', warns)}</span>`);
    parts.push('<span id="flash"></span>');
    $('status').innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
    const w = document.getElementById('warnLink');
    if (w) w.onclick = () => post({ type: 'showWarnings' });
    if (T.scope === 'sel') requestSum();
  }

  // ---------------- 对比：过滤与导航 ----------------
  function setFilter(f) {
    if (S.mode !== 'compare' || S.filter === f) return;
    const keep = rowInfo(firstRow);
    S.filter = f;
    setRuns(S.layouts[f]);
    document.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('on', /** @type {any} */ (b).dataset.filter === f));
    if (keep && keep.kind === 'rows') firstRow = addrToRow(keep.addr);
    drawOverview();
    scrollToRow(firstRow);
  }
  function gotoBlock(dir) {
    const bl = S.blocks;
    if (!bl.length) { flash(t('There are no differences')); return; }
    let i;
    if (S.curBlock < 0) {
      const c = S.sel.cursor;
      i = dir > 0 ? bl.findIndex((b) => b.start > c) : bl.length - 1 - [...bl].reverse().findIndex((b) => b.end <= c);
      if (i < 0 || i >= bl.length) i = dir > 0 ? 0 : bl.length - 1;
    } else {
      i = S.curBlock + dir;
      if (i < 0 || i >= bl.length) { flash(dir > 0 ? t('Already at the last difference') : t('Already at the first difference')); return; }
    }
    S.curBlock = i;
    const b = bl[i];
    S.ascii = false;
    S.sel.anchor = S.sel.cursor = b.start - (b.start % S.unit);
    postSel();
    revealRow(addrToRow(b.start), true);
    updateDiffInfo();
    updateStatus();
    updateInspector();
  }
  function updateDiffInfo() {
    const el = document.getElementById('diffInfo');
    if (!el) return;
    const n = S.blocks.length;
    el.textContent = n === 0 ? t('No differences') : t('Difference {0}/{1} · {2} bytes', S.curBlock >= 0 ? S.curBlock + 1 : '-', num(n), num(S.diffBytes));
    /** @type {HTMLButtonElement} */ ($('prev')).disabled = n === 0;
    /** @type {HTMLButtonElement} */ ($('next')).disabled = n === 0;
    fitToolbar();
  }

  // ---------------- 工具栏 ----------------
  // 单行：左侧是视图设置（对比模式另有差异导航），右侧是查找、侧面板开关与文件操作。
  // 查找在网格右上角的浮动查找框里。
  function buildToolbar(mode) {
    const grp = (html, cls = '') => `<span class="grp${cls}">${html}</span>`;
    const tabBtn = (tab, ic, title) => ibtn('', ic, title, TAB_NAMES[tab], ` data-tab="${tab}"`);
    const view = grp(`<input id="goto" placeholder="${t('Go to (Ctrl+G)')}" title="${t('Hex address: 0800_1000 / 0x1000; #4096 for decimal; +10/-10 for relative offset (Ctrl+G)')}">`)
      + grp(`<span class="seg" title="${t('Display unit (Ctrl+1/2/4)')}"><button data-unit="1">1</button><button data-unit="2">2</button><button data-unit="4">4</button></span>
        <button id="endian"></button>${mode === 'edit' ? `<button id="ro" class="ib" title="${t('Toggle Read-only / Read/Write (Insert)')}"></button>` : ''}`);
    const findBtn = ibtn('findBtn', 'search', t('Find (Ctrl+F)'));
    let h;
    if (mode === 'compare') {
      h = grp(`<span class="seg"><button data-filter="all" title="${t('Show all data')}">${t('All')}</button><button data-filter="diff" title="${t('Show only differences (identical regions folded)')}">${t('Differences')}</button></span>
        ${ibtn('prev', 'up', t('Previous difference (Shift+F8)'))}${ibtn('next', 'down', t('Next difference (F8)'))}<span id="diffInfo"></span>`)
        + grp(ibtn('swap', 'swap', t('Swap left and right'), t('Swap')) + ibtn('reload', 'reload', t('Reload from disk (F5)'), t('Reload')))
        + view
        + grp(findBtn + tabBtn('insp', 'insp', t('Data Inspector')) + tabBtn('sum', 'sum', t('CRC / checksum / hash (current side)')), ' end')
        + grp(ibtn('report', 'export', t('Export HTML comparison report'), t('Export report')));
    } else {
      h = view
        + grp(findBtn + tabBtn('insp', 'insp', t('Data Inspector')) + tabBtn('sum', 'sum', t('CRC / checksum / hash'))
          + tabBtn('patch', 'patch', t('Write checksums, version numbers, timestamps, serial numbers')), ' end')
        + grp(ibtn('cmpBtn', 'compare', t('Compare with another file'), t('Compare…')) + ibtn('saveAs', 'save', t('Save as another format'), t('Save As…'))
          + ibtn('procBtn', 'process', t('Merge / offset / crop / fill / split to produce a new file'), t('Process…')));
    }
    $('toolbar').innerHTML = `<div class="tb">${h}</div>`;
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('cmpBtn', () => post({ type: 'compareWith' }));
    on('saveAs', () => post({ type: 'saveAs' }));
    on('procBtn', () => post({ type: 'process' }));
    on('next', () => gotoBlock(1));
    on('prev', () => gotoBlock(-1));
    on('swap', () => post({ type: 'swap' }));
    on('reload', () => post({ type: 'reload' }));
    on('report', () => post({ type: 'report' }));
    on('ro', () => setReadOnly(!S.readOnly));
    on('findBtn', () => (findOpen() ? closeFind() : openFind()));
    $('findBtn').classList.toggle('on', findOpen());
    document.querySelectorAll('#toolbar [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(/** @type {any} */ (b).dataset.tab, true)));
    document.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => { setUnit(+(/** @type {any} */ (b).dataset.unit)); scroller.focus(); }));
    $('endian').addEventListener('click', () => setLe(!S.le));
    gotoInput().addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const a = parseAddr(gotoInput().value);
        if (isNaN(a) || a < 0) { flash(t('Invalid address format, e.g. 0800_1000, 0x1000, #4096, +100')); return; }
        goToAddr(a);
        scroller.focus();
      } else if (e.key === 'Escape') scroller.focus();
    });
    document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => setFilter(/** @type {any} */ (b).dataset.filter)));
  }
  /** 工具栏放不下时逐级收紧：先隐藏图标按钮的文字，仍放不下再允许换行 */
  function fitToolbar() {
    const tb = document.querySelector('#toolbar .tb');
    if (!tb) return;
    tb.classList.remove('compact', 'wrap');
    if (tb.scrollWidth > tb.clientWidth) tb.classList.add('compact');
    if (tb.scrollWidth > tb.clientWidth) tb.classList.add('wrap');
  }
  window.addEventListener('resize', fitToolbar);
  function toggleInspector() { showTab('insp', true); }

  // ---------------- 消息 ----------------
  let toolbarMode = '';
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'init': init(m); break;
      case 'update':
        writeLocal(0, m.addr, m.data);
        for (let i = 0; i < m.data.length; i++) m.flags[i] ? S.edited.add(m.addr + i) : S.edited.delete(m.addr + i);
        render(); updateInspector(); requestSum(); break;
      case 'saved': S.edited.clear(); render(); break;
      case 'setUnit': setUnit(m.unit); break;
      case 'goto': gotoInput().focus(); gotoInput().select(); break;
      case 'find': openFind(); break;
      case 'selectRange': selectRange(m.start, m.end); break;
      case 'toggleReadOnly': if (S.mode === 'edit') { setReadOnly(!S.readOnly); flash(S.readOnly ? t('Switched to Read-only') : t('Switched to Read/Write')); } break;
      case 'toggleInspector': toggleInspector(); break;
      case 'next': gotoBlock(1); break;
      case 'prev': gotoBlock(-1); break;
      case 'flash': flash(m.text); break;
      case 'checksumResult': onSumResult(m); break;
      case 'patchPreview': if (patchList) patchList.preview(m.results); break;
      case 'patches': if (patchList) patchList.set(m.patches); break;
      case 'setReadOnly': setReadOnly(m.ro); break;
      case 'openTab': showTab(m.tab, false); break;
    }
  });

  function init(m) {
    const prev = S;
    const keepAddr = prev && prev.total ? (() => { const r = rowInfo(firstRow); return r.kind === 'rows' ? r.addr : r.from; })() : null;
    if (toolbarMode !== m.mode) { buildToolbar(m.mode); toolbarMode = m.mode; }
    S = {
      mode: m.mode,
      sides: m.sides,
      unit: prev ? prev.unit : m.unit,
      le: prev ? prev.le : m.le,
      readOnly: prev ? prev.readOnly : m.readOnly,
      filter: prev && m.mode === 'compare' ? prev.filter : (m.filter || 'all'),
      layouts: m.layouts,
      blocks: m.blocks || [],
      diffBytes: m.diffBytes || 0,
      curBlock: -1,
      sel: prev ? prev.sel : { side: 0, anchor: 0, cursor: 0 },
      nib: 0,
      ascii: false,
      edited: new Set(m.edited || []),
      find: { results: [], idx: -1, side: 0 },
    };
    if (S.sel.side >= S.sides.length) S.sel.side = 0;
    setRuns(S.layouts[S.mode === 'compare' ? S.filter : 'all']);
    if (!prev) S.sel.anchor = S.sel.cursor = firstAddr();
    $('overview').style.display = S.mode === 'compare' ? '' : 'none';
    document.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('on', /** @type {any} */ (b).dataset.filter === S.filter));
    measureRow();
    setUnit(S.unit);
    setLe(S.le);
    setReadOnly(S.readOnly);
    updateDiffInfo();
    updateStatus();
    drawOverview();
    firstRow = keepAddr !== null ? addrToRow(keepAddr) : 0;
    scrollToRow(firstRow);
    if (prev && findOpen() && findText().value) runFind();
    fitToolbar();
    initTools(m.tools, !prev);
    if (!prev) scroller.focus();
  }
  function measureRow() {
    rowsEl.innerHTML = '<div class="row"><span class="side"><span class="off">0</span></span></div>';
    rowH = /** @type {HTMLElement} */ (rowsEl.firstChild).getBoundingClientRect().height || 20;
  }

  post({ type: 'ready' });
})();

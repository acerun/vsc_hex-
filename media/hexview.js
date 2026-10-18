// Hex++ webview：单文件查看/编辑（mode = edit | view）与双文件对比（mode = compare）共用的虚拟滚动网格。
// 布局（Run 列表）、差异块由扩展侧计算，这里只负责渲染与交互。
// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const ROW = 16;
  const MAX_SCROLL_PX = 8000000;
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
      html.push(`<div class="empty">${S.mode === 'compare' ? (S.filter === 'diff' ? '✔ 两个文件内容完全相同（无差异）。' : '两个文件均无数据。') : '文件为空。'}</div>`);
    }
    const sel = selRange();
    const blk = S.blocks && S.curBlock >= 0 ? S.blocks[S.curBlock] : null;
    for (let row = firstRow; row < Math.min(S.total, firstRow + vr); row++) {
      const info = rowInfo(row);
      if (info.kind === 'gap') {
        html.push(`<div class="gap">··· 无数据 ${fmtAddr(info.from)} – ${fmtAddr(info.to - 1)}（${num(info.to - info.from)} 字节）···</div>`);
        continue;
      }
      if (info.kind === 'fold') {
        html.push(`<div class="fold" data-fold="${info.from}" title="点击展开（切换到“全部”并跳转）">⊞ 已折叠 ${fmtAddr(info.from)} – ${fmtAddr(info.to - 1)}：${num(info.to - info.from)} 字节相同</div>`);
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
      case 'Escape': S.sel.anchor = S.sel.cursor; render(); postSel(); updateStatus(); break;
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
    if (S.readOnly) { flash('只读模式：按 Insert 切换为读写'); return true; }
    const u = S.unit, U = S.sel.cursor;
    if (S.ascii) {
      if (u !== 1) { flash('请切换到 1 字节单元后在 ASCII 区输入'); return true; }
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
    if (old < 0) { flash('该地址无数据，不能编辑'); return true; }
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
    $('endian').textContent = le ? '小端 LE' : '大端 BE';
    render();
    updateInspector();
    postSel();
    requestSum();
  }
  function setReadOnly(ro) {
    S.readOnly = ro;
    const b = $('ro');
    if (b) { b.textContent = ro ? '🔒 只读' : '✎ 读写'; b.classList.toggle('on', !ro); }
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
    if (!text) { $('findInfo').textContent = ''; render(); return; }
    let matcher;
    if (mode === 'regex') {
      try { matcher = new RegExp(text, cs ? 'g' : 'gi'); } catch (err) { $('findInfo').textContent = '正则无效'; return; }
    } else {
      let pat = mode === 'hex' ? parseHexPattern(text) : Array.from(text, (c) => c.charCodeAt(0) & 0xff);
      if (!pat) { $('findInfo').textContent = 'Hex 无效'; return; }
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
            $('findInfo').textContent = `${num(S.find.results.length)} 个…`;
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
            $('findInfo').textContent = `${num(S.find.results.length)} 个…`;
            await new Promise((r) => setTimeout(r));
            last = performance.now();
            if (token !== findToken) return;
          }
        }
      }
      if (S.find.results.length >= LIMIT) break;
    }
    $('findInfo').textContent = S.find.results.length ? `${num(S.find.results.length)}${S.find.results.length >= LIMIT ? '+' : ''} 个` : '无结果';
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
    $('findInfo').textContent = `${num(i + 1)}/${num(res.length)}`;
    S.sel.side = S.find.side;
    S.ascii = false;
    selectRange(r.addr, r.addr + r.len);
    revealRow(addrToRow(r.addr), true);
  }
  let findTimer = 0;

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
    const rows = [['地址', `${fmtAddr(S.sel.cursor)} (${num(S.sel.cursor)})`]];
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
    if (avail === 0) rows.push(['', '（无数据）']);
    el.innerHTML = `<h4>数据检查器 · ${le ? '小端' : '大端'}</h4><table>${rows.map((r) => `<tr><td>${r[0]}</td><td>${esc(r[1])}</td></tr>`).join('')}</table>`;
  }

  // ---------------- 侧面板：检查器 / 校验 / 补丁 ----------------
  // @ts-ignore
  const UI = window.HexppTools;
  const panelEl = $('panel');
  const TAB_NAMES = { insp: '检查器', sum: '校验', patch: '补丁' };
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
      '<span class="spacer"></span><button id="panelClose" title="关闭面板">✕</button>';
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
      return a && { ...a, note: '无选区，按全部计算' };
    }
    return all();
  }
  function buildSumPane() {
    const el = $('sumPane');
    el.innerHTML = `<div class="tsec">
        <div class="frow"><label>范围</label><div class="fctl"><span class="seg sm" id="sumScope"><button data-v="sel">选区</button><button data-v="all">全部</button><button data-v="custom">自定义</button></span></div></div>
        <div class="frow"><label></label><div class="fctl"><span class="pair"><input id="sumStart" class="mono" placeholder="起始" spellcheck="false"><span class="dash">–</span><input id="sumEnd" class="mono" placeholder="结束(含) 或 +长度" spellcheck="false"></span></div></div>
        <div class="frow"><label>空洞</label><div class="fctl"><span class="seg sm" id="sumHoles"><button data-v="fill">填充</button><button data-v="skip">跳过</button></span><input id="sumFill" class="mono byte" spellcheck="false" title="填充字节（十六进制）"></div></div>
      </div>
      <div class="tsec grow">
        <div class="thead"><span>结果</span><span class="spacer"></span><button id="sumAlgoBtn" class="sm" title="选择要计算的算法">算法 ▾</button></div>
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
  function buildAlgoChooser() {
    const groups = [];
    for (const a of T.algos) {
      let g = groups.find((x) => x.name === a.group);
      if (!g) groups.push((g = { name: a.group, list: [] }));
      g.list.push(a);
    }
    const c = T.custom;
    const cin = (k, ph) => `<label><span>${ph}</span><input data-c="${k}" class="mono" value="${UI.esc(c[k])}" spellcheck="false"></label>`;
    $('sumAlgos').innerHTML = groups.map((g) => `<div class="agroup"><div class="aglabel">${g.name}</div>${g.list.map((a) =>
      `<label class="chk" title="${UI.esc(a.note || '')}"><input type="checkbox" data-algo="${a.id}"${T.selected.has(a.id) ? ' checked' : ''}><span>${UI.esc(a.name)}</span>${a.note ? `<span class="muted">${UI.esc(a.note)}</span>` : ''}</label>`).join('')}</div>`).join('') +
      `<div class="crcp${T.selected.has('custom') ? '' : ' hidden'}" id="crcParams">${cin('width', '宽度')}${cin('poly', '多项式')}${cin('init', '初值')}${cin('xorout', '结果异或')}
        <label class="chk"><input type="checkbox" data-c="refin"${c.refin ? ' checked' : ''}><span>输入反转</span></label><label class="chk"><input type="checkbox" data-c="refout"${c.refout ? ' checked' : ''}><span>输出反转</span></label></div>`;
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
      if (!r) { $('sumList').innerHTML = '<div class="cempty">没有数据</div>'; $('sumInfo').textContent = ''; return; }
      if (T.scope !== 'custom') {
        /** @type {HTMLInputElement} */ ($('sumStart')).value = r.start;
        /** @type {HTMLInputElement} */ ($('sumEnd')).value = r.end;
      }
      const ids = T.algos.map((a) => a.id).filter((id) => T.selected.has(id));
      if (!ids.length) { $('sumList').innerHTML = '<div class="cempty">点击「算法 ▾」选择要计算的算法</div>'; $('sumInfo').textContent = ''; return; }
      // 空洞填充且范围很大时（如 Flash 与 RAM 段相距很远）需要确认后再算
      const span = parseInt(r.end.replace(/_/g, ''), 16) - parseInt(r.start.replace(/_/g, ''), 16) + 1;
      if (!big && !T.skip && span > 64 * 1024 * 1024 && T.scope !== 'custom') {
        $('sumList').innerHTML = `<div class="res big" data-id=""><div class="rname">范围约 ${num(Math.round(span / 1048576))} MB（含大段空洞）</div><div class="rval"></div><div class="ract show"><button data-big>仍然计算</button></div></div>`;
        $('sumInfo').textContent = '可改为「跳过」空洞，或用自定义范围';
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
        <div class="rval mono" title="${r.error ? '' : '点击复制'}">${UI.esc(r.error || r.text)}</div>
        <div class="ract">${r.error ? '' : `<button data-copy title="复制">复制</button>${canWrite ? '<button data-write title="以此算法和范围新建写入补丁">写入…</button>' : ''}`}</div>
      </div>`).join('');
    const side = S.mode === 'compare' ? (S.sel.side === 0 ? '左侧 · ' : '右侧 · ') : '';
    const holes = m.end - m.start - m.count;
    info.textContent = `${side}${fmtAddr(m.start)} – ${fmtAddr(m.end - 1)} · ${num(m.count)} 字节` +
      (holes > 0 ? `（跳过空洞 ${num(holes)}）` : '') + ` · ${m.ms} ms` + (T.note ? ` · ${T.note}` : '');
  }
  function addChecksumPatch(algo) {
    const r = sumRange();
    if (!r || !patchList) return;
    const after = parseInt(r.end.replace(/_/g, ''), 16) + 1;
    showTab('patch', false);
    patchList.add(Object.assign(UI.patchDefaults('checksum', { algo, start: r.start, end: r.end, address: hexStr(after), fill: T.fill }), { holes: T.skip ? 'skip' : 'fill' }));
    flash('已添加补丁：写入地址默认为范围之后，请按需修改');
  }

  // ---------- 补丁 ----------
  function buildPatchPane() {
    const el = $('patchPane');
    if (!T.canPatch) {
      el.innerHTML = `<div class="cempty">${S.mode === 'view' ? '只读查看器不能写入。<br>用「Hex++ Editor」打开文件后再应用补丁，<br>或在「加工…」中添加「写入补丁」步骤生成新文件。' : '当前视图不支持补丁。'}</div>`;
      return;
    }
    el.innerHTML = `<div class="thead"><button id="patchAdd" class="sm accent" title="添加补丁">＋ 添加</button><span class="spacer"></span>
        <button id="patchImport" class="sm" title="从 JSON 导入补丁方案">导入</button><button id="patchExport" class="sm" title="导出为 JSON，便于团队共享或批量处理">导出</button></div>
      <div id="patchList"></div>
      <div class="tfoot"><button id="patchApply" class="primary" title="按顺序写入全部启用的补丁 (Ctrl+Enter)">应用补丁</button><span class="muted">按顺序写入，可一次撤销</span></div>`;
    patchList = UI.cardList($('patchList'), {
      title: (p) => UI.patchTitle(p, T.algos),
      fields: (p) => UI.patchFields(p, '', T.algos),
      empty: '还没有补丁。<br>点击「＋ 添加」，或在「校验」页点结果旁的「写入…」。<br><span class="muted">补丁方案按文件自动保存。</span>',
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
  const PATCH_HINT = { checksum: 'CRC / 校验和 / 哈希', number: 'u8 / u16 / u32 常量', serial: '应用后自动递增', time: 'Unix / BCD / 文本', text: '版本字符串等', bytes: '任意十六进制字节' };
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
    const parts = [`偏移 ${fmtAddr(S.sel.cursor)} (${num(S.sel.cursor)})`];
    if (r.end - r.start > S.unit) parts.push(`选中 ${num(r.end - r.start)} 字节 [${fmtAddr(r.start)} – ${fmtAddr(r.end - 1)}]`);
    parts.push(side.info);
    if (S.mode === 'edit') parts.push(`<span class="ro">${S.readOnly ? '只读' : '读写'}</span>`);
    if (S.mode === 'view') parts.push('只读视图');
    const warns = S.sides.reduce((n, s) => n + s.warnings.length, 0);
    if (warns) parts.push(`<span class="warn" id="warnLink" title="点击查看">⚠ ${warns} 个解析警告</span>`);
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
    if (!bl.length) { flash('没有差异'); return; }
    let i;
    if (S.curBlock < 0) {
      const c = S.sel.cursor;
      i = dir > 0 ? bl.findIndex((b) => b.start > c) : bl.length - 1 - [...bl].reverse().findIndex((b) => b.end <= c);
      if (i < 0 || i >= bl.length) i = dir > 0 ? 0 : bl.length - 1;
    } else {
      i = S.curBlock + dir;
      if (i < 0 || i >= bl.length) { flash(dir > 0 ? '已是最后一个差异' : '已是第一个差异'); return; }
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
    el.textContent = n === 0 ? '无差异' : `差异 ${S.curBlock >= 0 ? S.curBlock + 1 : '-'}/${num(n)} · ${num(S.diffBytes)} 字节`;
    /** @type {HTMLButtonElement} */ ($('prev')).disabled = n === 0;
    /** @type {HTMLButtonElement} */ ($('next')).disabled = n === 0;
  }

  // ---------------- 工具栏 ----------------
  function buildToolbar(mode) {
    const unitSeg = `<span class="seg" title="显示单元 (Ctrl+1/2/4)"><button data-unit="1">1</button><button data-unit="2">2</button><button data-unit="4">4</button></span>`;
    const common = `<label>Go To</label><input id="goto" placeholder="地址 (hex)" title="十六进制地址：0800_1000 / 0x1000；#4096 为十进制；+10/-10 为相对偏移 (Ctrl+G)">
      <span class="sep"></span>${unitSeg}<button id="endian" title="2/4 字节单元与检查器的字节序"></button>`;
    const find = `<span class="sep"></span><select id="findMode" title="查找方式"><option value="hex">Hex</option><option value="text">文本</option><option value="regex">正则</option></select>
      <input id="findText" placeholder="查找 (Ctrl+F)" title="Hex 模式：DE AD * EF，* 或 ?? 匹配任意字节"><button id="findCase" title="区分大小写">Aa</button>
      <button id="findPrev" title="上一个 (Shift+Enter)">▲</button><button id="findNext" title="下一个 (Enter)">▼</button><span id="findInfo"></span>`;
    let h;
    if (mode === 'compare') {
      h = `<span class="seg"><button data-filter="all" title="显示全部数据">✱ 全部</button><button data-filter="diff" title="只显示差异（相同区域折叠）">≠ 差异</button></span>
        <span class="sep"></span><button id="next" title="下一个差异 (F8)">⬇ 下一个</button><button id="prev" title="上一个差异 (Shift+F8)">⬆ 上一个</button><span id="diffInfo"></span>
        <span class="sep"></span><button id="swap" title="交换左右">⇄ 交换</button><button id="reload" title="从磁盘重新加载 (F5)">⟳ 重载</button>
        <span class="sep"></span>${common}${find}<span class="spacer"></span>
        <span class="seg"><button data-tab="insp" title="数据检查器">检查器</button><button data-tab="sum" title="CRC / 校验和 / 哈希（当前一侧）">校验</button></span>
        <button id="report" title="导出 HTML 对比报告">导出报告</button>`;
    } else {
      h = `${common}${mode === 'edit' ? '<button id="ro" title="切换只读/读写 (Insert)"></button>' : ''}${find}
        <span class="spacer"></span>
        <span class="seg"><button data-tab="insp" title="数据检查器">检查器</button><button data-tab="sum" title="CRC / 校验和 / 哈希">校验</button><button data-tab="patch" title="写入校验值、版本号、时间戳、序列号">补丁</button></span>
        <button id="procBtn" title="合并 / 偏移 / 裁剪 / 填充 / 拆分，生成新文件">加工…</button><button id="saveAs" title="另存为其他格式">另存为…</button><button id="cmpBtn" title="与另一个文件比较">比较…</button>`;
    }
    $('toolbar').innerHTML = h;
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('next', () => gotoBlock(1));
    on('prev', () => gotoBlock(-1));
    on('swap', () => post({ type: 'swap' }));
    on('reload', () => post({ type: 'reload' }));
    on('report', () => post({ type: 'report' }));
    on('saveAs', () => post({ type: 'saveAs' }));
    on('cmpBtn', () => post({ type: 'compareWith' }));
    on('ro', () => setReadOnly(!S.readOnly));
    on('procBtn', () => post({ type: 'process' }));
    document.querySelectorAll('#toolbar [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(/** @type {any} */ (b).dataset.tab, true)));
    document.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => { setUnit(+(/** @type {any} */ (b).dataset.unit)); scroller.focus(); }));
    $('endian').addEventListener('click', () => setLe(!S.le));
    gotoInput().addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const a = parseAddr(gotoInput().value);
        if (isNaN(a) || a < 0) { flash('地址格式无效：如 0800_1000、0x1000、#4096、+100'); return; }
        goToAddr(a);
        scroller.focus();
      } else if (e.key === 'Escape') scroller.focus();
    });
    $('findText').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 250); });
    $('findText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1, false); }
      else if (e.key === 'Escape') scroller.focus();
    });
    $('findMode').addEventListener('change', runFind);
    $('findCase').addEventListener('click', () => { $('findCase').classList.toggle('on'); runFind(); });
    $('findPrev').addEventListener('click', () => findStep(-1, false));
    $('findNext').addEventListener('click', () => findStep(1, false));
    document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => setFilter(/** @type {any} */ (b).dataset.filter)));
  }
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
      case 'find': { const f = /** @type {HTMLInputElement} */ ($('findText')); f.focus(); f.select(); break; }
      case 'selectRange': selectRange(m.start, m.end); break;
      case 'toggleReadOnly': if (S.mode === 'edit') { setReadOnly(!S.readOnly); flash(S.readOnly ? '已切换为只读' : '已切换为读写'); } break;
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
    if (prev && /** @type {HTMLInputElement} */ ($('findText')).value) runFind();
    initTools(m.tools, !prev);
    if (!prev) scroller.focus();
  }
  function measureRow() {
    rowsEl.innerHTML = '<div class="row"><span class="side"><span class="off">0</span></span></div>';
    rowH = /** @type {HTMLElement} */ (rowsEl.firstChild).getBoundingClientRect().height || 20;
  }

  post({ type: 'ready' });
})();

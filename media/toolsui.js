// 工具界面组件：编辑器侧面板（补丁）与固件加工面板（步骤）共用的卡片列表、表单字段与弹出菜单。
// 字段值保存用户输入的原始文本，解析与校验由扩展侧完成，结果通过 preview() 回显到卡片上。
// @ts-check
(function () {
  const esc = (/** @type {any} */ s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
  function fmtAddr(a) {
    const h = a.toString(16).toUpperCase().padStart(8, '0');
    return h.length === 8 ? h.slice(0, 4) + '_' + h.slice(4) : h;
  }
  /** 地址文本的规范显示：能解析就格式化为 0000_0000，否则原样 */
  function showAddr(t) {
    const s = String(t ?? '').trim().replace(/_/g, '').replace(/^0x/i, '');
    return /^[0-9a-f]{1,8}$/i.test(s) ? fmtAddr(parseInt(s, 16)) : esc(t || '?');
  }

  // ---------------- 表单片段 ----------------
  const input = (k, v, ph, cls = '') =>
    `<input data-k="${k}" value="${esc(v)}" placeholder="${esc(ph)}" class="${cls}" spellcheck="false">`;
  const seg = (k, v, opts) =>
    `<span class="seg sm" data-seg="${k}">${opts.map(([ov, l]) => `<button data-v='${esc(JSON.stringify(ov))}' class="${ov === v ? 'on' : ''}">${l}</button>`).join('')}</span>`;
  function select(k, v, groups, re) {
    let h = `<select data-k="${k}"${re ? ' data-re="1"' : ''}>`;
    for (const g of groups) {
      if (g.label) h += `<optgroup label="${esc(g.label)}">`;
      for (const [ov, l] of g.items) h += `<option value="${esc(ov)}"${ov === v ? ' selected' : ''}>${esc(l)}</option>`;
      if (g.label) h += '</optgroup>';
    }
    return h + '</select>';
  }
  const row = (label, html) => `<div class="frow"><label>${label}</label><div class="fctl">${html}</div></div>`;
  const rangeRow = (pre, o, label = '范围') =>
    row(label, `<span class="pair">${input(pre + 'start', o.start, '起始', 'mono')}<span class="dash">–</span>${input(pre + 'end', o.end, '结束(含) 或 +长度', 'mono')}</span>`);

  function algoGroups(algos) {
    const groups = [];
    for (const a of algos) {
      let g = groups.find((x) => x.label === a.group);
      if (!g) groups.push((g = { label: a.group, items: [] }));
      g.items.push([a.id, a.name]);
    }
    return groups;
  }

  // ---------------- 补丁 ----------------
  const PATCH_KINDS = [
    ['checksum', '校验值'], ['number', '数值'], ['serial', '序列号'], ['time', '时间戳'], ['text', '文本'], ['bytes', '字节序列'],
  ];
  const TIME_FORMATS = { unix: 'Unix 秒 (u32)', bcd: 'BCD YYYYMMDDhhmmss', ascii: '文本模板' };

  function patchDefaults(kind, ctx = {}) {
    const base = { kind, enabled: true, open: true, address: ctx.address || '' };
    switch (kind) {
      case 'checksum': return { ...base, algo: ctx.algo || 'crc32', start: ctx.start || '', end: ctx.end || '', holes: 'fill', fill: ctx.fill || 'FF', le: true };
      case 'number': return { ...base, size: 4, value: '0x00000000', le: true };
      case 'serial': return { ...base, size: 4, value: '1', step: '1', le: true };
      case 'time': return { ...base, timeFormat: 'unix', template: 'YYYY-MM-DD hh:mm:ss', le: true };
      case 'text': return { ...base, value: '', length: '' };
      default: return { ...base, value: '' };
    }
  }

  function patchFields(p, pre, algos) {
    const k = (n) => pre + n;
    const kind = row('类型', select(k('kind'), p.kind, [{ items: PATCH_KINDS }], true));
    const addr = row('写入地址', input(k('address'), p.address, '如 0801_FFFC', 'mono'));
    const endian = row('字节序', seg(k('le'), p.le !== false, [[true, '小端'], [false, '大端']]));
    const size = row('大小', seg(k('size'), p.size || 4, [[1, 'u8'], [2, 'u16'], [4, 'u32']]));
    switch (p.kind) {
      case 'checksum': {
        const info = algos.find((a) => a.id === p.algo);
        return kind + row('算法', select(k('algo'), p.algo, algoGroups(algos), true)) + rangeRow(pre, p) +
          row('空洞', seg(k('holes'), p.holes || 'fill', [['fill', '填充'], ['skip', '跳过']]) +
            (p.holes === 'skip' ? '' : input(k('fill'), p.fill ?? 'FF', 'FF', 'mono byte'))) +
          addr + (info && !info.numeric ? '' : endian);
      }
      case 'number':
        return kind + size + row('值', input(k('value'), p.value, '十进制，或 0x 十六进制', 'mono')) + addr + endian;
      case 'serial':
        return kind + size + row('当前值', input(k('value'), p.value, '应用后自动递增', 'mono')) +
          row('步长', input(k('step'), p.step, '1', 'mono')) + addr + endian;
      case 'time':
        return kind + row('格式', select(k('timeFormat'), p.timeFormat || 'unix', [{ items: Object.entries(TIME_FORMATS) }], true)) +
          (p.timeFormat === 'ascii' ? row('模板', input(k('template'), p.template, 'YYYY YY MM DD hh mm ss', 'mono')) : '') +
          addr + (p.timeFormat === 'unix' || !p.timeFormat ? endian : '');
      case 'text':
        return kind + row('文本', input(k('value'), p.value, 'UTF-8，如 v1.2.3')) +
          row('固定长度', input(k('length'), p.length, '可空；不足补 00', 'mono')) + addr;
      default:
        return kind + row('字节', input(k('value'), p.value, 'DE AD BE EF', 'mono')) + addr;
    }
  }

  function patchTitle(p, algos) {
    const to = `<span class="arrow">→</span><span class="mono">${showAddr(p.address)}</span>`;
    switch (p.kind) {
      case 'checksum': {
        const a = algos.find((x) => x.id === p.algo);
        return `<b>${esc(a ? a.name : '校验值')}</b> ${to}<span class="muted mono"> ${showAddr(p.start)}–${esc(p.end || '?')}</span>`;
      }
      case 'number': return `<b>u${(p.size || 4) * 8}</b> <span class="mono">${esc(p.value)}</span> ${to}`;
      case 'serial': return `<b>序列号</b> <span class="mono">${esc(p.value)}</span><span class="muted"> (+${esc(p.step || '1')})</span> ${to}`;
      case 'time': return `<b>时间戳</b> <span class="muted">${esc(TIME_FORMATS[p.timeFormat || 'unix'])}</span> ${to}`;
      case 'text': return `<b>文本</b> “${esc(p.value)}” ${to}`;
      default: return `<b>字节</b> <span class="mono">${esc(p.value)}</span> ${to}`;
    }
  }

  // ---------------- 加工步骤 ----------------
  const STEP_OPS = [
    ['offset', '地址偏移'], ['moveTo', '移动到地址'], ['crop', '裁剪（保留范围）'], ['remove', '删除范围'],
    ['fill', '填充'], ['align', '段对齐'], ['patch', '写入补丁'],
  ];
  const stepLabel = (op) => (STEP_OPS.find((x) => x[0] === op) || [op, op])[1];

  function stepDefaults(op, ctx = {}) {
    const base = { op, enabled: true, open: true };
    switch (op) {
      case 'offset': return { ...base, value: '+0' };
      case 'moveTo': return { ...base, value: ctx.start || '0800_0000' };
      case 'crop': case 'remove': return { ...base, start: ctx.start || '', end: ctx.end || '' };
      case 'fill': return { ...base, start: ctx.start || '', end: ctx.end || '', byte: 'FF', mode: 'holes' };
      case 'align': return { ...base, value: '0x800', byte: 'FF' };
      default: return { ...base, patch: patchDefaults('checksum', ctx) };
    }
  }

  function stepFields(s, algos) {
    const byte = row('填充字节', input('byte', s.byte ?? 'FF', 'FF', 'mono byte'));
    switch (s.op) {
      case 'offset': return row('偏移量', input('value', s.value, '+0800_0000 / -1000（十六进制）', 'mono'));
      case 'moveTo': return row('起始地址', input('value', s.value, '整体移动，使首字节位于此地址', 'mono'));
      case 'crop': case 'remove': return rangeRow('', s);
      case 'fill': return rangeRow('', s) + byte + row('模式', seg('mode', s.mode || 'holes', [['holes', '仅空洞'], ['all', '覆盖全部']]));
      case 'align': return row('对齐到', input('value', s.value, '字节数，如 0x800 或 2048', 'mono')) + byte;
      default: return patchFields(s.patch, 'patch.', algos);
    }
  }

  function stepTitle(s, algos) {
    const r = `<span class="mono">${showAddr(s.start)}–${esc(s.end || '?')}</span>`;
    switch (s.op) {
      case 'offset': return `<b>偏移</b> <span class="mono">${esc(s.value)}</span>`;
      case 'moveTo': return `<b>移动到</b> <span class="mono">${showAddr(s.value)}</span>`;
      case 'crop': return `<b>裁剪</b> ${r}`;
      case 'remove': return `<b>删除</b> ${r}`;
      case 'fill': return `<b>填充</b> ${r} <span class="muted">= ${esc(s.byte)}${s.mode === 'all' ? '（覆盖）' : '（空洞）'}</span>`;
      case 'align': return `<b>段对齐</b> <span class="mono">${esc(s.value)}</span> <span class="muted">= ${esc(s.byte)}</span>`;
      default: return `<span class="tag">写入</span> ${patchTitle(s.patch, algos)}`;
    }
  }

  // ---------------- 卡片列表 ----------------
  function getPath(o, path) { return path.split('.').reduce((x, k) => (x ? x[k] : undefined), o); }
  function setPath(o, path, v) {
    const ks = path.split('.');
    const last = /** @type {string} */ (ks.pop());
    const t = ks.reduce((x, k) => x[k], o);
    // 切换补丁类型时换成该类型的默认字段，保留地址
    if (last === 'kind') {
      const keep = { address: t.address, start: t.start, end: t.end };
      const fresh = patchDefaults(v, keep);
      Object.keys(t).forEach((k) => delete t[k]);
      Object.assign(t, fresh);
      return;
    }
    t[last] = v;
  }

  /**
   * @param {HTMLElement} el
   * @param {{ title: (item:any)=>string, fields: (item:any)=>string, onChange: (items:any[])=>void, empty: string }} o
   */
  function cardList(el, o) {
    /** @type {any[]} */
    let items = [];
    let results = [];
    el.classList.add('cards');

    function cardHtml(it, i) {
      return `<div class="card${it.enabled ? '' : ' off'}${it.open ? ' open' : ''}" data-i="${i}">
        <div class="chead"><input type="checkbox" data-act="toggle" ${it.enabled ? 'checked' : ''} title="启用 / 停用">
          <span class="cidx">${i + 1}</span><span class="ctitle">${o.title(it)}</span>
          <span class="cact"><button data-act="up" title="上移">▲</button><button data-act="down" title="下移">▼</button><button data-act="del" title="删除">✕</button></span></div>
        <div class="cbody">${o.fields(it)}</div><div class="cprev"></div></div>`;
    }
    function render() {
      el.innerHTML = items.length ? items.map(cardHtml).join('') : `<div class="cempty">${o.empty}</div>`;
      paint();
    }
    function rerender(i) {
      const old = el.querySelector(`.card[data-i="${i}"]`);
      if (!old) return render();
      const tmp = document.createElement('div');
      tmp.innerHTML = cardHtml(items[i], i);
      old.replaceWith(/** @type {Node} */ (tmp.firstElementChild));
      paint();
    }
    function retitle(i) {
      const t = el.querySelector(`.card[data-i="${i}"] .ctitle`);
      if (t) t.innerHTML = o.title(items[i]);
    }
    function changed() { o.onChange(items); }

    /** 把扩展侧返回的逐条结果画到卡片上 */
    function paint() {
      el.querySelectorAll('.card').forEach((card) => {
        const i = +(/** @type {any} */ (card).dataset.i);
        const r = results[i] || {};
        const prev = /** @type {HTMLElement} */ (card.querySelector('.cprev'));
        card.querySelectorAll('[data-k].bad').forEach((x) => x.classList.remove('bad'));
        card.classList.toggle('err', !!r.error && items[i].enabled);
        let h = '';
        if (!items[i].enabled) h = '<span class="muted">已停用</span>';
        else if (r.error) {
          h = `<span class="err">✕ ${esc(r.error)}</span>`;
          const f = r.field && card.querySelector(`[data-k="${r.field}"]`);
          if (f) f.classList.add('bad');
        } else {
          if (r.address !== undefined) h += `<span class="arrow">→</span><span class="mono">${fmtAddr(r.address)}</span> <code>${esc(r.hex)}</code>`;
          if (r.info) h += `${h ? '<br>' : ''}<span class="muted">${esc(r.info)}</span>`;
          if (r.warning) h += `${h ? '<br>' : ''}<span class="warn">⚠ ${esc(r.warning)}</span>`;
        }
        prev.innerHTML = h;
      });
    }

    const idxOf = (t) => { const c = /** @type {HTMLElement} */ (t).closest('.card'); return c ? +(/** @type {any} */ (c).dataset.i) : -1; };
    el.addEventListener('input', (e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      if (!t.dataset.k || t.tagName === 'SELECT') return;
      const i = idxOf(t);
      setPath(items[i], t.dataset.k, t.value);
      t.classList.remove('bad');
      retitle(i);
      changed();
    });
    el.addEventListener('change', (e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      const i = idxOf(t);
      if (i < 0) return;
      if (t.dataset.act === 'toggle') { items[i].enabled = t.checked; rerender(i); changed(); return; }
      if (t.tagName !== 'SELECT' || !t.dataset.k) return;
      setPath(items[i], t.dataset.k, t.value);
      t.dataset.re ? rerender(i) : retitle(i);
      changed();
    });
    el.addEventListener('click', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      const i = idxOf(t);
      if (i < 0) return;
      const b = /** @type {HTMLElement | null} */ (t.closest('button'));
      const sg = b && /** @type {HTMLElement | null} */ (b.closest('[data-seg]'));
      if (b && sg) {
        setPath(items[i], /** @type {string} */ (sg.dataset.seg), JSON.parse(/** @type {string} */ (b.dataset.v)));
        rerender(i);
        changed();
        return;
      }
      const act = b && b.dataset.act;
      if (act === 'del') { items.splice(i, 1); results.splice(i, 1); render(); changed(); return; }
      if (act === 'up' || act === 'down') {
        const j = act === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= items.length) return;
        [items[i], items[j]] = [items[j], items[i]];
        results = [];
        render();
        changed();
        return;
      }
      // 点击标题栏展开 / 收起
      if (t.closest('.chead') && !t.closest('input,button')) {
        items[i].open = !items[i].open;
        /** @type {HTMLElement} */ (t.closest('.card')).classList.toggle('open', items[i].open);
        changed();
      }
    });

    return {
      set(list) { items = list.map((x) => JSON.parse(JSON.stringify(x))); results = []; render(); },
      get: () => items,
      add(item) { items.forEach((x) => (x.open = false)); items.push(item); results = []; render(); changed(); el.lastElementChild?.scrollIntoView({ block: 'nearest' }); },
      preview(r) { results = r || []; paint(); },
    };
  }

  // ---------------- 弹出菜单 ----------------
  /**
   * @param {HTMLElement} anchor
   * @param {[string, string, string?][]} entries [值, 文案, 说明]
   * @param {(v: string) => void} pick
   */
  function menu(anchor, entries, pick) {
    document.querySelectorAll('.menu').forEach((m) => m.remove());
    const m = document.createElement('div');
    m.className = 'menu';
    m.innerHTML = entries.map(([v, l, d]) => `<div class="mi" data-v="${esc(v)}"><span>${esc(l)}</span>${d ? `<span class="muted">${esc(d)}</span>` : ''}</div>`).join('');
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(r.left, window.innerWidth - m.offsetWidth - 4)) + 'px';
    m.style.top = (r.bottom + 2 + m.offsetHeight > window.innerHeight ? r.top - m.offsetHeight - 2 : r.bottom + 2) + 'px';
    const close = () => { m.remove(); window.removeEventListener('mousedown', outside, true); window.removeEventListener('keydown', key, true); };
    const outside = (/** @type {MouseEvent} */ e) => { if (!m.contains(/** @type {Node} */ (e.target))) close(); };
    const key = (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { close(); e.stopPropagation(); } };
    m.addEventListener('click', (e) => {
      const it = /** @type {HTMLElement} */ (e.target).closest('.mi');
      if (it) { close(); pick(/** @type {string} */ (/** @type {HTMLElement} */ (it).dataset.v)); }
    });
    setTimeout(() => { window.addEventListener('mousedown', outside, true); window.addEventListener('keydown', key, true); });
  }

  // @ts-ignore
  window.HexppTools = {
    esc, fmtAddr, PATCH_KINDS, STEP_OPS, stepLabel,
    patchDefaults, patchFields, patchTitle, stepDefaults, stepFields, stepTitle,
    cardList, menu,
  };
})();

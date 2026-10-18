// 对比报告：独立 HTML，包含摘要统计与逐行对比表（相同的大块区域折叠）。
import * as l10n from '@vscode/l10n';
import { MemoryImage, FORMAT_INFO, hex, imageSize } from './formats';
import { DiffResult } from './diff';
import { ROW_BYTES, layoutDiffOnly } from './layout';

export interface ReportSide {
  name: string;
  path: string;
  image: MemoryImage;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const addr = (a: number) => {
  const h = hex(a, 8);
  return h.length === 8 ? h.slice(0, 4) + '_' + h.slice(4) : h;
};

function rowBytes(img: MemoryImage, at: number): number[] {
  const out = new Array<number>(ROW_BYTES).fill(-1);
  for (const s of img.segments) {
    const a = Math.max(at, s.address), b = Math.min(at + ROW_BYTES, s.address + s.data.length);
    for (let x = a; x < b; x++) {
      out[x - at] = s.data[x - s.address];
    }
  }
  return out;
}

function cells(v: number[], o: number[]) {
  let h = '', t = '';
  v.forEach((b, i) => {
    const txt = b < 0 ? '··' : hex(b, 2);
    const ch = b < 0 ? ' ' : (b >= 0x20 && b < 0x7f) ? esc(String.fromCharCode(b)) : '.';
    const d = b !== o[i];
    h += (d ? `<span class="d">${txt}</span>` : txt) + (i === 7 ? '  ' : ' ');
    t += d ? `<span class="d">${ch}</span>` : ch;
  });
  return `<td class="h">${h}</td><td class="t">${t}</td>`;
}

export function buildReport(left: ReportSide, right: ReportSide, diff: DiffResult, now = new Date(), lang = 'en'): string {
  const runs = layoutDiffOnly(diff.blocks, diff.union);
  const rows: string[] = [];
  for (const r of runs) {
    if (r.kind === 'rows') {
      for (let i = 0; i < r.count; i++) {
        const at = r.addr + i * ROW_BYTES;
        const a = rowBytes(left.image, at), b = rowBytes(right.image, at);
        const differs = a.some((x, k) => x !== b[k]);
        rows.push(`<tr${differs ? ' class="rd"' : ''}><td class="o">${addr(at)}</td>${cells(a, b)}<td class="o">${addr(at)}</td>${cells(b, a)}</tr>`);
      }
    } else {
      const n = (r.to - r.from).toLocaleString('en-US');
      const what = r.kind === 'fold'
        ? l10n.t('{0} – {1}: {2} bytes identical', addr(r.from), addr(r.to - 1), n)
        : l10n.t('{0} – {1}: {2} bytes without data', addr(r.from), addr(r.to - 1), n);
      rows.push(`<tr class="f"><td colspan="6">··· ${what} ···</td></tr>`);
    }
  }
  const info = (s: ReportSide) =>
    `<tr><th>${esc(s.name)}</th><td>${esc(s.path)}</td><td>${FORMAT_INFO[s.image.format].label}</td><td>${l10n.t('{0} bytes', imageSize(s.image).toLocaleString('en-US'))}</td><td>${l10n.t('{0} segments', s.image.segments.length)}</td></tr>`;
  return `<!DOCTYPE html>
<html lang="${esc(lang)}"><head><meta charset="UTF-8"><title>${l10n.t('Hex++ Compare Report')} - ${esc(left.name)} ↔ ${esc(right.name)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:20px;color:#222}
h1{font-size:18px}
table{border-collapse:collapse}
.sum td,.sum th{border:1px solid #ccc;padding:4px 8px;text-align:left}
.cmp{font-family:Consolas,'Courier New',monospace;font-size:12px;margin-top:16px}
.cmp td{padding:0 8px;white-space:pre}
.cmp th{position:sticky;top:0;background:#eee;padding:2px 8px;text-align:left}
.o{color:#888}.rd .o{color:#e51400}
.d{color:#e51400;background:#fde7e5}
.f td{color:#888;font-style:italic;background:#f6f6f6;padding:4px 8px}
.t{border-right:1px solid #ccc}
</style></head><body>
<h1>${l10n.t('Hex++ Compare Report')}</h1>
<table class="sum">
<tr><th>${l10n.t('File')}</th><th>${l10n.t('Path')}</th><th>${l10n.t('Format')}</th><th>${l10n.t('Data size')}</th><th>${l10n.t('Segment count')}</th></tr>
${info(left)}
${info(right)}
</table>
<p>${l10n.t('Different bytes:')} <b>${diff.diffBytes.toLocaleString('en-US')}</b>　${l10n.t('Difference blocks:')} <b>${diff.blocks.length}</b>　${l10n.t('Generated at:')} ${now.toLocaleString()}</p>
${diff.blocks.length === 0 ? `<p><b>${l10n.t('The two files are identical.')}</b></p>` : `<table class="cmp">
<tr><th>${l10n.t('Offset')}</th><th>${esc(left.name)}</th><th></th><th>${l10n.t('Offset')}</th><th>${esc(right.name)}</th><th></th></tr>
${rows.join('\n')}
</table>`}
</body></html>
`;
}

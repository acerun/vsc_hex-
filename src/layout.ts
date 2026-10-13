// 行布局：把地址空间压缩成 webview 可虚拟滚动的"行段"列表。
// 每个 rows 段是连续的 16 字节对齐行；段与段之间插入一行 gap（地址空洞）或 fold（折叠的相同数据）。
import { Range, mergeRanges } from './diff';

export const ROW_BYTES = 16;

export type Run =
  | { kind: 'rows'; addr: number; count: number }
  | { kind: 'gap'; from: number; to: number }
  | { kind: 'fold'; from: number; to: number };

const rowFloor = (a: number) => Math.floor(a / ROW_BYTES) * ROW_BYTES;
const rowCeil = (a: number) => Math.ceil(a / ROW_BYTES) * ROW_BYTES;

/** 显示 ranges 覆盖的全部行；行对齐后相邻/重叠的区间合并，真正的空洞以 gap 行表示。 */
export function layoutRanges(ranges: Range[]): Run[] {
  const rows = mergeRanges(ranges.map(r => ({ start: rowFloor(r.start), end: rowCeil(r.end) })), 0);
  const out: Run[] = [];
  rows.forEach((r, i) => {
    if (i > 0) {
      out.push({ kind: 'gap', from: rows[i - 1].end, to: r.start });
    }
    out.push({ kind: 'rows', addr: r.start, count: (r.end - r.start) / ROW_BYTES });
  });
  return out;
}

/**
 * "差异"视图：差异块前后各保留 context 字节；
 * 两个可见区之间若是 ≥ minFold 字节的相同数据则折叠为一行，否则照常显示。
 */
export function layoutDiffOnly(blocks: Range[], union: Range[], context = 64, minFold = 256): Run[] {
  if (blocks.length === 0) {
    return [];
  }
  const shown = clipTo(
    mergeRanges(blocks.map(b => ({ start: rowFloor(b.start - context), end: rowCeil(b.end + context) })), minFold - 1),
    union,
  );
  const rows = mergeRanges(shown.map(r => ({ start: rowFloor(r.start), end: rowCeil(r.end) })), 0);
  const out: Run[] = [];
  rows.forEach((r, i) => {
    if (i > 0) {
      const from = rows[i - 1].end;
      // 中间若完全是空洞（两侧都无数据）标为 gap，否则是折叠的相同数据
      const covered = union.some(u => u.start < r.start && u.end > from);
      out.push({ kind: covered ? 'fold' : 'gap', from, to: r.start });
    }
    out.push({ kind: 'rows', addr: r.start, count: (r.end - r.start) / ROW_BYTES });
  });
  return out;
}

function clipTo(ranges: Range[], union: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of ranges) {
    for (const u of union) {
      const a = Math.max(r.start, u.start);
      const b = Math.min(r.end, u.end);
      if (a < b) {
        out.push({ start: a, end: b });
      }
    }
  }
  return out;
}

export function totalRows(runs: Run[]): number {
  return runs.reduce((n, r) => n + (r.kind === 'rows' ? r.count : 1), 0);
}

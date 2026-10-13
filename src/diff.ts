// 按地址逐字节比较两个内存映像。一侧有数据、另一侧是空洞也算差异。
import { MemoryImage, Segment } from './formats/image';

export interface Range {
  start: number;
  end: number;
}

export interface DiffResult {
  /** 差异块（相距小于 mergeGap 的差异字节合并为一块），按地址升序 */
  blocks: Range[];
  diffBytes: number;
  /** 两侧数据覆盖范围的并集 */
  union: Range[];
}

export function unionRanges(...lists: Segment[][]): Range[] {
  const all = lists.flat().map(s => ({ start: s.address, end: s.address + s.data.length }));
  return mergeRanges(all, 0);
}

/** 合并重叠或间距 ≤ gap 的区间。 */
export function mergeRanges(ranges: Range[], gap: number): Range[] {
  const sorted = ranges.filter(r => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gap) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** 顺序游标：按升序地址查询某一侧的字节，-1 表示空洞。 */
class Cursor {
  private i = 0;
  constructor(private segs: Segment[]) {}
  at(addr: number): number {
    while (this.i < this.segs.length && addr >= this.segs[this.i].address + this.segs[this.i].data.length) {
      this.i++;
    }
    const s = this.segs[this.i];
    return s && addr >= s.address ? s.data[addr - s.address] : -1;
  }
}

export function diffImages(a: MemoryImage, b: MemoryImage, mergeGap = 16): DiffResult {
  const union = unionRanges(a.segments, b.segments);
  const ca = new Cursor(a.segments);
  const cb = new Cursor(b.segments);
  const raw: Range[] = [];
  let diffBytes = 0;
  for (const r of union) {
    let runStart = -1;
    for (let addr = r.start; addr < r.end; addr++) {
      if (ca.at(addr) !== cb.at(addr)) {
        diffBytes++;
        if (runStart < 0) {
          runStart = addr;
        }
      } else if (runStart >= 0) {
        raw.push({ start: runStart, end: addr });
        runStart = -1;
      }
    }
    if (runStart >= 0) {
      raw.push({ start: runStart, end: r.end });
    }
  }
  return { blocks: mergeRanges(raw, mergeGap - 1), diffBytes, union };
}

// 内存映像模型：所有格式都解析成"按地址排序、互不重叠的段"，显示/编辑/对比/导出都基于它。

export type FormatId = 'bin' | 'ihex' | 'srec' | 'titxt' | 'elf';

export interface Segment {
  address: number;
  data: Uint8Array;
}

export interface MemoryImage {
  format: FormatId;
  segments: Segment[];
  entry?: number;
  /** S-Record S0 头等描述信息 */
  header?: string;
  /** 解析时的非致命问题（校验和错误等） */
  warnings: string[];
  /** ELF：原始文件与 PT_LOAD 映射，用于保存时原位回写 */
  elf?: { raw: Uint8Array; loads: { address: number; offset: number; size: number }[] };
}

/** 排序并合并重叠/相邻的段；后出现的数据覆盖先出现的数据。 */
export function normalize(chunks: Segment[]): Segment[] {
  const list = chunks
    .map((c, i) => ({ c, i }))
    .filter(x => x.c.data.length > 0)
    .sort((x, y) => x.c.address - y.c.address || x.i - y.i);
  const out: Segment[] = [];
  let k = 0;
  while (k < list.length) {
    const start = list[k].c.address;
    let end = start + list[k].c.data.length;
    let j = k + 1;
    while (j < list.length && list[j].c.address <= end) {
      end = Math.max(end, list[j].c.address + list[j].c.data.length);
      j++;
    }
    if (j === k + 1) {
      out.push({ address: start, data: list[k].c.data });
    } else {
      const data = new Uint8Array(end - start);
      // 按原始出现顺序写入，保证"后写覆盖先写"
      list.slice(k, j).sort((x, y) => x.i - y.i).forEach(x => data.set(x.c.data, x.c.address - start));
      out.push({ address: start, data });
    }
    k = j;
  }
  return out;
}

export function imageSize(img: MemoryImage): number {
  return img.segments.reduce((n, s) => n + s.data.length, 0);
}

export function imageRange(img: MemoryImage): { start: number; end: number } | undefined {
  const s = img.segments;
  if (s.length === 0) {
    return undefined;
  }
  const last = s[s.length - 1];
  return { start: s[0].address, end: last.address + last.data.length };
}

export function findSegment(segs: Segment[], addr: number): number {
  let lo = 0, hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid];
    if (addr < s.address) {
      hi = mid - 1;
    } else if (addr >= s.address + s.data.length) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

/** 读取 [start, end) 中的有效字节（跳过空洞），并保留各连续片段的地址。 */
export function readPieces(img: MemoryImage, start: number, end: number): Segment[] {
  const out: Segment[] = [];
  for (const s of img.segments) {
    const a = Math.max(start, s.address);
    const b = Math.min(end, s.address + s.data.length);
    if (a < b) {
      out.push({ address: a, data: s.data.subarray(a - s.address, b - s.address) });
    }
  }
  return out;
}

export function readBytes(img: MemoryImage, start: number, end: number): Uint8Array {
  const pieces = readPieces(img, start, end);
  if (pieces.length === 1) {
    return pieces[0].data.slice();
  }
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.data.length, 0));
  let o = 0;
  for (const p of pieces) {
    out.set(p.data, o);
    o += p.data.length;
  }
  return out;
}

/** 覆盖写入已存在的地址（空洞中的地址被忽略），返回被覆盖的旧数据。 */
export function writeBytes(img: MemoryImage, addr: number, bytes: Uint8Array): Uint8Array {
  const old = new Uint8Array(bytes.length);
  for (const s of img.segments) {
    const a = Math.max(addr, s.address);
    const b = Math.min(addr + bytes.length, s.address + s.data.length);
    if (a < b) {
      old.set(s.data.subarray(a - s.address, b - s.address), a - addr);
      s.data.set(bytes.subarray(a - addr, b - addr), a - s.address);
    }
  }
  return old;
}

/** 展平为连续缓冲区，空洞用 fill 填充。 */
export function flatten(img: MemoryImage, fill: number): { base: number; data: Uint8Array } {
  const r = imageRange(img);
  if (!r) {
    return { base: 0, data: new Uint8Array(0) };
  }
  const data = new Uint8Array(r.end - r.start).fill(fill);
  for (const s of img.segments) {
    data.set(s.data, s.address - r.start);
  }
  return { base: r.start, data };
}

export function hex(n: number, width: number): string {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

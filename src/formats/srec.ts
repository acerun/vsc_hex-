// Motorola S-Record：S0–S9，校验和为 (count+地址+数据) 字节和的反码低 8 位。
import * as l10n from '@vscode/l10n';
import { MemoryImage, ChunkBuilder, AsciiWriter, imageRange } from './image';

const ADDR_LEN: Record<string, number> = { '0': 2, '1': 2, '2': 3, '3': 4, '5': 2, '6': 3, '7': 4, '8': 3, '9': 2 };

export function parseSrec(text: string): MemoryImage {
  const chunks = new ChunkBuilder();
  const warnings: string[] = [];
  let entry: number | undefined;
  let header: string | undefined;
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (line === '') {
      continue;
    }
    // 行号文本只在出警告时才需要；每行都调用 l10n.t() 对大文件开销很大
    const where = () => l10n.t('Line {0}', ln + 1);
    if (line[0] !== 'S' && line[0] !== 's') {
      warnings.push(l10n.t('{0}: not an S-Record record, ignored', where()));
      continue;
    }
    const type = line[1];
    const alen = ADDR_LEN[type];
    if (alen === undefined) {
      warnings.push(l10n.t('{0}: unknown record type S{1}', where(), type));
      continue;
    }
    const bytes = hexToBytes(line.slice(2));
    if (!bytes || bytes.length < 1 || bytes[0] !== bytes.length - 1 || bytes.length < 1 + alen + 1) {
      warnings.push(l10n.t('{0}: invalid record length', where()));
      continue;
    }
    let sum = 0;
    for (let i = 0; i < bytes.length - 1; i++) {
      sum += bytes[i];
    }
    if (((~sum) & 0xff) !== bytes[bytes.length - 1]) {
      warnings.push(l10n.t('{0}: checksum error', where()));
    }
    let addr = 0;
    for (let i = 0; i < alen; i++) {
      addr = addr * 256 + bytes[1 + i];
    }
    const data = bytes.subarray(1 + alen, bytes.length - 1);
    switch (type) {
      case '0':
        header = String.fromCharCode(...data).replace(/\0+$/, '');
        break;
      case '1': case '2': case '3':
        chunks.add(addr, data);
        break;
      case '7': case '8': case '9':
        entry = addr;
        break;
    }
  }
  return { format: 'srec', segments: chunks.finish(), entry, header, warnings };
}

export function writeSrec(img: MemoryImage, recordLength = 16, header = ''): Uint8Array {
  const r = imageRange(img);
  const maxAddr = r ? r.end - 1 : 0;
  if (maxAddr > 0xffffffff) {
    throw new Error(l10n.t('S-Record only supports 32-bit addresses'));
  }
  const alen = maxAddr <= 0xffff ? 2 : maxAddr <= 0xffffff ? 3 : 4;
  const dataType = { 2: '1', 3: '2', 4: '3' }[alen]!;
  const endType = { 2: '9', 3: '8', 4: '7' }[alen]!;
  const w = new AsciiWriter();
  // 长度字节最大 255：S0 数据最多 252 字节（255 − 2 字节地址 − 1 字节校验和）
  record(w, '0', 2, 0, new TextEncoder().encode(header).subarray(0, 252));
  let count = 0;
  for (const s of img.segments) {
    for (let o = 0; o < s.data.length; o += recordLength) {
      record(w, dataType, alen, s.address + o, s.data, o, Math.min(o + recordLength, s.data.length));
      count++;
    }
  }
  if (count <= 0xffff) {
    record(w, '5', 2, count, new Uint8Array(0));
  }
  record(w, endType, alen, (img.entry ?? 0) % 2 ** (alen * 8), new Uint8Array(0));
  return w.finish();
}

/** 写一条记录（data[from, to) 为数据）及换行 */
function record(w: AsciiWriter, type: string, alen: number, addr: number, data: Uint8Array, from = 0, to = data.length) {
  let sum = alen + (to - from) + 1;
  w.text('S' + type);
  w.hex(sum);
  for (let i = alen - 1; i >= 0; i--) {
    const b = Math.floor(addr / 2 ** (i * 8)) & 0xff;
    sum += b;
    w.hex(b);
  }
  for (let i = from; i < to; i++) {
    sum += data[i];
    w.hex(data[i]);
  }
  w.hex((~sum) & 0xff);
  w.text('\n');
}

/** 字符码 → 十六进制数值，非十六进制字符为 -1 */
const NIBBLE = new Int8Array(128).fill(-1);
for (let i = 0; i < 16; i++) {
  NIBBLE['0123456789ABCDEF'.charCodeAt(i)] = i;
  NIBBLE['0123456789abcdef'.charCodeAt(i)] = i;
}

/** s[i]、s[i+1] 两个十六进制字符组成的字节，无效时为 -1 */
export function hexByte(s: string, i: number): number {
  const hi = NIBBLE[s.charCodeAt(i)] ?? -1;
  const lo = NIBBLE[s.charCodeAt(i + 1)] ?? -1;
  return hi < 0 || lo < 0 ? -1 : (hi << 4) | lo;
}

export function hexToBytes(s: string): Uint8Array | undefined {
  if (s.length % 2 !== 0) {
    return undefined;
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = hexByte(s, i * 2);
    if (b < 0) {
      return undefined;
    }
    out[i] = b;
  }
  return out;
}

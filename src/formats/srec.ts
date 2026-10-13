// Motorola S-Record：S0–S9，校验和为 (count+地址+数据) 字节和的反码低 8 位。
import { MemoryImage, Segment, normalize, hex, imageRange } from './image';

const ADDR_LEN: Record<string, number> = { '0': 2, '1': 2, '2': 3, '3': 4, '5': 2, '6': 3, '7': 4, '8': 3, '9': 2 };

export function parseSrec(text: string): MemoryImage {
  const chunks: Segment[] = [];
  const warnings: string[] = [];
  let entry: number | undefined;
  let header: string | undefined;
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (line === '') {
      continue;
    }
    const where = `第 ${ln + 1} 行`;
    if (line[0] !== 'S' && line[0] !== 's') {
      warnings.push(`${where}: 不是 S-Record 记录，已忽略`);
      continue;
    }
    const type = line[1];
    const alen = ADDR_LEN[type];
    if (alen === undefined) {
      warnings.push(`${where}: 未知记录类型 S${type}`);
      continue;
    }
    const bytes = hexToBytes(line.slice(2));
    if (!bytes || bytes.length < 1 || bytes[0] !== bytes.length - 1 || bytes.length < 1 + alen + 1) {
      warnings.push(`${where}: 记录长度错误`);
      continue;
    }
    let sum = 0;
    for (let i = 0; i < bytes.length - 1; i++) {
      sum += bytes[i];
    }
    if (((~sum) & 0xff) !== bytes[bytes.length - 1]) {
      warnings.push(`${where}: 校验和错误`);
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
        chunks.push({ address: addr, data: data.slice() });
        break;
      case '7': case '8': case '9':
        entry = addr;
        break;
    }
  }
  return { format: 'srec', segments: normalize(chunks), entry, header, warnings };
}

export function writeSrec(img: MemoryImage, recordLength = 16, header = ''): string {
  const r = imageRange(img);
  const maxAddr = r ? r.end - 1 : 0;
  if (maxAddr > 0xffffffff) {
    throw new Error('S-Record 仅支持 32 位地址');
  }
  const alen = maxAddr <= 0xffff ? 2 : maxAddr <= 0xffffff ? 3 : 4;
  const dataType = { 2: '1', 3: '2', 4: '3' }[alen]!;
  const endType = { 2: '9', 3: '8', 4: '7' }[alen]!;
  const out: string[] = [];
  out.push(record('0', 2, 0, new TextEncoder().encode(header)));
  let count = 0;
  for (const s of img.segments) {
    for (let o = 0; o < s.data.length; o += recordLength) {
      out.push(record(dataType, alen, s.address + o, s.data.subarray(o, o + recordLength)));
      count++;
    }
  }
  if (count <= 0xffff) {
    out.push(record('5', 2, count, new Uint8Array(0)));
  }
  out.push(record(endType, alen, (img.entry ?? 0) % 2 ** (alen * 8), new Uint8Array(0)));
  return out.join('\n') + '\n';
}

function record(type: string, alen: number, addr: number, data: Uint8Array): string {
  const bytes: number[] = [alen + data.length + 1];
  for (let i = alen - 1; i >= 0; i--) {
    bytes.push(Math.floor(addr / 2 ** (i * 8)) & 0xff);
  }
  bytes.push(...data);
  const sum = bytes.reduce((a, b) => a + b, 0);
  bytes.push((~sum) & 0xff);
  return 'S' + type + bytes.map(b => hex(b, 2)).join('');
}

export function hexToBytes(s: string): Uint8Array | undefined {
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) {
    return undefined;
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}

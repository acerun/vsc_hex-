// Intel HEX：00 数据、01 结束、02 扩展段地址、03 段起始、04 扩展线性地址、05 线性起始。
import * as l10n from '@vscode/l10n';
import { MemoryImage, ChunkBuilder, AsciiWriter, hex, imageRange } from './image';
import { hexToBytes } from './srec';

export function parseIhex(text: string): MemoryImage {
  const chunks = new ChunkBuilder();
  const warnings: string[] = [];
  let entry: number | undefined;
  let base = 0;
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (line === '') {
      continue;
    }
    // 行号文本只在出警告时才需要；每行都调用 l10n.t() 对大文件开销很大
    const where = () => l10n.t('Line {0}', ln + 1);
    if (line[0] !== ':') {
      warnings.push(l10n.t('{0}: missing start colon, ignored', where()));
      continue;
    }
    const bytes = hexToBytes(line.slice(1));
    if (!bytes || bytes.length < 5 || bytes[0] !== bytes.length - 5) {
      warnings.push(l10n.t('{0}: invalid record length', where()));
      continue;
    }
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) {
      sum += bytes[i];
    }
    if ((sum & 0xff) !== 0) {
      warnings.push(l10n.t('{0}: checksum error', where()));
    }
    const offset = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const data = bytes.subarray(4, bytes.length - 1);
    if (type === 0x00) {
      chunks.add(base + offset, data);
    } else if (type === 0x01) {
      break;
    } else if (type === 0x02 && data.length === 2) {
      base = ((data[0] << 8) | data[1]) * 16;
    } else if (type === 0x04 && data.length === 2) {
      base = ((data[0] << 8) | data[1]) * 0x10000;
    } else if (type === 0x03 && data.length === 4) {
      entry = ((data[0] << 8) | data[1]) * 16 + ((data[2] << 8) | data[3]);
    } else if (type === 0x05 && data.length === 4) {
      entry = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
    } else {
      warnings.push(l10n.t('{0}: unsupported record type {1}', where(), hex(type, 2)));
    }
  }
  return { format: 'ihex', segments: chunks.finish(), entry, warnings };
}

export function writeIhex(img: MemoryImage, recordLength = 16): Uint8Array {
  const r = imageRange(img);
  if (r && r.end - 1 > 0xffffffff) {
    throw new Error(l10n.t('Intel HEX only supports 32-bit addresses'));
  }
  const w = new AsciiWriter();
  let upper = -1;
  for (const s of img.segments) {
    let addr = s.address;
    let o = 0;
    while (o < s.data.length) {
      const hi = Math.floor(addr / 0x10000);
      if (hi !== upper) {
        record(w, 0, 0x04, Uint8Array.of(hi >> 8, hi & 0xff));
        upper = hi;
      }
      // 记录不能跨越 64K 边界
      const n = Math.min(recordLength, s.data.length - o, 0x10000 - (addr & 0xffff));
      record(w, addr & 0xffff, 0x00, s.data, o, o + n);
      o += n;
      addr += n;
    }
  }
  if (img.entry !== undefined) {
    const e = img.entry >>> 0;
    record(w, 0, 0x05, Uint8Array.of(e >>> 24, (e >> 16) & 0xff, (e >> 8) & 0xff, e & 0xff));
  }
  record(w, 0, 0x01, new Uint8Array(0));
  return w.finish();
}

/** 写一条记录（data[from, to) 为数据）及换行 */
function record(w: AsciiWriter, offset: number, type: number, data: Uint8Array, from = 0, to = data.length) {
  let sum = (to - from) + (offset >> 8) + (offset & 0xff) + type;
  w.text(':');
  w.hex(to - from);
  w.hex(offset >> 8);
  w.hex(offset & 0xff);
  w.hex(type);
  for (let i = from; i < to; i++) {
    sum += data[i];
    w.hex(data[i]);
  }
  w.hex((-sum) & 0xff);
  w.text('\n');
}

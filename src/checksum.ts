// 校验和 / CRC / 哈希：对内存映像的地址范围流式计算，空洞可按填充字节参与计算或跳过。
import { createHash } from 'crypto';
import * as l10n from '@vscode/l10n';
import { MemoryImage, hex, readPieces } from './formats';

export interface CrcModel {
  width: number;
  poly: number;
  init: number;
  refin: boolean;
  refout: boolean;
  xorout: number;
}

export type AlgoGroup = 'CRC' | 'Checksum' | 'Hash';

export interface AlgoInfo {
  id: string;
  name: string;
  group: AlgoGroup;
  /** 结果字节数（自定义 CRC 随宽度变化） */
  size: number;
  /** 数值型结果写入时随字节序变化；哈希按原始字节顺序 */
  numeric: boolean;
  note?: string;
}

type Preset = CrcModel & { name: string; note?: string; words?: boolean };

const CRC_PRESETS: Record<string, Preset> = {
  'crc8': { name: 'CRC-8', width: 8, poly: 0x07, init: 0x00, refin: false, refout: false, xorout: 0x00 },
  'crc8-maxim': { name: 'CRC-8/MAXIM', width: 8, poly: 0x31, init: 0x00, refin: true, refout: true, xorout: 0x00, note: 'Dallas 1-Wire' },
  'crc8-sae-j1850': { name: 'CRC-8/SAE-J1850', width: 8, poly: 0x1d, init: 0xff, refin: false, refout: false, xorout: 0xff },
  'crc8-autosar': { name: 'CRC-8/AUTOSAR', width: 8, poly: 0x2f, init: 0xff, refin: false, refout: false, xorout: 0xff },
  'crc16-ccitt-false': { name: 'CRC-16/CCITT-FALSE', width: 16, poly: 0x1021, init: 0xffff, refin: false, refout: false, xorout: 0x0000, note: 'IBM-3740' },
  'crc16-xmodem': { name: 'CRC-16/XMODEM', width: 16, poly: 0x1021, init: 0x0000, refin: false, refout: false, xorout: 0x0000 },
  'crc16-kermit': { name: 'CRC-16/KERMIT', width: 16, poly: 0x1021, init: 0x0000, refin: true, refout: true, xorout: 0x0000 },
  'crc16-modbus': { name: 'CRC-16/MODBUS', width: 16, poly: 0x8005, init: 0xffff, refin: true, refout: true, xorout: 0x0000 },
  'crc16-arc': { name: 'CRC-16/ARC', width: 16, poly: 0x8005, init: 0x0000, refin: true, refout: true, xorout: 0x0000, note: 'IBM' },
  'crc16-usb': { name: 'CRC-16/USB', width: 16, poly: 0x8005, init: 0xffff, refin: true, refout: true, xorout: 0xffff },
  'crc32': { name: 'CRC-32', width: 32, poly: 0x04c11db7, init: 0xffffffff, refin: true, refout: true, xorout: 0xffffffff, note: 'zlib / Ethernet' },
  'crc32-mpeg2': { name: 'CRC-32/MPEG-2', width: 32, poly: 0x04c11db7, init: 0xffffffff, refin: false, refout: false, xorout: 0x00000000 },
  'crc32-stm32': {
    name: 'CRC-32/STM32', width: 32, poly: 0x04c11db7, init: 0xffffffff, refin: false, refout: false, xorout: 0x00000000, words: true,
    // 文案在读取时才翻译（模块加载时 l10n 尚未配置）
    get note() { return l10n.t('STM32 hardware CRC default configuration, fed as little-endian 32-bit words'); },
  },
  'crc32c': { name: 'CRC-32C', width: 32, poly: 0x1edc6f41, init: 0xffffffff, refin: true, refout: true, xorout: 0xffffffff, note: 'Castagnoli' },
  'crc32-bzip2': { name: 'CRC-32/BZIP2', width: 32, poly: 0x04c11db7, init: 0xffffffff, refin: false, refout: false, xorout: 0xffffffff },
  'crc32-autosar': { name: 'CRC-32/AUTOSAR', width: 32, poly: 0xf4acfb13, init: 0xffffffff, refin: true, refout: true, xorout: 0xffffffff },
};

// 名称与说明用 getter 延迟翻译（模块加载时 l10n 尚未配置）
const SUMS: Record<string, { name: string; size: number; note?: string }> = {
  'sum8': { name: 'Sum8', size: 1, get note() { return l10n.t('Byte sum mod 256'); } },
  'sum8-neg': {
    get name() { return l10n.t('Sum8 complement'); }, size: 1,
    get note() { return l10n.t('Byte that makes the total 0 (Intel HEX style)'); },
  },
  'xor8': { name: 'XOR8', size: 1, get note() { return l10n.t('Byte-wise XOR'); } },
  'sum16': { name: 'Sum16', size: 2, get note() { return l10n.t('Byte sum mod 2^16'); } },
  'sum32': { name: 'Sum32', size: 4, get note() { return l10n.t('Byte sum mod 2^32'); } },
  'sum16w': {
    get name() { return l10n.t('Sum16 (16-bit words)'); }, size: 2,
    get note() { return l10n.t('Sum of 16-bit words, follows byte order'); },
  },
  'sum32w': {
    get name() { return l10n.t('Sum32 (32-bit words)'); }, size: 4,
    get note() { return l10n.t('Sum of 32-bit words, follows byte order'); },
  },
};

const HASHES: Record<string, { name: string; node: string; size: number }> = {
  'md5': { name: 'MD5', node: 'md5', size: 16 },
  'sha1': { name: 'SHA-1', node: 'sha1', size: 20 },
  'sha256': { name: 'SHA-256', node: 'sha256', size: 32 },
};

export const CUSTOM_CRC = 'custom';

export const ALGORITHMS: AlgoInfo[] = [
  ...Object.entries(CRC_PRESETS).map(([id, p]) => ({
    id, group: 'CRC' as const, size: p.width / 8, numeric: true,
    get name() { return p.name; }, get note() { return p.note; },
  })),
  { id: CUSTOM_CRC, get name() { return l10n.t('Custom CRC'); }, group: 'CRC', size: 4, numeric: true },
  ...Object.entries(SUMS).map(([id, x]) => ({
    id, group: 'Checksum' as const, size: x.size, numeric: true,
    get name() { return x.name; }, get note() { return x.note; },
  })),
  ...Object.entries(HASHES).map(([id, h]) => ({ id, name: h.name, group: 'Hash' as const, size: h.size, numeric: false })),
];

export function algoInfo(id: string, custom?: CrcModel): AlgoInfo | undefined {
  const a = ALGORITHMS.find(x => x.id === id);
  return a && id === CUSTOM_CRC && custom ? { ...a, size: Math.ceil(custom.width / 8) } : a;
}

export function validateCrcModel(m: CrcModel): string | undefined {
  if (!Number.isInteger(m.width) || m.width < 8 || m.width > 32) {
    return l10n.t('Width must be 8–32');
  }
  const max = 2 ** m.width;
  for (const k of ['poly', 'init', 'xorout'] as const) {
    if (!Number.isInteger(m[k]) || m[k] < 0 || m[k] >= max) {
      return l10n.t('{0} is out of range for {1} bits', k, m.width);
    }
  }
  if ((m.poly & 1) === 0) {
    return l10n.t('The lowest bit of the polynomial must be 1');
  }
  return undefined;
}

export interface Hasher {
  update(d: Uint8Array): void;
  /** 结果字节：数值型为大端（自然书写顺序） */
  digest(): Uint8Array;
}

function reflect(v: number, w: number): number {
  let r = 0;
  for (let i = 0; i < w; i++) {
    r = r * 2 + ((v >>> i) & 1);
  }
  return r;
}

function beBytes(v: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

const tableCache = new Map<string, Uint32Array>();

function crcHasher(m: CrcModel, words = false): Hasher {
  const w = m.width;
  const mask = w === 32 ? 0xffffffff : 2 ** w - 1;
  const key = `${w}:${m.poly}:${m.refin}`;
  let table = tableCache.get(key);
  if (!table) {
    table = new Uint32Array(256);
    if (m.refin) {
      const rp = reflect(m.poly, w);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
          c = c & 1 ? (c >>> 1) ^ rp : c >>> 1;
        }
        table[i] = c >>> 0;
      }
    } else {
      const top = 2 ** (w - 1);
      for (let i = 0; i < 256; i++) {
        let c = i * 2 ** (w - 8);
        for (let k = 0; k < 8; k++) {
          c = c >= top ? ((c - top) * 2) ^ m.poly : c * 2;
          c = (c >>> 0) % (mask + 1);
        }
        table[i] = c >>> 0;
      }
    }
    tableCache.set(key, table);
  }
  const t = table;
  let reg = m.refin ? reflect(m.init, w) : m.init;
  const shift = w - 8;
  const byte = m.refin
    ? (b: number) => { reg = (t[(reg ^ b) & 0xff] ^ (reg >>> 8)) >>> 0; }
    : (b: number) => { reg = ((t[((reg >>> shift) ^ b) & 0xff] ^ (reg << 8)) >>> 0) & mask; reg >>>= 0; };
  // STM32：每个 32 位字按小端从内存取出、高位先入，等价于每 4 字节倒序
  const carry: number[] = [];
  return {
    update(d) {
      if (!words) {
        for (let i = 0; i < d.length; i++) {
          byte(d[i]);
        }
        return;
      }
      for (let i = 0; i < d.length; i++) {
        carry.push(d[i]);
        if (carry.length === 4) {
          byte(carry[3]); byte(carry[2]); byte(carry[1]); byte(carry[0]);
          carry.length = 0;
        }
      }
    },
    digest() {
      carry.forEach(byte); // 不足一个字的尾部按字节输入
      carry.length = 0;
      let v = m.refin !== m.refout ? reflect(reg, w) : reg;
      v = (v ^ m.xorout) >>> 0;
      return beBytes(w === 32 ? v : v & mask, Math.ceil(w / 8));
    },
  };
}

function sumHasher(id: string, le: boolean): Hasher {
  let acc = 0;
  const size = SUMS[id].size;
  const word = id === 'sum16w' ? 2 : id === 'sum32w' ? 4 : 0;
  const carry: number[] = [];
  const addWord = (bytes: number[]) => {
    let v = 0;
    for (let i = 0; i < word; i++) {
      v = v * 256 + (bytes[le ? word - 1 - i : i] ?? 0);
    }
    acc = (acc + v) % 2 ** (8 * size);
  };
  return {
    update(d) {
      if (word) {
        for (let i = 0; i < d.length; i++) {
          carry.push(d[i]);
          if (carry.length === word) {
            addWord(carry);
            carry.length = 0;
          }
        }
      } else if (id === 'xor8') {
        for (let i = 0; i < d.length; i++) {
          acc ^= d[i];
        }
      } else {
        let s = 0;
        for (let i = 0; i < d.length; i++) {
          s += d[i];
        }
        acc = (acc + s) % 2 ** (8 * size);
      }
    },
    digest() {
      if (carry.length) {
        addWord(carry); // 不足一个字的尾部高位补 0
        carry.length = 0;
      }
      return beBytes(id === 'sum8-neg' ? (256 - acc) & 0xff : acc, size);
    },
  };
}

/** 创建算法实例；未知算法或自定义参数无效时抛出错误。 */
export function createHasher(id: string, opts: { le?: boolean; custom?: CrcModel } = {}): Hasher {
  const p = CRC_PRESETS[id];
  if (p) {
    return crcHasher(p, p.words);
  }
  if (id === CUSTOM_CRC) {
    const err = opts.custom ? validateCrcModel(opts.custom) : l10n.t('Custom CRC parameters are not set');
    if (err) {
      throw new Error(err);
    }
    return crcHasher(opts.custom!);
  }
  if (SUMS[id]) {
    return sumHasher(id, opts.le ?? true);
  }
  const h = HASHES[id];
  if (h) {
    const hash = createHash(h.node);
    return { update: d => hash.update(d), digest: () => new Uint8Array(hash.digest()) };
  }
  throw new Error(l10n.t('Unknown algorithm {0}', id));
}

export function checksum(id: string, data: Uint8Array, opts: { le?: boolean; custom?: CrcModel } = {}): Uint8Array {
  const h = createHasher(id, opts);
  h.update(data);
  return h.digest();
}

export interface ChecksumOptions {
  /** 空洞填充字节；undefined 表示跳过空洞 */
  fill?: number;
  le?: boolean;
  custom?: CrcModel;
}

export interface ChecksumResult {
  id: string;
  value?: Uint8Array;
  error?: string;
}

/** 范围内需要按填充字节计算的上限，避免地址相距很远的段被整段填充 */
export const MAX_FILL_SPAN = 512 * 1024 * 1024;

/** 对 [start, end) 计算多个算法；返回各结果与参与计算的字节数。 */
export function checksumImage(img: MemoryImage, ids: string[], start: number, end: number, opts: ChecksumOptions = {}) {
  if (opts.fill !== undefined && end - start > MAX_FILL_SPAN) {
    throw new Error(l10n.t('Range of {0} bytes is too large to fill gaps; narrow the range or choose to skip gaps', (end - start).toLocaleString('en-US')));
  }
  const results: ChecksumResult[] = [];
  const hashers: Hasher[] = [];
  for (const id of ids) {
    try {
      hashers.push(createHasher(id, opts));
      results.push({ id });
    } catch (e) {
      results.push({ id, error: (e as Error).message });
    }
  }
  let count = 0;
  const feed = (d: Uint8Array) => {
    hashers.forEach(h => h.update(d));
    count += d.length;
  };
  let fillChunk: Uint8Array | undefined;
  const gap = (n: number) => {
    if (opts.fill === undefined) {
      return;
    }
    fillChunk ??= new Uint8Array(0x10000).fill(opts.fill);
    while (n > 0) {
      const k = Math.min(n, fillChunk.length);
      feed(fillChunk.subarray(0, k));
      n -= k;
    }
  };
  let pos = start;
  for (const p of readPieces(img, start, end)) {
    gap(p.address - pos);
    feed(p.data);
    pos = p.address + p.data.length;
  }
  gap(end - pos);
  let k = 0;
  for (const r of results) {
    if (!r.error) {
      r.value = hashers[k++].digest();
    }
  }
  return { results, count };
}

/** 写入映像时的字节：数值型按字节序排列，哈希保持原样 */
export function valueBytes(info: AlgoInfo, digest: Uint8Array, le: boolean): Uint8Array {
  return info.numeric && le ? digest.slice().reverse() : digest.slice();
}

export function formatDigest(info: AlgoInfo, digest: Uint8Array): string {
  const h = Array.from(digest, b => hex(b, 2)).join('');
  return info.numeric ? '0x' + h : h.toLowerCase();
}

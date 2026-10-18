// 写入补丁：把校验值、数值、字节、文本、时间戳、序列号写到映像的指定地址（只覆盖已有字节）。
// 补丁按列表顺序依次规划，后面的校验值能看到前面补丁写入的结果。
import { MemoryImage, cloneImage, hex, isCovered, writeBytes } from './formats';
import { CrcModel, algoInfo, checksumImage, valueBytes } from './checksum';
import { FieldError, need, parseAddress, parseByte, parseHexBytes, parseRange, parseValue } from './numbers';

export type PatchKind = 'checksum' | 'number' | 'bytes' | 'text' | 'time' | 'serial';

/** 补丁描述：字段保存用户输入的原始文本，便于界面回显与方案持久化 */
export interface PatchSpec {
  kind: PatchKind;
  enabled: boolean;
  address: string;
  /** 数值型写入的字节序 */
  le?: boolean;
  // 校验值
  algo?: string;
  start?: string;
  end?: string;
  holes?: 'fill' | 'skip';
  fill?: string;
  // 数值 / 序列号 / 字节 / 文本
  size?: 1 | 2 | 4;
  value?: string;
  step?: string;
  length?: string;
  // 时间戳
  timeFormat?: 'unix' | 'bcd' | 'ascii';
  template?: string;
  /** 界面状态：卡片是否展开 */
  open?: boolean;
}

export interface PatchOptions {
  now?: Date;
  custom?: CrcModel;
}

export interface PatchResult {
  skipped?: boolean;
  address?: number;
  bytes?: Uint8Array;
  warning?: string;
  error?: string;
  field?: string;
}

export interface PatchWrite {
  address: number;
  bytes: Uint8Array;
}

export const PATCH_KINDS: { kind: PatchKind; label: string }[] = [
  { kind: 'checksum', label: '校验值' },
  { kind: 'number', label: '数值' },
  { kind: 'serial', label: '序列号' },
  { kind: 'time', label: '时间戳' },
  { kind: 'text', label: '文本' },
  { kind: 'bytes', label: '字节序列' },
];

function intBytes(v: number, size: number, le: boolean, field: string): Uint8Array {
  const max = 2 ** (8 * size);
  if (!Number.isInteger(v) || v < -max / 2 || v >= max) {
    throw new FieldError(field, `数值超出 ${size * 8} 位范围`);
  }
  if (v < 0) {
    v += max;
  }
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[le ? i : size - 1 - i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function formatTime(template: string, d: Date): string {
  return template.replace(/YYYY|YY|MM|DD|hh|mm|ss/g, t => {
    switch (t) {
      case 'YYYY': return String(d.getFullYear());
      case 'YY': return pad2(d.getFullYear() % 100);
      case 'MM': return pad2(d.getMonth() + 1);
      case 'DD': return pad2(d.getDate());
      case 'hh': return pad2(d.getHours());
      case 'mm': return pad2(d.getMinutes());
      default: return pad2(d.getSeconds());
    }
  });
}

/** 计算单个补丁要写入的字节（不检查目标地址是否有数据） */
export function patchBytes(img: MemoryImage, spec: PatchSpec, address: number, opts: PatchOptions = {}): { bytes: Uint8Array; warning?: string } {
  const le = spec.le ?? true;
  switch (spec.kind) {
    case 'checksum': {
      const info = algoInfo(spec.algo ?? '', opts.custom);
      if (!info) {
        throw new FieldError('algo', '请选择算法');
      }
      const r = parseRange(spec.start, spec.end);
      const fill = spec.holes === 'skip' ? undefined : need(parseByte(spec.fill ?? 'FF'), 'fill', '填充字节无效');
      const res = checksumImage(img, [info.id], r.start, r.end, { fill, le, custom: opts.custom }).results[0];
      if (res.error) {
        throw new FieldError('algo', res.error);
      }
      const bytes = valueBytes(info, res.value!, le);
      const overlap = address < r.end && address + bytes.length > r.start;
      return { bytes, warning: overlap ? '校验范围包含写入地址：结果会随写入值变化' : undefined };
    }
    case 'number':
    case 'serial':
      return { bytes: intBytes(need(parseValue(spec.value), 'value', '数值无效'), spec.size ?? 4, le, 'value') };
    case 'bytes': {
      const b = parseHexBytes(spec.value);
      if (!b) {
        throw new FieldError('value', '请输入十六进制字节，如 DE AD BE EF');
      }
      return { bytes: b };
    }
    case 'text': {
      const t = new TextEncoder().encode(spec.value ?? '');
      const lenText = (spec.length ?? '').trim();
      if (!lenText) {
        if (!t.length) {
          throw new FieldError('value', '文本为空');
        }
        return { bytes: t };
      }
      const len = need(parseValue(lenText), 'length', '长度无效');
      if (len <= 0) {
        throw new FieldError('length', '长度必须大于 0');
      }
      if (t.length > len) {
        throw new FieldError('value', `文本 ${t.length} 字节，超过固定长度 ${len}`);
      }
      const out = new Uint8Array(len);
      out.set(t);
      return { bytes: out };
    }
    case 'time': {
      const now = opts.now ?? new Date();
      if (spec.timeFormat === 'unix') {
        return { bytes: intBytes(Math.floor(now.getTime() / 1000), 4, le, 'timeFormat') };
      }
      if (spec.timeFormat === 'bcd') {
        const digits = formatTime('YYYYMMDDhhmmss', now);
        return { bytes: Uint8Array.from(digits.match(/../g)!.map(x => parseInt(x, 16))) };
      }
      const s = formatTime(spec.template || 'YYYY-MM-DD hh:mm:ss', now);
      return { bytes: new TextEncoder().encode(s) };
    }
  }
}

/** 依次规划补丁：返回逐条结果与要写入的列表；不修改传入的映像。 */
export function planPatches(img: MemoryImage, specs: PatchSpec[], opts: PatchOptions = {}): { results: PatchResult[]; writes: PatchWrite[] } {
  let work: MemoryImage | undefined;
  const writes: PatchWrite[] = [];
  /** 校验值补丁在 writes 中的下标 → 校验范围 */
  const sums = new Map<number, { start: number; end: number }>();
  const results = specs.map((spec): PatchResult => {
    if (!spec.enabled) {
      return { skipped: true };
    }
    try {
      const address = need(parseAddress(spec.address), 'address', '写入地址无效');
      const { bytes, warning } = patchBytes(work ?? img, spec, address, opts);
      const end = address + bytes.length;
      if (!isCovered(img, address, end)) {
        throw new FieldError('address', `0x${hex(address, 8)}–0x${hex(end - 1, 8)} 含地址空洞，不能写入`);
      }
      work ??= cloneImage(img);
      writeBytes(work, address, bytes);
      writes.push({ address, bytes });
      if (spec.kind === 'checksum') {
        sums.set(writes.length - 1, parseRange(spec.start, spec.end));
      }
      return { address, bytes, warning };
    } catch (e) {
      return { error: (e as Error).message, field: e instanceof FieldError ? e.field : undefined };
    }
  });
  // 校验值之后的补丁又改了校验范围内的数据：校验值会过时
  const byWrite = results.filter(r => r.bytes);
  sums.forEach((r, i) => {
    const later = writes.slice(i + 1).some(w => w.address < r.end && w.address + w.bytes.length > r.start);
    if (later) {
      const res = byWrite[i];
      res.warning = [res.warning, '后面的补丁会改动校验范围内的数据，请把校验值补丁移到最后'].filter(Boolean).join('；');
    }
  });
  return { results, writes };
}

export function applyPatches(img: MemoryImage, specs: PatchSpec[], opts: PatchOptions = {}) {
  const plan = planPatches(img, specs, opts);
  plan.writes.forEach(w => writeBytes(img, w.address, w.bytes));
  return plan;
}

/** 已启用的序列号递增一次（按大小回绕），保持用户原有的进制写法 */
export function advanceSerials(specs: PatchSpec[]): PatchSpec[] {
  return specs.map(s => {
    if (s.kind !== 'serial' || !s.enabled) {
      return s;
    }
    const v = parseValue(s.value);
    const step = parseValue(s.step?.trim() ? s.step : '1');
    if (!Number.isFinite(v) || !Number.isFinite(step)) {
      return s;
    }
    const max = 2 ** (8 * (s.size ?? 4));
    const n = (((v + step) % max) + max) % max;
    const text = s.value!.trim();
    const isHex = /^0x/i.test(text);
    const digits = text.replace(/^0x/i, '').replace(/_/g, '').length;
    return { ...s, value: isHex ? '0x' + hex(n, digits) : String(n) };
  });
}

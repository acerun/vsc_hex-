// 映像加工：合并、偏移、裁剪、删除范围、填充、对齐、拆分，以及把这些步骤串成流水线（类似 srec_cat）。
import * as l10n from '@vscode/l10n';
import { MemoryImage, Segment, cloneImage, hex, imageRange, imageSize, normalize, readPieces, writeBytes } from './formats';
import { FieldError, need, parseAddress, parseByte, parseDelta, parseRange, parseValue } from './numbers';
import { PatchOptions, PatchSpec, planPatches } from './patch';

export interface Range {
  start: number;
  end: number;
}

const MAX_ADDR = 0x100000000;
const MAX_FILL = 512 * 1024 * 1024;

const fmt = (a: number) => '0x' + hex(a, 8);

function filled(start: number, end: number, byte: number): Segment {
  if (end - start > MAX_FILL) {
    throw new Error(l10n.t('Fill range of {0} bytes is too large', (end - start).toLocaleString('en-US')));
  }
  return { address: start, data: new Uint8Array(end - start).fill(byte) };
}

export function offsetImage(img: MemoryImage, delta: number): MemoryImage {
  const r = imageRange(img);
  if (r && (r.start + delta < 0 || r.end + delta > MAX_ADDR)) {
    throw new Error(l10n.t('Address out of 32-bit range after offset ({0} {1} {2})', fmt(r.start), delta < 0 ? '-' : '+', fmt(Math.abs(delta))));
  }
  return {
    ...img,
    segments: img.segments.map(s => ({ address: s.address + delta, data: s.data })),
    entry: img.entry === undefined ? undefined : img.entry + delta,
  };
}

export function cropImage(img: MemoryImage, start: number, end: number): MemoryImage {
  return { ...img, segments: readPieces(img, start, end) };
}

export function removeRange(img: MemoryImage, start: number, end: number): MemoryImage {
  return { ...img, segments: [...readPieces(img, 0, start), ...readPieces(img, end, Infinity)] };
}

/** 填充 [start, end)：holes 只填空洞，all 覆盖整个范围 */
export function fillRange(img: MemoryImage, start: number, end: number, byte: number, mode: 'holes' | 'all'): MemoryImage {
  const f = filled(start, end, byte);
  return { ...img, segments: normalize(mode === 'holes' ? [f, ...img.segments] : [...img.segments, f]) };
}

/** 各段起点向下、终点向上对齐到 align 字节，补出的部分用 byte 填充 */
export function alignImage(img: MemoryImage, align: number, byte: number): MemoryImage {
  const pads = img.segments.map(s => {
    const a = Math.floor(s.address / align) * align;
    const b = Math.ceil((s.address + s.data.length) / align) * align;
    return filled(a, b, byte);
  });
  return { ...img, segments: normalize([...pads, ...img.segments]) };
}

/** 两两求各映像之间的地址重叠 */
export function findOverlaps(images: MemoryImage[], limit = 100): (Range & { a: number; b: number })[] {
  const out: (Range & { a: number; b: number })[] = [];
  for (let i = 0; i < images.length; i++) {
    for (let j = i + 1; j < images.length; j++) {
      const x = images[i].segments, y = images[j].segments;
      let p = 0, q = 0;
      while (p < x.length && q < y.length && out.length < limit) {
        const s = Math.max(x[p].address, y[q].address);
        const e = Math.min(x[p].address + x[p].data.length, y[q].address + y[q].data.length);
        if (s < e) {
          out.push({ start: s, end: e, a: i, b: j });
        }
        if (x[p].address + x[p].data.length < y[q].address + y[q].data.length) {
          p++;
        } else {
          q++;
        }
      }
    }
  }
  return out.sort((u, v) => u.start - v.start);
}

export type OverlapPolicy = 'error' | 'overwrite' | 'keep';

export function mergeImages(images: MemoryImage[], policy: OverlapPolicy): MemoryImage {
  const overlaps = findOverlaps(images, 5);
  if (policy === 'error' && overlaps.length) {
    const o = overlaps[0];
    throw new Error(l10n.t('Input {0} and input {1} overlap at {2}–{3}', o.a + 1, o.b + 1, fmt(o.start), fmt(o.end - 1)));
  }
  const order = policy === 'keep' ? [...images].reverse() : images;
  const first = images.find(i => i.entry !== undefined);
  return {
    format: images[0]?.format ?? 'bin',
    segments: normalize(order.flatMap(i => i.segments)),
    entry: first?.entry,
    header: images[0]?.header,
    warnings: [],
  };
}

export type SplitMode = { by: 'segment' } | { by: 'size'; size: number } | { by: 'boundary'; addresses: number[] };

/** 拆分为多个映像；按大小时边界对齐到 size 的整数倍（适合按扇区拆分） */
export function splitImage(img: MemoryImage, mode: SplitMode): { address: number; image: MemoryImage }[] {
  const r = imageRange(img);
  if (!r) {
    return [];
  }
  let cuts: number[];
  if (mode.by === 'segment') {
    return img.segments.map(s => ({ address: s.address, image: { ...img, segments: [s] } }));
  } else if (mode.by === 'size') {
    cuts = [];
    const n = Math.ceil(r.end / mode.size) - Math.floor(r.start / mode.size);
    if (n > 4096) {
      throw new Error(l10n.t('Splitting would produce {0} files, which is too many', n));
    }
    for (let a = Math.floor(r.start / mode.size) * mode.size; a < r.end; a += mode.size) {
      cuts.push(a);
    }
  } else {
    cuts = [r.start, ...mode.addresses.filter(a => a > r.start && a < r.end)].sort((a, b) => a - b);
  }
  return cuts
    .map((a, i) => ({ address: a, image: cropImage(img, a, cuts[i + 1] ?? r.end) }))
    .filter(p => p.image.segments.length)
    .map(p => ({ address: p.image.segments[0].address, image: p.image }));
}

// ---------------- 流水线 ----------------

export type StepOp = 'offset' | 'moveTo' | 'crop' | 'remove' | 'fill' | 'align' | 'patch';

export interface StepSpec {
  op: StepOp;
  enabled: boolean;
  value?: string;
  start?: string;
  end?: string;
  byte?: string;
  mode?: 'holes' | 'all';
  patch?: PatchSpec;
  open?: boolean;
}

// label 用 getter 延迟翻译（模块加载时 l10n 尚未配置）
export const STEP_OPS: { op: StepOp; label: string }[] = [
  { op: 'offset', get label() { return l10n.t('Address offset'); } },
  { op: 'moveTo', get label() { return l10n.t('Move to address'); } },
  { op: 'crop', get label() { return l10n.t('Crop (keep range)'); } },
  { op: 'remove', get label() { return l10n.t('Remove range'); } },
  { op: 'fill', get label() { return l10n.t('Fill'); } },
  { op: 'align', get label() { return l10n.t('Align segments'); } },
  { op: 'patch', get label() { return l10n.t('Write patch'); } },
];

export interface StepResult {
  skipped?: boolean;
  error?: string;
  field?: string;
  warning?: string;
  /** 本步之后的映像概况 */
  info?: string;
  /** 写入补丁的地址与字节 */
  address?: number;
  bytes?: Uint8Array;
}

export interface PipelineInput {
  image: MemoryImage;
  /** 地址偏移（BIN 即为基址），带符号十六进制 */
  offset?: string;
}

export interface PipelineResult {
  image?: MemoryImage;
  error?: string;
  inputs: { image?: MemoryImage; error?: string }[];
  steps: StepResult[];
  overlaps: (Range & { a: number; b: number })[];
}

export function describe(img: MemoryImage): string {
  const r = imageRange(img);
  return r
    ? l10n.t('{0} segments · {1} bytes · {2}–{3}', img.segments.length, imageSize(img).toLocaleString('en-US'), fmt(r.start), fmt(r.end - 1))
    : l10n.t('No data');
}

function runStep(img: MemoryImage, s: StepSpec, opts: PatchOptions): { image: MemoryImage; result: StepResult } {
  const byteOf = () => need(parseByte(s.byte ?? 'FF'), 'byte', l10n.t('Invalid fill byte'));
  switch (s.op) {
    case 'offset':
      return { image: offsetImage(img, need(parseDelta(s.value), 'value', l10n.t('Invalid offset'))), result: {} };
    case 'moveTo': {
      const to = need(parseAddress(s.value), 'value', l10n.t('Invalid target address'));
      const r = imageRange(img);
      return { image: r ? offsetImage(img, to - r.start) : img, result: {} };
    }
    case 'crop': {
      const r = parseRange(s.start, s.end);
      return { image: cropImage(img, r.start, r.end), result: {} };
    }
    case 'remove': {
      const r = parseRange(s.start, s.end);
      return { image: removeRange(img, r.start, r.end), result: {} };
    }
    case 'fill': {
      const r = parseRange(s.start, s.end);
      return { image: fillRange(img, r.start, r.end, byteOf(), s.mode ?? 'holes'), result: {} };
    }
    case 'align': {
      const a = need(parseValue(s.value), 'value', l10n.t('Invalid alignment'));
      if (a < 2 || a > 0x10000000) {
        throw new FieldError('value', l10n.t('Alignment must be between 2 and 0x10000000'));
      }
      return { image: alignImage(img, a, byteOf()), result: {} };
    }
    case 'patch': {
      const p = planPatches(img, [{ ...s.patch!, enabled: true }], opts).results[0];
      if (p.error) {
        return { image: img, result: { error: p.error, field: p.field && 'patch.' + p.field } };
      }
      const out = cloneImage(img);
      writeBytes(out, p.address!, p.bytes!);
      return { image: out, result: { address: p.address, bytes: p.bytes, warning: p.warning } };
    }
  }
}

/** 输入各自偏移 → 合并 → 依次执行步骤；出错的步骤跳过并记录，不中断后续步骤。 */
export function runPipeline(inputs: PipelineInput[], policy: OverlapPolicy, steps: StepSpec[], opts: PatchOptions = {}): PipelineResult {
  const res: PipelineResult = { inputs: [], steps: [], overlaps: [] };
  const shifted: MemoryImage[] = [];
  for (const inp of inputs) {
    try {
      const d = (inp.offset ?? '').trim() ? need(parseDelta(inp.offset), 'offset', l10n.t('Invalid offset')) : 0;
      const image = offsetImage(inp.image, d);
      shifted.push(image);
      res.inputs.push({ image });
    } catch (e) {
      res.inputs.push({ error: (e as Error).message });
    }
  }
  if (!inputs.length) {
    res.error = l10n.t('Add an input file');
    return res;
  }
  if (res.inputs.some(i => i.error)) {
    res.error = l10n.t('An input file has an invalid offset');
    return res;
  }
  res.overlaps = findOverlaps(shifted);
  let img: MemoryImage;
  try {
    img = mergeImages(shifted, policy);
  } catch (e) {
    res.error = (e as Error).message;
    return res;
  }
  for (const s of steps) {
    if (!s.enabled) {
      res.steps.push({ skipped: true });
      continue;
    }
    try {
      const r = runStep(img, s, opts);
      img = r.image;
      res.steps.push({ ...r.result, info: r.result.error ? undefined : describe(img) });
    } catch (e) {
      res.steps.push({ error: (e as Error).message, field: e instanceof FieldError ? e.field : undefined });
    }
  }
  res.image = img;
  return res;
}

import * as l10n from '@vscode/l10n';
import { FormatId, MemoryImage, flatten, hex } from './image';
import { parseSrec, writeSrec } from './srec';
import { parseIhex, writeIhex } from './ihex';
import { parseTiTxt, writeTiTxt } from './titxt';
import { isElf, parseElf, writeElf } from './elf';

export * from './image';

export const FORMAT_INFO: Record<FormatId, { label: string; ext: string }> = {
  bin: { label: 'Binary', ext: 'bin' },
  ihex: { label: 'Intel HEX', ext: 'hex' },
  srec: { label: 'Motorola S-Record', ext: 'srec' },
  titxt: { label: 'TI-TXT', ext: 'txt' },
  elf: { label: 'ELF', ext: 'elf' },
};

/** 按扩展名识别格式，并用内容做二次确认；不匹配时按原始二进制处理。 */
export function detectFormat(fileName: string, bytes: Uint8Array): FormatId {
  const ext = (fileName.match(/\.([^./\\]+)$/)?.[1] ?? '').toLowerCase();
  const head = latin1(bytes.subarray(0, 256)).trimStart();
  if (['hex', 'ihex', 'ihx'].includes(ext) && head.startsWith(':')) {
    return 'ihex';
  }
  if (['srec', 's19', 's28', 's37', 'mot'].includes(ext) && /^S[0-9]/i.test(head)) {
    return 'srec';
  }
  if (ext === 'txt' && head.startsWith('@')) {
    return 'titxt';
  }
  if (isElf(bytes)) {
    return 'elf';
  }
  return 'bin';
}

export function parseImage(fileName: string, bytes: Uint8Array, format = detectFormat(fileName, bytes)): MemoryImage {
  // 复制为独立的 Uint8Array：Node Buffer 的 slice() 只是视图
  bytes = new Uint8Array(bytes);
  switch (format) {
    case 'ihex': return parseIhex(latin1(bytes));
    case 'srec': return parseSrec(latin1(bytes));
    case 'titxt': return parseTiTxt(latin1(bytes));
    case 'elf': return parseElf(bytes);
    default: return { format: 'bin', segments: bytes.length ? [{ address: 0, data: bytes }] : [], warnings: [] };
  }
}

export interface SerializeOptions {
  recordLength?: number;
  fillByte?: number;
  header?: string;
}

export function serializeImage(img: MemoryImage, format: FormatId, opts: SerializeOptions = {}): Uint8Array {
  const rl = opts.recordLength ?? 16;
  switch (format) {
    case 'ihex': return writeIhex(img, rl);
    case 'srec': return writeSrec(img, rl, opts.header ?? img.header ?? '');
    case 'titxt': return writeTiTxt(img, rl);
    case 'elf': return writeElf(img);
    case 'bin': return flatten(img, opts.fillByte ?? 0xff).data;
  }
}

/** 导出为 BIN 时的提示：起始地址非 0 或存在空洞时，地址信息会丢失/被填充。 */
export function binExportNote(img: MemoryImage, fillByte: number): string | undefined {
  const segs = img.segments;
  if (segs.length === 0) {
    return undefined;
  }
  const notes: string[] = [];
  if (segs[0].address !== 0) {
    notes.push(l10n.t('BIN has no address information; start address 0x{0} maps to file offset 0', hex(segs[0].address, 8)));
  }
  if (segs.length > 1) {
    notes.push(l10n.t('{0} address gaps filled with 0x{1}', segs.length - 1, hex(fillByte, 2)));
  }
  return notes.length ? notes.join(l10n.t('; ')) : undefined;
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
}

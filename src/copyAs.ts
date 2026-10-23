// 选中字节 → 各种文本格式。纯函数，不依赖 vscode，便于单元测试。
import * as l10n from '@vscode/l10n';
import { MemoryImage, Segment, hex } from './formats/image';
import { writeIhex } from './formats/ihex';
import { writeSrec } from './formats/srec';
import { writeTiTxt } from './formats/titxt';

export type CopyFormat =
  | 'displayed' | 'hexOctets' | 'hex' | 'literal' | 'utf8'
  | 'c' | 'go' | 'java' | 'json' | 'base64'
  | 'ihex' | 'srec' | 'titxt';

// label 用 getter 延迟翻译（模块加载时 l10n 尚未配置）
export const COPY_FORMATS: { id: CopyFormat; label: string }[] = [
  { id: 'displayed', get label() { return l10n.t('As displayed (1/2/4-byte units)'); } },
  { id: 'hexOctets', label: 'Hex Octets' },
  { id: 'hex', label: 'Hex' },
  { id: 'literal', label: 'Literal' },
  { id: 'utf8', label: 'UTF-8' },
  { id: 'c', label: 'C' },
  { id: 'go', label: 'Go' },
  { id: 'java', label: 'Java' },
  { id: 'json', label: 'JSON' },
  { id: 'base64', label: 'Base64' },
  { id: 'ihex', get label() { return l10n.t('Intel HEX (with addresses)'); } },
  { id: 'srec', get label() { return l10n.t('S-Record (with addresses)'); } },
  { id: 'titxt', get label() { return l10n.t('TI-TXT (with addresses)'); } },
];

export interface CopyOptions {
  unit?: 1 | 2 | 4;
  littleEndian?: boolean;
  name?: string;
}

/** pieces：选区中的有效字节片段（选区跨越地址空洞时会有多段）。 */
export function copyAs(format: CopyFormat, pieces: Segment[], opts: CopyOptions = {}): string {
  const bytes = concat(pieces);
  const name = opts.name ?? 'data';
  // 只在 C / Go 格式时生成：大选区下为每个字节建字符串开销很大
  const items = () => Array.from(bytes, b => '0x' + hex(b, 2));
  switch (format) {
    case 'displayed': return displayed(bytes, opts.unit ?? 1, opts.littleEndian ?? true);
    case 'hexOctets': return Array.from(bytes, b => hex(b, 2)).join(' ');
    case 'hex': return Array.from(bytes, b => hex(b, 2)).join('');
    case 'literal': return Array.from(bytes, b => '\\x' + b.toString(16).padStart(2, '0')).join('');
    case 'utf8': return new TextDecoder('utf-8').decode(bytes);
    case 'c': return `unsigned char ${name}[${bytes.length}] = {${block(items(), ' ')}};`;
    case 'go': return `var ${name} = []byte{${block(items(), '')}}`;
    // Java 的 byte 有符号，>0x7F 的字面量必须强转才能编译
    case 'java': return `byte ${name}[] = {${block(Array.from(bytes, b => (b > 0x7f ? '(byte) 0x' : '0x') + hex(b, 2)), ' ')}};`;
    case 'json': return '[' + Array.from(bytes).join(', ') + ']';
    case 'base64': return Buffer.from(bytes).toString('base64');
    case 'ihex': return new TextDecoder().decode(writeIhex(asImage(pieces)));
    case 'srec': return new TextDecoder().decode(writeSrec(asImage(pieces)));
    case 'titxt': return new TextDecoder().decode(writeTiTxt(asImage(pieces)));
  }
}

function displayed(bytes: Uint8Array, unit: number, le: boolean): string {
  const items: string[] = [];
  for (let i = 0; i < bytes.length; i += unit) {
    const u = Array.from(bytes.subarray(i, i + unit), b => hex(b, 2));
    if (le && u.length === unit) {
      u.reverse();
    }
    items.push(u.join(''));
  }
  return items.join(' ');
}

/** 不超过 16 个元素时单行（pad 为括号内侧空白），否则每 16 个换行，便于粘贴进源码。 */
function block(items: string[], pad: string): string {
  if (items.length <= 16) {
    return pad + items.join(', ') + pad;
  }
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += 16) {
    lines.push('    ' + items.slice(i, i + 16).join(', '));
  }
  return '\n' + lines.join(',\n') + '\n';
}

function concat(pieces: Segment[]): Uint8Array {
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.data.length, 0));
  let o = 0;
  for (const p of pieces) {
    out.set(p.data, o);
    o += p.data.length;
  }
  return out;
}

function asImage(pieces: Segment[]): MemoryImage {
  return { format: 'bin', segments: pieces, warnings: [] };
}

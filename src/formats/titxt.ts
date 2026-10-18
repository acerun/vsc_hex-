// TI-TXT：`@地址` 行设置地址，随后为空格分隔的十六进制字节，`q` 结束。
import * as l10n from '@vscode/l10n';
import { MemoryImage, Segment, normalize, hex } from './image';

export function parseTiTxt(text: string): MemoryImage {
  const chunks: Segment[] = [];
  const warnings: string[] = [];
  let addr = 0;
  let cur: number[] = [];
  let curAddr = 0;
  const flush = () => {
    if (cur.length) {
      chunks.push({ address: curAddr, data: Uint8Array.from(cur) });
    }
    cur = [];
  };
  const lines = text.split(/\r?\n/);
  outer:
  for (let ln = 0; ln < lines.length; ln++) {
    for (const tok of lines[ln].trim().split(/\s+/)) {
      if (tok === '') {
        continue;
      }
      if (tok[0] === '@') {
        flush();
        addr = parseInt(tok.slice(1), 16);
        if (isNaN(addr)) {
          warnings.push(l10n.t('Line {0}: invalid address', ln + 1));
          addr = 0;
        }
        curAddr = addr;
      } else if (tok === 'q' || tok === 'Q') {
        break outer;
      } else if (/^[0-9a-fA-F]{2}$/.test(tok)) {
        cur.push(parseInt(tok, 16));
        addr++;
      } else {
        warnings.push(l10n.t('Line {0}: unrecognized "{1}"', ln + 1, tok));
      }
    }
  }
  flush();
  return { format: 'titxt', segments: normalize(chunks), warnings };
}

export function writeTiTxt(img: MemoryImage, recordLength = 16): string {
  const out: string[] = [];
  for (const s of img.segments) {
    out.push('@' + hex(s.address, s.address > 0xffff ? 8 : 4));
    for (let o = 0; o < s.data.length; o += recordLength) {
      out.push(Array.from(s.data.subarray(o, o + recordLength), b => hex(b, 2)).join(' '));
    }
  }
  out.push('q');
  return out.join('\n') + '\n';
}

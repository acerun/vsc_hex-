// TI-TXT：`@地址` 行设置地址，随后为空格分隔的十六进制字节，`q` 结束。
import * as l10n from '@vscode/l10n';
import { MemoryImage, ChunkBuilder, AsciiWriter, hex } from './image';
import { hexByte } from './srec';

/** 与正则 \s 一致（文本按 latin1 解码，只需考虑 0–255） */
const isSpace = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0;

export function parseTiTxt(text: string): MemoryImage {
  const chunks = new ChunkBuilder();
  const warnings: string[] = [];
  let addr = 0;
  const lines = text.split(/\r?\n/);
  outer:
  for (let ln = 0; ln < lines.length; ln++) {
    // 逐字符切分 token：数据字节占绝大多数，不为它们生成子串
    const line = lines[ln];
    for (let i = 0; i < line.length;) {
      if (isSpace(line.charCodeAt(i))) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < line.length && !isSpace(line.charCodeAt(j))) {
        j++;
      }
      const b = j - i === 2 ? hexByte(line, i) : -1;
      if (b >= 0) {
        chunks.addByte(addr++, b);
        i = j;
        continue;
      }
      const tok = line.slice(i, j);
      i = j;
      if (tok[0] === '@') {
        addr = parseInt(tok.slice(1), 16);
        if (isNaN(addr)) {
          warnings.push(l10n.t('Line {0}: invalid address', ln + 1));
          addr = 0;
        }
      } else if (tok === 'q' || tok === 'Q') {
        break outer;
      } else {
        warnings.push(l10n.t('Line {0}: unrecognized "{1}"', ln + 1, tok));
      }
    }
  }
  return { format: 'titxt', segments: chunks.finish(), warnings };
}

export function writeTiTxt(img: MemoryImage, recordLength = 16): Uint8Array {
  const w = new AsciiWriter();
  for (const s of img.segments) {
    w.text('@' + hex(s.address, s.address > 0xffff ? 8 : 4) + '\n');
    for (let o = 0; o < s.data.length; o += recordLength) {
      const end = Math.min(o + recordLength, s.data.length);
      for (let i = o; i < end; i++) {
        if (i > o) {
          w.text(' ');
        }
        w.hex(s.data[i]);
      }
      w.text('\n');
    }
  }
  w.text('q\n');
  return w.finish();
}

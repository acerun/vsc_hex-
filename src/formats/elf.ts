// 精简 ELF 解析：只取 PT_LOAD 段（按物理地址 p_paddr 放置）和入口点。
import * as l10n from '@vscode/l10n';
import { MemoryImage, Segment, normalize, readBytes } from './image';

export function isElf(bytes: Uint8Array): boolean {
  return bytes.length >= 16 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
}

export function parseElf(bytes: Uint8Array): MemoryImage {
  if (!isElf(bytes)) {
    throw new Error(l10n.t('Not an ELF file'));
  }
  const is64 = bytes[4] === 2;
  const le = bytes[5] !== 2;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const addr = (o: number) => (is64 ? Number(dv.getBigUint64(o, le)) : u32(o));

  const entry = addr(24);
  const phoff = addr(is64 ? 32 : 28);
  const phentsize = u16(is64 ? 54 : 42);
  const phnum = u16(is64 ? 56 : 44);

  const chunks: Segment[] = [];
  const loads: { address: number; offset: number; size: number }[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (p + phentsize > bytes.length) {
      warnings.push(l10n.t('Program header {0} is outside the file', i));
      break;
    }
    if (u32(p) !== 1) {
      continue; // 非 PT_LOAD
    }
    const offset = is64 ? addr(p + 8) : u32(p + 4);
    const paddr = is64 ? addr(p + 24) : u32(p + 12);
    const filesz = is64 ? addr(p + 32) : u32(p + 16);
    if (filesz === 0) {
      continue;
    }
    if (offset + filesz > bytes.length) {
      warnings.push(l10n.t('PT_LOAD segment {0} is outside the file', i));
      continue;
    }
    chunks.push({ address: paddr, data: bytes.slice(offset, offset + filesz) });
    loads.push({ address: paddr, offset, size: filesz });
  }
  return { format: 'elf', segments: normalize(chunks), entry, warnings, elf: { raw: bytes.slice(), loads } };
}

/** 把映像中（可能已编辑）的段数据回写到原始 ELF 文件对应偏移。 */
export function writeElf(img: MemoryImage): Uint8Array {
  if (!img.elf) {
    throw new Error(l10n.t('Can only save as ELF from an ELF file'));
  }
  const out = img.elf.raw.slice();
  for (const l of img.elf.loads) {
    out.set(readBytes(img, l.address, l.address + l.size), l.offset);
  }
  return out;
}

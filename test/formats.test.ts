import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseImage, serializeImage, detectFormat, readBytes, writeBytes, flatten, MemoryImage, FormatId } from '../src/formats';
import { parseIhex } from '../src/formats/ihex';
import { parseSrec } from '../src/formats/srec';
import { parseTiTxt } from '../src/formats/titxt';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

test('Intel HEX：扩展线性地址 + 校验和', () => {
  const img = parseIhex([
    ':020000040800F2',
    ':0400000001020304F2',
    ':04000500AABBCCDDE9',
    ':00000001FF',
  ].join('\n'));
  assert.deepEqual(img.warnings, []);
  assert.equal(img.segments.length, 2);
  assert.equal(img.segments[0].address, 0x08000000);
  assert.deepEqual([...img.segments[0].data], [1, 2, 3, 4]);
  assert.equal(img.segments[1].address, 0x08000005);
});

test('Intel HEX：校验和错误给出警告但仍读出数据', () => {
  const img = parseIhex(':0400000001020304F0\n:00000001FF');
  assert.equal(img.warnings.length, 1);
  assert.match(img.warnings[0], /checksum/);
  assert.deepEqual([...img.segments[0].data], [1, 2, 3, 4]);
});

test('Intel HEX：扩展段地址 (type 02)', () => {
  const img = parseIhex(':020000021000EC\n:0100000055AA\n:00000001FF');
  assert.deepEqual(img.warnings, []);
  assert.equal(img.segments[0].address, 0x10000);
});

test('S-Record：S3 数据 + S7 入口 + S0 头', () => {
  const img = parseSrec([
    'S00600004844521B',
    'S30908000000DEADBEEFB6',
    'S70508000100F1',
  ].join('\n'));
  assert.deepEqual(img.warnings, []);
  assert.equal(img.header, 'HDR');
  assert.equal(img.segments[0].address, 0x08000000);
  assert.deepEqual([...img.segments[0].data], [0xde, 0xad, 0xbe, 0xef]);
  assert.equal(img.entry, 0x08000100);
});

test('S-Record：校验和错误被检出', () => {
  const img = parseSrec('S30908000000DEADBEEF00');
  assert.match(img.warnings[0], /checksum/);
});

test('TI-TXT：多个 @ 段与 q 终止', () => {
  const img = parseTiTxt('@F000\n31 40 00 03\n@FFFE\n00 F0\nq\n@0000\n11');
  assert.equal(img.segments.length, 2);
  assert.equal(img.segments[0].address, 0xf000);
  assert.deepEqual([...img.segments[1].data], [0x00, 0xf0]);
});

test('格式识别：扩展名 + 内容确认', () => {
  assert.equal(detectFormat('a.hex', enc(':00000001FF')), 'ihex');
  assert.equal(detectFormat('a.hex', Uint8Array.of(1, 2, 3)), 'bin'); // 扩展名是 hex 但内容不是
  assert.equal(detectFormat('a.s19', enc('S0030000FC')), 'srec');
  assert.equal(detectFormat('a.txt', enc('@1000\n00\nq')), 'titxt');
  assert.equal(detectFormat('readme.txt', enc('hello')), 'bin');
  assert.equal(detectFormat('a.out', Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0)), 'elf');
});

/** 构造最小 32 位小端 ELF：一个 PT_LOAD 段，paddr 与 vaddr 不同（应使用 paddr）。 */
function makeElf(payload: number[], paddr: number, vaddr: number): Uint8Array {
  const buf = new Uint8Array(52 + 32 + payload.length);
  const dv = new DataView(buf.buffer);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  dv.setUint16(16, 2, true);
  dv.setUint16(18, 40, true);
  dv.setUint32(24, paddr + 1, true); // entry
  dv.setUint32(28, 52, true); // phoff
  dv.setUint16(42, 32, true); // phentsize
  dv.setUint16(44, 1, true); // phnum
  dv.setUint32(52, 1, true); // PT_LOAD
  dv.setUint32(56, 84, true); // offset
  dv.setUint32(60, vaddr, true);
  dv.setUint32(64, paddr, true);
  dv.setUint32(68, payload.length, true);
  dv.setUint32(72, payload.length, true);
  buf.set(payload, 84);
  return buf;
}

test('ELF：按物理地址取 PT_LOAD，编辑后原位回写', () => {
  const raw = makeElf([1, 2, 3, 4], 0x08000000, 0x20000000);
  const img = parseImage('fw.elf', raw);
  assert.equal(img.format, 'elf');
  assert.equal(img.segments[0].address, 0x08000000);
  assert.equal(img.entry, 0x08000001);
  writeBytes(img, 0x08000001, Uint8Array.of(0xaa));
  const out = serializeImage(img, 'elf');
  assert.equal(out.length, raw.length);
  assert.deepEqual([...out.subarray(84)], [1, 0xaa, 3, 4]);
  assert.deepEqual([...out.subarray(0, 84)], [...raw.subarray(0, 84)]);
});

function sample(): MemoryImage {
  // 跨 64K 边界 + 空洞，覆盖写出器的边界处理
  const a = new Uint8Array(40).map((_, i) => i);
  const b = new Uint8Array(5).fill(0x5a);
  return { format: 'bin', segments: [{ address: 0x0800fff0, data: a }, { address: 0x08020000, data: b }], entry: 0x08000101, warnings: [] };
}

for (const fmt of ['ihex', 'srec', 'titxt'] as FormatId[]) {
  test(`互转往返：${fmt} 写出后再解析，数据与地址一致`, () => {
    const src = sample();
    const text = serializeImage(src, fmt, { recordLength: 16 });
    const back = parseImage('x.' + { ihex: 'hex', srec: 'srec', titxt: 'txt' }[fmt as 'ihex'], text);
    assert.equal(back.format, fmt);
    assert.deepEqual(back.warnings, []);
    assert.deepEqual(back.segments.map(s => [s.address, [...s.data]]), src.segments.map(s => [s.address, [...s.data]]));
    if (fmt !== 'titxt') {
      assert.equal(back.entry, src.entry);
    }
  });
}

test('Intel HEX 写出：记录不跨 64K 边界', () => {
  const text = dec(serializeImage(sample(), 'ihex'));
  for (const line of text.trim().split('\n')) {
    const n = parseInt(line.substr(1, 2), 16);
    const off = parseInt(line.substr(3, 4), 16);
    assert.ok(off + n <= 0x10000, line);
  }
});

test('导出 BIN：空洞用填充字节', () => {
  const out = serializeImage(sample(), 'bin', { fillByte: 0xff });
  assert.equal(out.length, 0x08020005 - 0x0800fff0);
  assert.equal(out[40], 0xff);
  assert.equal(out[out.length - 1], 0x5a);
});

test('readBytes 跳过空洞；flatten 返回基址', () => {
  const img = sample();
  assert.equal(readBytes(img, 0x08010000, 0x08020002).length, 24 + 2);
  assert.equal(flatten(img, 0).base, 0x0800fff0);
});

test('参考固件：BIN → HEX → BIN 字节一致', () => {
  const file = path.join(__dirname, '..', '..', 'Reference', '1_PFlash.bin');
  if (!fs.existsSync(file)) {
    return;
  }
  const raw = new Uint8Array(fs.readFileSync(file));
  const hexText = serializeImage(parseImage(file, raw), 'ihex', { recordLength: 32 });
  const back = serializeImage(parseImage('x.hex', hexText), 'bin');
  assert.deepEqual(Buffer.from(back), Buffer.from(raw));
});

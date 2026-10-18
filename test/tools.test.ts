import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryImage, readBytes } from '../src/formats';
import { ALGORITHMS, checksum, checksumImage, formatDigest, algoInfo, valueBytes } from '../src/checksum';
import { parseAddress, parseDelta, parseRange, parseValue, parseHexBytes } from '../src/numbers';
import { PatchSpec, advanceSerials, applyPatches, formatTime, planPatches } from '../src/patch';
import {
  alignImage, cropImage, fillRange, findOverlaps, mergeImages, offsetImage, removeRange, runPipeline, splitImage,
} from '../src/transform';

const enc = (s: string) => new TextEncoder().encode(s);
const hexOf = (b: Uint8Array) => Array.from(b, x => x.toString(16).toUpperCase().padStart(2, '0')).join('');
const img = (...segs: [number, number[]][]): MemoryImage =>
  ({ format: 'bin', segments: segs.map(([address, d]) => ({ address, data: Uint8Array.from(d) })), warnings: [] });
const ranges = (m: MemoryImage) => m.segments.map(s => [s.address, s.address + s.data.length]);

// "123456789" 的标准校验值（reveng CRC 目录）
const CHECK: Record<string, string> = {
  'crc8': 'F4', 'crc8-maxim': 'A1', 'crc8-sae-j1850': '4B', 'crc8-autosar': 'DF',
  'crc16-ccitt-false': '29B1', 'crc16-xmodem': '31C3', 'crc16-kermit': '2189', 'crc16-modbus': '4B37',
  'crc16-arc': 'BB3D', 'crc16-usb': 'B4C8',
  'crc32': 'CBF43926', 'crc32-mpeg2': '0376E6E7', 'crc32c': 'E3069283', 'crc32-bzip2': 'FC891918', 'crc32-autosar': '1697D06A',
};

for (const [id, v] of Object.entries(CHECK)) {
  test(`CRC 校验值：${id}`, () => {
    assert.equal(hexOf(checksum(id, enc('123456789'))), v);
  });
}

test('CRC-32/STM32：按小端 32 位字输入', () => {
  // 内存中的字 0x12345678（小端字节 78 56 34 12）→ STM32 CRC 外设结果 0xDF8A8A2B
  assert.equal(hexOf(checksum('crc32-stm32', Uint8Array.of(0x78, 0x56, 0x34, 0x12))), 'DF8A8A2B');
});

test('自定义 CRC 与预设一致；参数无效时报错', () => {
  const custom = { width: 16, poly: 0x8005, init: 0xffff, refin: true, refout: true, xorout: 0 };
  assert.equal(hexOf(checksum('custom', enc('123456789'), { custom })), '4B37');
  assert.throws(() => checksum('custom', enc('1'), { custom: { ...custom, width: 40 } }), /宽度/);
  assert.equal(algoInfo('custom', { ...custom, width: 8 })?.size, 1);
});

test('校验和与哈希', () => {
  const d = Uint8Array.of(0x01, 0x02, 0x03, 0xff);
  assert.equal(hexOf(checksum('sum8', d)), '05');
  assert.equal(hexOf(checksum('sum8-neg', d)), 'FB');
  assert.equal(hexOf(checksum('xor8', d)), 'FF');
  assert.equal(hexOf(checksum('sum16', d)), '0105');
  assert.equal(hexOf(checksum('sum16w', d, { le: true })), '0104'); // 0x0201 + 0xFF03 = 0x10104
  assert.equal(hexOf(checksum('sum16w', d, { le: false })), '0501'); // 0x0102 + 0x03FF
  assert.equal(hexOf(checksum('sum32w', d, { le: true })), 'FF030201');
  assert.equal(formatDigest(algoInfo('md5')!, checksum('md5', enc('abc'))), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(ALGORITHMS.filter(a => a.group === '哈希').length, 3);
});

test('映像校验：空洞填充 / 跳过，范围外的数据不参与', () => {
  const m = img([0x100, [1, 2]], [0x104, [3]]);
  const fill = checksumImage(m, ['sum8', 'crc32'], 0x100, 0x106, { fill: 0xff });
  assert.equal(fill.count, 6); // 01 02 FF FF 03 FF
  assert.equal(hexOf(fill.results[0].value!), hexOf(checksum('sum8', Uint8Array.of(1, 2, 0xff, 0xff, 3, 0xff))));
  assert.equal(hexOf(fill.results[1].value!), hexOf(checksum('crc32', Uint8Array.of(1, 2, 0xff, 0xff, 3, 0xff))));
  const skip = checksumImage(m, ['sum8'], 0x101, 0x200, {});
  assert.equal(skip.count, 2);
  assert.equal(hexOf(skip.results[0].value!), '05');
  const bad = checksumImage(m, ['nope', 'sum8'], 0x100, 0x102);
  assert.match(bad.results[0].error!, /未知/);
  assert.equal(hexOf(bad.results[1].value!), '03');
});

test('写入字节按字节序排列，哈希保持原样', () => {
  const v = Uint8Array.of(0xca, 0xfe);
  assert.deepEqual([...valueBytes(algoInfo('crc16-modbus')!, v, true)], [0xfe, 0xca]);
  assert.deepEqual([...valueBytes(algoInfo('crc16-modbus')!, v, false)], [0xca, 0xfe]);
  assert.deepEqual([...valueBytes(algoInfo('md5')!, v, true)], [0xca, 0xfe]);
});

test('输入解析：地址 / 偏移 / 数值 / 范围', () => {
  assert.equal(parseAddress('0800_1000'), 0x08001000);
  assert.equal(parseAddress('#4096'), 4096);
  assert.ok(Number.isNaN(parseAddress('xyz')));
  assert.equal(parseDelta('-0x20'), -0x20);
  assert.equal(parseDelta('+1000'), 0x1000);
  assert.equal(parseDelta('#-16'), -16);
  assert.equal(parseValue('0x10'), 16);
  assert.equal(parseValue('-5'), -5);
  assert.equal(parseValue('0b101'), 5);
  assert.deepEqual([...parseHexBytes('DE AD,0xBE ef')!], [0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual(parseRange('1000', '10FF'), { start: 0x1000, end: 0x1100 });
  assert.deepEqual(parseRange('1000', '+100'), { start: 0x1000, end: 0x1100 });
  assert.deepEqual(parseRange('0', '+#16'), { start: 0, end: 16 });
  assert.throws(() => parseRange('2000', '1000'), /大于/);
});

test('补丁：依次规划，后面的 CRC 能看到前面写入的版本号', () => {
  const m = img([0x0, new Array(16).fill(0)]);
  const specs: PatchSpec[] = [
    { kind: 'number', enabled: true, address: '0', size: 4, value: '0x01020304', le: true },
    { kind: 'checksum', enabled: true, address: 'C', algo: 'crc32', start: '0', end: 'B', le: true },
  ];
  const plan = planPatches(m, specs);
  assert.deepEqual([...plan.results[0].bytes!], [4, 3, 2, 1]);
  const expect = checksum('crc32', Uint8Array.of(4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0));
  assert.deepEqual([...plan.results[1].bytes!], [...expect].reverse());
  assert.equal(m.segments[0].data[0], 0); // 规划不修改原映像
  const reversed = planPatches(m, [specs[1], specs[0]]);
  assert.match(reversed.results[0].warning!, /移到最后/);
  assert.equal(plan.results[1].warning, undefined);
  applyPatches(m, specs);
  assert.deepEqual([...readBytes(m, 0xc, 0x10)], [...expect].reverse());
});

test('补丁：空洞 / 越界 / 自包含范围 / 字段错误', () => {
  const m = img([0x0, [0, 0, 0, 0]], [0x10, [0, 0]]);
  const r = planPatches(m, [
    { kind: 'number', enabled: true, address: '2', size: 4, value: '1' },
    { kind: 'number', enabled: true, address: '0', size: 1, value: '256' },
    { kind: 'checksum', enabled: true, address: '0', algo: 'sum8', start: '0', end: '3' },
    { kind: 'bytes', enabled: true, address: 'zz', value: 'AA' },
    { kind: 'number', enabled: false, address: '0', value: '1' },
  ]).results;
  assert.match(r[0].error!, /空洞/);
  assert.equal(r[0].field, 'address');
  assert.equal(r[1].field, 'value');
  assert.match(r[2].warning!, /包含写入地址/);
  assert.equal(r[3].field, 'address');
  assert.ok(r[4].skipped);
});

test('补丁：文本定长、时间戳、负数补码、序列号递增', () => {
  const m = img([0x0, new Array(32).fill(0xff)]);
  const now = new Date(2026, 9, 18, 9, 5, 7);
  const r = planPatches(m, [
    { kind: 'text', enabled: true, address: '0', value: 'v1.2', length: '6' },
    { kind: 'time', enabled: true, address: '8', timeFormat: 'bcd' },
    { kind: 'time', enabled: true, address: '10', timeFormat: 'ascii', template: 'YYMMDD' },
    { kind: 'number', enabled: true, address: '18', size: 2, value: '-2', le: false },
    { kind: 'time', enabled: true, address: '1A', timeFormat: 'unix', le: false },
  ], { now }).results;
  assert.deepEqual([...r[0].bytes!], [0x76, 0x31, 0x2e, 0x32, 0, 0]);
  assert.equal(hexOf(r[1].bytes!), '20261018090507');
  assert.equal(new TextDecoder().decode(r[2].bytes!), '261018');
  assert.deepEqual([...r[3].bytes!], [0xff, 0xfe]);
  assert.equal(r[4].bytes!.length, 4);
  assert.equal(formatTime('hh:mm:ss', now), '09:05:07');

  const s = advanceSerials([
    { kind: 'serial', enabled: true, address: '0', size: 2, value: '0x00FF', step: '1' },
    { kind: 'serial', enabled: true, address: '0', size: 1, value: '255', step: '2' },
    { kind: 'serial', enabled: false, address: '0', value: '7' },
  ]);
  assert.deepEqual(s.map(x => x.value), ['0x0100', '1', '7']);
});

test('加工：偏移 / 裁剪 / 删除 / 填充 / 对齐', () => {
  const m = img([0x10, [1, 2, 3, 4]], [0x20, [5, 6]]);
  assert.deepEqual(ranges(offsetImage(m, 0x100)), [[0x110, 0x114], [0x120, 0x122]]);
  assert.throws(() => offsetImage(m, -0x20), /超出/);
  assert.deepEqual(ranges(cropImage(m, 0x12, 0x21)), [[0x12, 0x14], [0x20, 0x21]]);
  assert.deepEqual(ranges(removeRange(m, 0x11, 0x21)), [[0x10, 0x11], [0x21, 0x22]]);
  const f = fillRange(m, 0x10, 0x22, 0xaa, 'holes');
  assert.deepEqual(ranges(f), [[0x10, 0x22]]);
  assert.deepEqual([...readBytes(f, 0x12, 0x16)], [3, 4, 0xaa, 0xaa]);
  assert.deepEqual([...readBytes(fillRange(m, 0x10, 0x12, 0, 'all'), 0x10, 0x13)], [0, 0, 3]);
  const a = alignImage(m, 0x10, 0xff);
  assert.deepEqual(ranges(a), [[0x10, 0x30]]);
  assert.deepEqual([...readBytes(a, 0x13, 0x15)], [4, 0xff]);
  assert.deepEqual([...readBytes(a, 0x20, 0x22)], [5, 6]);
});

test('加工：合并重叠策略与拆分', () => {
  const a = img([0x0, [1, 1, 1, 1]]);
  const b = img([0x2, [2, 2, 2, 2]]);
  assert.deepEqual(findOverlaps([a, b]).map(o => [o.start, o.end]), [[2, 4]]);
  assert.throws(() => mergeImages([a, b], 'error'), /重叠/);
  assert.deepEqual([...mergeImages([a, b], 'overwrite').segments[0].data], [1, 1, 2, 2, 2, 2]);
  assert.deepEqual([...mergeImages([a, b], 'keep').segments[0].data], [1, 1, 1, 1, 2, 2]);

  const m = img([0x0ff0, new Array(0x30).fill(0)], [0x3000, [1]]);
  assert.deepEqual(splitImage(m, { by: 'size', size: 0x1000 }).map(p => p.address), [0x0ff0, 0x1000, 0x3000]);
  assert.deepEqual(splitImage(m, { by: 'segment' }).map(p => p.address), [0x0ff0, 0x3000]);
  assert.deepEqual(splitImage(m, { by: 'boundary', addresses: [0x1008] }).map(p => ranges(p.image)), [[[0x0ff0, 0x1008]], [[0x1008, 0x1020], [0x3000, 0x3001]]]);
});

test('流水线：Bootloader + App(BIN 基址) → 填充 → 写入 CRC', () => {
  const boot = img([0x08000000, [0xb0, 0xb1]]);
  const app = img([0x0, [0xa0, 0xa1, 0, 0, 0, 0]]);
  const r = runPipeline(
    [{ image: boot }, { image: app, offset: '0800_0004' }],
    'error',
    [
      { op: 'fill', enabled: true, start: '0800_0000', end: '0800_0009', byte: 'FF', mode: 'holes' },
      { op: 'crop', enabled: false, start: '0', end: '1' },
      { op: 'patch', enabled: true, patch: { kind: 'checksum', enabled: true, address: '0800_0006', algo: 'sum8', start: '0800_0000', end: '0800_0005' } },
      { op: 'align', enabled: true, value: 'abc' },
    ],
  );
  assert.equal(r.error, undefined);
  assert.deepEqual(ranges(r.image!), [[0x08000000, 0x0800000a]]);
  // B0 B1 FF FF A0 A1 → sum8 = 0x45
  assert.deepEqual([...readBytes(r.image!, 0x08000006, 0x08000007)], [(0xb0 + 0xb1 + 0xff + 0xff + 0xa0 + 0xa1) & 0xff]);
  assert.ok(r.steps[1].skipped);
  assert.equal(r.steps[3].field, 'value');
  assert.match(r.steps[0].info!, /1 段/);
  assert.equal(boot.segments[0].data.length, 2); // 输入映像不被修改
  assert.deepEqual([...app.segments[0].data], [0xa0, 0xa1, 0, 0, 0, 0]);

  const bad = runPipeline([{ image: boot }, { image: boot }], 'error', []);
  assert.match(bad.error!, /重叠/);
  assert.equal(bad.overlaps.length, 1);
});

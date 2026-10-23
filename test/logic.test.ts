import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { copyAs } from '../src/copyAs';
import { diffImages } from '../src/diff';
import { layoutRanges, layoutDiffOnly, totalRows } from '../src/layout';
import { MemoryImage } from '../src/formats';

const piece = (bytes: number[], address = 0) => [{ address, data: Uint8Array.from(bytes) }];
const img = (...segs: [number, number[]][]): MemoryImage =>
  ({ format: 'bin', segments: segs.map(([address, d]) => ({ address, data: Uint8Array.from(d) })), warnings: [] });

test('Copy As：AGENTS.md 中的示例格式', () => {
  const p = piece([0x00, 0x01, 0x02, 0xff]);
  assert.equal(copyAs('hexOctets', p), '00 01 02 FF');
  assert.equal(copyAs('hex', p), '000102FF');
  assert.equal(copyAs('literal', p), '\\x00\\x01\\x02\\xff');
  assert.equal(copyAs('c', p), 'unsigned char data[4] = { 0x00, 0x01, 0x02, 0xFF };');
  assert.equal(copyAs('go', p), 'var data = []byte{0x00, 0x01, 0x02, 0xFF}');
  assert.equal(copyAs('java', p), 'byte data[] = { 0x00, 0x01, 0x02, (byte) 0xFF };');
  assert.equal(copyAs('json', p), '[0, 1, 2, 255]');
  assert.equal(copyAs('base64', p), 'AAEC/w==');
  assert.equal(copyAs('utf8', piece([...new TextEncoder().encode('Hello World')])), 'Hello World');
});

test('Copy As：按显示单元复制随 1/2/4 字节与字节序变化', () => {
  const p = piece([0x00, 0x00, 0x00, 0x20, 0x01, 0x04, 0x00, 0x00]);
  assert.equal(copyAs('displayed', p, { unit: 1 }), '00 00 00 20 01 04 00 00');
  assert.equal(copyAs('displayed', p, { unit: 4, littleEndian: true }), '20000000 00000401');
  assert.equal(copyAs('displayed', p, { unit: 4, littleEndian: false }), '00000020 01040000');
  assert.equal(copyAs('displayed', p, { unit: 2, littleEndian: true }), '0000 2000 0401 0000');
});

test('Copy As：Intel HEX 保留选区地址', () => {
  const text = copyAs('ihex', piece([1, 2], 0x08000010));
  assert.match(text, /^:020000040800F2\n:020010000102EB\n/);
});

test('Copy As：超过 16 字节的 C 数组按 16 个一行换行', () => {
  const text = copyAs('c', piece(new Array(20).fill(0)));
  assert.equal(text.split('\n').length, 4);
});

test('diff：值不同与一侧缺失都算差异，近距离差异合并为一块', () => {
  const a = img([0, [1, 2, 3, 4, 5, 6, 7, 8]], [0x100, [9, 9]]);
  const b = img([0, [1, 0, 3, 0, 5, 6, 7, 8]]);
  const r = diffImages(a, b);
  assert.equal(r.diffBytes, 2 + 2);
  assert.deepEqual(r.blocks, [{ start: 1, end: 4 }, { start: 0x100, end: 0x102 }]);
});

test('diff：两侧段边界交错时差异块跨边界连续', () => {
  const a = img([0, [1, 2, 3, 4]], [6, [7, 8]]);
  const b = img([2, [3, 0, 5, 6, 7, 8]]);
  const r = diffImages(a, b, 1);
  assert.equal(r.diffBytes, 5);
  assert.deepEqual(r.blocks, [{ start: 0, end: 2 }, { start: 3, end: 6 }]);
});

test('diff：相同文件无差异', () => {
  const a = img([0, [1, 2, 3]]);
  const r = diffImages(a, img([0, [1, 2, 3]]));
  assert.equal(r.diffBytes, 0);
  assert.deepEqual(r.blocks, []);
});

test('布局：空洞产生 gap 行，同一行内的空洞不产生', () => {
  const runs = layoutRanges([{ start: 0, end: 20 }, { start: 24, end: 40 }, { start: 0x1000, end: 0x1010 }]);
  assert.deepEqual(runs, [
    { kind: 'rows', addr: 0, count: 3 },
    { kind: 'gap', from: 48, to: 0x1000 },
    { kind: 'rows', addr: 0x1000, count: 1 },
  ]);
});

test('差异视图：相同区 ≥256 字节且距差异 ≥64 字节才折叠', () => {
  const union = [{ start: 0, end: 0x10000 }];
  // 两个差异相距 0x200：去掉各 64 字节上下文后剩 0x180 ≥ 256 → 折叠
  const far = layoutDiffOnly([{ start: 0x1000, end: 0x1001 }, { start: 0x1200, end: 0x1201 }], union);
  assert.equal(far.filter(r => r.kind === 'fold').length, 1);
  // 相距 0x120：中间相同区 < 256 → 不折叠，显示为连续行
  const near = layoutDiffOnly([{ start: 0x1000, end: 0x1001 }, { start: 0x1120, end: 0x1121 }], union);
  assert.equal(near.length, 1);
  assert.equal(near[0].kind, 'rows');
  assert.equal(totalRows(near), (0x1130 + 64 - (0x1000 - 64)) / 16);
});

test('差异视图：无差异时为空', () => {
  assert.deepEqual(layoutDiffOnly([], [{ start: 0, end: 16 }]), []);
});

test('报告：包含摘要、差异字节高亮与折叠行', async () => {
  const { buildReport } = await import('../src/report');
  const a = img([0, new Array(0x400).fill(0)]);
  const b = img([0, new Array(0x400).fill(0)]);
  b.segments[0].data[0x10] = 0xab;
  b.segments[0].data[0x3f0] = 0xcd;
  const html = buildReport({ name: 'a.bin', path: '/a.bin', image: a }, { name: 'b.bin', path: '/b.bin', image: b }, diffImages(a, b));
  assert.match(html, /Different bytes: <b>2<\/b>/);
  assert.match(html, /<span class="d">AB<\/span>/);
  assert.match(html, /bytes identical/);
});

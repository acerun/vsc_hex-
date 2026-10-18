// 文案本地化检查：源码中的英文原文都要有中文译文，译文不能有多余条目，代码里不能残留中文文案。
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..', '..');
const bundle: Record<string, string> = JSON.parse(fs.readFileSync(path.join(root, 'l10n', 'bundle.l10n.zh-cn.json'), 'utf8'));

function files(dir: string, ext: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? files(path.join(dir, e.name), ext) : e.name.endsWith(ext) ? [path.join(dir, e.name)] : []);
}
const sources = [...files('src', '.ts'), ...files('media', '.js')].map(f => ({ f, text: fs.readFileSync(path.join(root, f), 'utf8') }));

/** 去掉注释（近似：块注释、行首或空白后的 // 注释） */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/** 扩展侧 l10n.t('...')，webview 侧 t('...')；第一个参数必须是字符串字面量 */
function keysOf(f: string, text: string): string[] {
  const lit = String.raw`('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")`;
  const re = new RegExp((f.endsWith('.ts') ? String.raw`\bl10n\.t\(\s*` : String.raw`(?<![.\w$])t\(\s*`) + lit, 'g');
  return [...stripComments(text).matchAll(re)].map(m => Function(`return ${m[1]}`)() as string);
}

const used = new Map<string, string>();
for (const { f, text } of sources) {
  for (const k of keysOf(f, text)) {
    used.set(k, f);
  }
}

test('l10n：每条原文都有中文译文，占位符一致', () => {
  const missing = [...used].filter(([k]) => !(k in bundle)).map(([k, f]) => `${f}: ${JSON.stringify(k)}`);
  assert.deepEqual(missing, []);
  const ph = (s: string) => [...s.matchAll(/\{\d+\}/g)].map(m => m[0]).sort().join();
  const bad = Object.entries(bundle).filter(([k, v]) => ph(k) !== ph(v)).map(([k]) => k);
  assert.deepEqual(bad, []);
});

test('l10n：译文没有未使用的条目', () => {
  assert.deepEqual(Object.keys(bundle).filter(k => !used.has(k)), []);
});

test('l10n：代码中没有残留中文文案（注释除外）', () => {
  const left = sources.flatMap(({ f, text }) => stripComments(text).split('\n')
    .map((line, i) => [i, line] as const).filter(([, line]) => /[\u4e00-\u9fff]/.test(line)).map(([i, line]) => `${f}:${i + 1}: ${line.trim()}`));
  assert.deepEqual(left, []);
});

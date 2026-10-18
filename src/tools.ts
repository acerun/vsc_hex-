// 侧面板「校验」「补丁」的扩展侧处理：编辑器与对比面板的 webview 消息转到这里，计算交给纯模块。
import * as vscode from 'vscode';
import { ALGORITHMS, CUSTOM_CRC, CrcModel, algoInfo, checksumImage, formatDigest, validateCrcModel } from './checksum';
import { FieldError, need, parseAddress, parseByte, parseRange, parseValue } from './numbers';
import { PatchResult, PatchSpec, advanceSerials, planPatches } from './patch';
import { hex } from './formats';
import { HexTarget } from './webview';

const ALGOS_KEY = 'HexPlusPlus.checksum.algorithms';
const CUSTOM_KEY = 'HexPlusPlus.checksum.customCrc';
const PATCH_KEY = 'HexPlusPlus.patches:';
const DEFAULT_ALGOS = ['crc32', 'crc32-stm32', 'crc16-ccitt-false', 'crc16-modbus', 'sum8', 'sha256'];

export interface CustomCrcText {
  width: string;
  poly: string;
  init: string;
  xorout: string;
  refin: boolean;
  refout: boolean;
}

const DEFAULT_CUSTOM: CustomCrcText = { width: '32', poly: '04C11DB7', init: 'FFFFFFFF', xorout: 'FFFFFFFF', refin: true, refout: true };

let ctx: vscode.ExtensionContext;

export function initTools(c: vscode.ExtensionContext) {
  ctx = c;
}

export function customCrc(): CrcModel | undefined {
  const t = ctx.globalState.get<CustomCrcText>(CUSTOM_KEY, DEFAULT_CUSTOM);
  const m = { width: parseValue(t.width), poly: parseAddress(t.poly), init: parseAddress(t.init), xorout: parseAddress(t.xorout), refin: t.refin, refout: t.refout };
  return validateCrcModel(m) ? undefined : m;
}

export function fillByte(): number {
  return vscode.workspace.getConfiguration('HexPlusPlus').get('export.fillByte', 0xff);
}

/** 传给 webview 的结果：字节转成十六进制文本 */
export function resultPayload(r: PatchResult & { info?: string }) {
  const b = r.bytes;
  return {
    skipped: r.skipped, error: r.error, field: r.field, warning: r.warning, info: r.info, address: r.address,
    hex: b ? Array.from(b.subarray(0, 24), x => hex(x, 2)).join(' ') + (b.length > 24 ? ` …（共 ${b.length} 字节）` : '') : undefined,
  };
}

export function algoList() {
  return ALGORITHMS.map(a => ({ id: a.id, name: a.name, group: a.group, numeric: a.numeric, note: a.note }));
}

/** init 消息中的工具数据 */
export function toolsPayload(uri: vscode.Uri | undefined, canPatch: boolean) {
  return {
    algos: algoList(),
    selected: ctx.globalState.get<string[]>(ALGOS_KEY, DEFAULT_ALGOS),
    custom: ctx.globalState.get<CustomCrcText>(CUSTOM_KEY, DEFAULT_CUSTOM),
    patches: uri ? loadPatches(uri) : [],
    canPatch,
    fill: hex(fillByte(), 2),
  };
}

function loadPatches(uri: vscode.Uri): PatchSpec[] {
  return ctx.workspaceState.get<PatchSpec[]>(PATCH_KEY + uri.toString(), []);
}

function savePatches(uri: vscode.Uri, list: PatchSpec[]) {
  return ctx.workspaceState.update(PATCH_KEY + uri.toString(), list.length ? list : undefined);
}

function post(t: HexTarget, msg: unknown) {
  return t.panel.webview.postMessage(msg);
}

function checksum(t: HexTarget, m: any) {
  const img = t.imageOf(m.side ?? 0);
  try {
    const r = parseRange(m.start, m.end);
    const fill = m.skip ? undefined : need(parseByte(m.fill), 'fill', '填充字节无效');
    const custom = m.algos.includes(CUSTOM_CRC) ? customCrc() : undefined;
    const t0 = Date.now();
    const { results, count } = checksumImage(img, m.algos, r.start, r.end, { fill, le: m.le, custom });
    post(t, {
      type: 'checksumResult', req: m.req, start: r.start, end: r.end, count, ms: Date.now() - t0,
      results: results.map(x => {
        const info = algoInfo(x.id, custom);
        return { id: x.id, name: info?.name ?? x.id, error: x.error ?? (x.id === CUSTOM_CRC && !custom ? '自定义 CRC 参数无效' : undefined), text: x.value && info ? formatDigest(info, x.value) : '' };
      }),
    });
  } catch (e) {
    post(t, { type: 'checksumResult', req: m.req, error: (e as Error).message, field: e instanceof FieldError ? e.field : undefined });
  }
}

function previewPatches(t: HexTarget, list: PatchSpec[]) {
  const plan = planPatches(t.imageOf(0), list, { custom: customCrc() });
  post(t, { type: 'patchPreview', results: plan.results.map(resultPayload) });
  return plan;
}

async function applyPatchList(t: HexTarget, m: any) {
  if (!t.docUri || !t.applyWrites) {
    return;
  }
  const list: PatchSpec[] = m.patches ?? loadPatches(t.docUri);
  await savePatches(t.docUri, list);
  if (m.ro) {
    const go = '切换为读写并应用';
    if (await vscode.window.showWarningMessage('Hex++: 当前为只读模式，应用补丁会修改文件内容。', go) !== go) {
      return;
    }
    post(t, { type: 'setReadOnly', ro: false });
  }
  const plan = planPatches(t.imageOf(0), list, { custom: customCrc() });
  const errors = plan.results.filter(r => r.error).length;
  if (plan.writes.length) {
    t.applyWrites(plan.writes, '应用补丁');
  }
  // 序列号在写入成功后递增
  if (plan.writes.length && list.some(s => s.kind === 'serial' && s.enabled)) {
    const next = advanceSerials(list);
    await savePatches(t.docUri, next);
    post(t, { type: 'patches', patches: next });
    previewPatches(t, next);
  } else {
    post(t, { type: 'patchPreview', results: plan.results.map(resultPayload) });
  }
  post(t, {
    type: 'flash',
    text: plan.writes.length ? `已写入 ${plan.writes.length} 处补丁${errors ? `，${errors} 处有错误未写入` : ''}（Ctrl+Z 撤销，Ctrl+S 保存）` : '没有可写入的补丁',
  });
}

async function exportPatches(t: HexTarget) {
  if (!t.docUri) {
    return;
  }
  const target = await vscode.window.showSaveDialog({
    defaultUri: t.docUri.with({ path: t.docUri.path.replace(/\.[^./]*$/, '') + '.patch.json' }),
    filters: { 'Hex++ 补丁方案': ['json'] },
    title: '导出补丁方案',
  });
  if (target) {
    const list = loadPatches(t.docUri).map(({ open, ...p }) => p);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(JSON.stringify({ hexpp: 'patches', version: 1, patches: list }, null, 2)));
    vscode.window.setStatusBarMessage(`Hex++: 已导出 ${list.length} 条补丁`, 3000);
  }
}

async function importPatches(t: HexTarget) {
  if (!t.docUri) {
    return;
  }
  const pick = await vscode.window.showOpenDialog({ filters: { 'Hex++ 补丁方案': ['json'] }, title: '导入补丁方案', defaultUri: vscode.Uri.joinPath(t.docUri, '..') });
  if (!pick?.[0]) {
    return;
  }
  try {
    const j = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(pick[0])));
    const list: PatchSpec[] = Array.isArray(j) ? j : j.patches;
    if (!Array.isArray(list) || list.some(p => typeof p?.kind !== 'string')) {
      throw new Error('不是补丁方案文件');
    }
    await savePatches(t.docUri, list);
    post(t, { type: 'patches', patches: list });
    previewPatches(t, list);
  } catch (e) {
    vscode.window.showErrorMessage(`Hex++: 导入失败：${(e as Error).message}`);
  }
}

/** 处理工具相关消息；返回 true 表示已处理 */
export async function handleToolMessage(t: HexTarget, m: any): Promise<boolean> {
  switch (m.type) {
    case 'checksum': checksum(t, m); return true;
    case 'toolsState':
      await ctx.globalState.update(ALGOS_KEY, m.selected);
      await ctx.globalState.update(CUSTOM_KEY, m.custom);
      return true;
    case 'clipboard':
      await vscode.env.clipboard.writeText(m.text);
      vscode.window.setStatusBarMessage(`Hex++: 已复制 ${m.text}`, 3000);
      return true;
    case 'patchSave':
      if (t.docUri) {
        await savePatches(t.docUri, m.patches);
        previewPatches(t, m.patches);
      }
      return true;
    case 'patchPreview':
      if (t.docUri) {
        previewPatches(t, loadPatches(t.docUri));
      }
      return true;
    case 'patchApply': await applyPatchList(t, m); return true;
    case 'patchExport': await exportPatches(t); return true;
    case 'patchImport': await importPatches(t); return true;
  }
  return false;
}

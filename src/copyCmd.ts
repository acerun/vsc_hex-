// 复制命令：Ctrl+C 按配置格式复制；Copy As 弹出带预览的格式列表，最近使用的排在最前。
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { COPY_FORMATS, CopyFormat, copyAs } from './copyAs';
import { readPieces, hex } from './formats';
import { HexTarget } from './webview';

const LAST_KEY = 'HexPlusPlus.lastCopyFormat';
let memento: vscode.Memento | undefined;

export function initCopy(ctx: vscode.ExtensionContext) {
  memento = ctx.globalState;
}

function pieces(t: HexTarget) {
  const s = t.selection;
  return readPieces(t.imageOf(s.side), s.start, s.end);
}

function varName(t: HexTarget) {
  const n = t.nameOf(t.selection.side).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(n) ? n : 'data';
}

function render(t: HexTarget, fmt: CopyFormat) {
  return copyAs(fmt, pieces(t), { unit: t.selection.unit, littleEndian: t.selection.le, name: varName(t) });
}

async function write(t: HexTarget, fmt: CopyFormat) {
  const p = pieces(t);
  const n = p.reduce((a, x) => a + x.data.length, 0);
  if (n === 0) {
    vscode.window.setStatusBarMessage(l10n.t('Hex++: No data in selection'), 3000);
    return;
  }
  await vscode.env.clipboard.writeText(render(t, fmt));
  const label = COPY_FORMATS.find(f => f.id === fmt)?.label ?? fmt;
  vscode.window.setStatusBarMessage(l10n.t('Hex++: Copied {0} bytes ({1})', n.toLocaleString('en-US'), label), 3000);
}

export async function copySelection(t: HexTarget) {
  const fmt = vscode.workspace.getConfiguration('HexPlusPlus').get<CopyFormat>('copy.defaultFormat', 'displayed');
  await write(t, fmt);
}

export async function copySelectionAs(t: HexTarget) {
  if (pieces(t).length === 0) {
    vscode.window.setStatusBarMessage(l10n.t('Hex++: No data in selection'), 3000);
    return;
  }
  const last = memento?.get<CopyFormat>(LAST_KEY);
  const items = COPY_FORMATS
    .map(f => {
      const preview = render(t, f.id).replace(/\s*\n\s*/g, ' ⏎ ');
      return { label: f.label, id: f.id, detail: preview.length > 90 ? preview.slice(0, 90) + '…' : preview };
    })
    .sort((a, b) => Number(b.id === last) - Number(a.id === last));
  const pick = await vscode.window.showQuickPick(items, { title: l10n.t('Hex++: Copy As'), placeHolder: l10n.t('Select a format (preview below)'), matchOnDetail: false });
  if (pick) {
    await memento?.update(LAST_KEY, pick.id);
    await write(t, pick.id);
  }
}

export async function copyOffset(t: HexTarget, radix: 16 | 10) {
  const a = t.selection.cursor;
  const text = radix === 16 ? '0x' + hex(a, 8) : String(a);
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(l10n.t('Hex++: Copied offset {0}', text), 3000);
}

// webview 公共部分：HTML 模板、传给前端的数据结构、当前活动视图的登记。
import * as vscode from 'vscode';
import { FORMAT_INFO, MemoryImage, hex, imageSize } from './formats';

export interface Selection {
  side: number;
  start: number;
  end: number;
  cursor: number;
  unit: 1 | 2 | 4;
  le: boolean;
  ro?: boolean;
}

/** 命令作用的对象：当前获得焦点的 Hex++ 编辑器或对比面板 */
export interface HexTarget {
  panel: vscode.WebviewPanel;
  selection: Selection;
  /** 选区所在一侧的映像 */
  imageOf(side: number): MemoryImage;
  nameOf(side: number): string;
  /** 单文件编辑器对应的文件（对比面板没有） */
  docUri?: vscode.Uri;
  fill?(start: number, end: number, pattern: Uint8Array): void;
}

let active: HexTarget | undefined;

export function trackActive(target: HexTarget): vscode.Disposable {
  if (target.panel.active) {
    active = target;
  }
  return target.panel.onDidChangeViewState(e => {
    if (e.webviewPanel.active) {
      active = target;
    } else if (active === target) {
      active = undefined;
    }
  });
}

export function untrack(target: HexTarget) {
  if (active === target) {
    active = undefined;
  }
}

export function activeTarget(): HexTarget | undefined {
  return active;
}

export function defaultSelection(): Selection {
  const cfg = vscode.workspace.getConfiguration('HexPlusPlus');
  return { side: 0, start: 0, end: 1, cursor: 0, unit: cfg.get<1 | 2 | 4>('defaultUnit', 1), le: cfg.get('littleEndian', true) };
}

export function sidePayload(img: MemoryImage, uri: vscode.Uri, meta = '') {
  const size = imageSize(img);
  const segs = img.segments;
  const range = segs.length ? ` · 0x${hex(segs[0].address, 8)}–0x${hex(segs[segs.length - 1].address + segs[segs.length - 1].data.length - 1, 8)}` : '';
  return {
    // 必须是纯 Uint8Array：Node Buffer 经 postMessage 后在 webview 中不再是类型化数组
    segs: segs.map(s => ({ address: s.address, data: new Uint8Array(s.data) })),
    name: uri.path.split('/').pop() ?? uri.toString(),
    path: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
    meta,
    info: `${FORMAT_INFO[img.format].label} · ${segs.length} 段 · ${size.toLocaleString('en-US')} 字节${range}`,
    warnings: img.warnings,
  };
}

export function webviewHtml(webview: vscode.Webview, extUri: vscode.Uri): string {
  const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'hexview.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'hexview.js'));
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
</head>
<body data-vscode-context='{"webviewSection":"hexpp","preventDefaultContextMenuItems":true}'>
<div id="toolbar"></div>
<div id="main">
  <canvas id="overview"></canvas>
  <div id="scroller" tabindex="0">
    <div id="sticky" class="grid"><div id="head"></div><div id="rows"></div></div>
    <div id="spacer"></div>
  </div>
  <div id="inspector" class="hidden"></div>
</div>
<div id="status"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

let warnChannel: vscode.OutputChannel | undefined;
export function showWarnings(title: string, warnings: string[]) {
  warnChannel ??= vscode.window.createOutputChannel('Hex++');
  warnChannel.appendLine(`[${new Date().toLocaleString()}] ${title}`);
  warnings.forEach(w => warnChannel!.appendLine('  ' + w));
  warnChannel.show(true);
}

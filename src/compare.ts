// 对比面板：全部 / 差异、上一个 / 下一个、交换、重载、导出报告。
import * as vscode from 'vscode';
import { MemoryImage, parseImage } from './formats';
import { DiffResult, diffImages } from './diff';
import { layoutDiffOnly, layoutRanges } from './layout';
import { buildReport } from './report';
import { HexTarget, Selection, defaultSelection, sidePayload, webviewHtml, trackActive, untrack, showWarnings } from './webview';
import { copySelection } from './copyCmd';

interface Side {
  uri: vscode.Uri;
  image: MemoryImage;
  meta: string;
}

export class ComparePanel {
  static readonly viewType = 'HexPlusPlus.compare';
  private sides: Side[] = [];
  private diff?: DiffResult;
  private readonly target: HexTarget;

  static async open(ctx: vscode.ExtensionContext, left: vscode.Uri, right: vscode.Uri) {
    const panel = vscode.window.createWebviewPanel(ComparePanel.viewType, '', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    const cmp = new ComparePanel(ctx, panel, [left, right]);
    await cmp.load();
  }

  private constructor(ctx: vscode.ExtensionContext, readonly panel: vscode.WebviewPanel, private uris: vscode.Uri[]) {
    panel.webview.html = webviewHtml(panel.webview, ctx.extensionUri);
    this.target = {
      panel,
      selection: defaultSelection() as Selection,
      imageOf: side => this.sides[side].image,
      nameOf: side => this.sides[side].uri.path.split('/').pop() ?? '',
    };
    const subs = [
      trackActive(this.target),
      panel.webview.onDidReceiveMessage(async m => {
        switch (m.type) {
          case 'ready': this.post(); break;
          case 'sel': this.target.selection = m; break;
          case 'copy': await copySelection(this.target); break;
          case 'swap': this.swap(); break;
          case 'reload': await this.reload(); break;
          case 'report': await this.exportReport(); break;
          case 'showWarnings':
            this.sides.forEach(s => s.image.warnings.length && showWarnings(s.uri.fsPath, s.image.warnings));
            break;
        }
      }),
    ];
    panel.onDidDispose(() => {
      untrack(this.target);
      subs.forEach(d => d.dispose());
      ComparePanel.panels.delete(this);
    });
    ComparePanel.panels.add(this);
  }

  static readonly panels = new Set<ComparePanel>();
  static forPanel(panel: vscode.WebviewPanel) {
    return [...ComparePanel.panels].find(c => c.panel === panel);
  }

  private async load() {
    this.sides = await Promise.all(this.uris.map(async uri => {
      const [bytes, stat] = await Promise.all([vscode.workspace.fs.readFile(uri), vscode.workspace.fs.stat(uri)]);
      const meta = `${new Date(stat.mtime).toLocaleString('zh-CN')}   ${stat.size.toLocaleString('en-US')} 字节`;
      return { uri, image: parseImage(uri.path, bytes), meta };
    }));
    this.diff = diffImages(this.sides[0].image, this.sides[1].image);
    this.updateTitle();
    this.post();
  }

  private updateTitle() {
    const [a, b] = this.sides.map(s => s.uri.path.split('/').pop());
    this.panel.title = `${a} ↔ ${b}`;
  }

  private post() {
    if (!this.diff || this.sides.length < 2) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration('HexPlusPlus');
    const d = this.diff;
    this.panel.webview.postMessage({
      type: 'init',
      mode: 'compare',
      unit: cfg.get('defaultUnit', 1),
      le: cfg.get('littleEndian', true),
      readOnly: true,
      filter: 'all',
      sides: this.sides.map(s => sidePayload(s.image, s.uri, s.meta)),
      layouts: { all: layoutRanges(d.union), diff: layoutDiffOnly(d.blocks, d.union) },
      blocks: d.blocks,
      diffBytes: d.diffBytes,
    });
  }

  swap() {
    this.uris.reverse();
    this.sides.reverse();
    this.updateTitle();
    this.post();
  }

  async reload() {
    try {
      await this.load();
      this.panel.webview.postMessage({ type: 'flash', text: '已重新加载' });
    } catch (e) {
      vscode.window.showErrorMessage(`Hex++: 重新加载失败：${(e as Error).message}`);
    }
  }

  async exportReport() {
    if (!this.diff) {
      return;
    }
    const [a, b] = this.sides;
    const name = (s: Side) => s.uri.path.split('/').pop()!.replace(/\.[^.]*$/, '');
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(a.uri, '..', `${name(a)}_vs_${name(b)}.html`),
      filters: { HTML: ['html'] },
      title: '导出对比报告',
    });
    if (!target) {
      return;
    }
    const side = (s: Side) => ({ name: s.uri.path.split('/').pop()!, path: s.uri.fsPath, image: s.image });
    const html = buildReport(side(a), side(b), this.diff);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(html));
    const open = '在浏览器中打开';
    if (await vscode.window.showInformationMessage(`已导出对比报告：${target.fsPath}`, open) === open) {
      await vscode.env.openExternal(target);
    }
  }
}

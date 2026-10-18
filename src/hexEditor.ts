// 自定义编辑器：HexPlusPlus.hexEdit / HexPlusPlus.firmware（读写，撤销/重做/保存/备份/磁盘变更检测）与 HexPlusPlus.view（只读）。
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { FormatId, MemoryImage, parseImage, serializeImage, readBytes, writeBytes } from './formats';
import { layoutRanges } from './layout';
import {
  HexTarget, Selection, defaultSelection, sidePayload, webviewHtml, trackActive, untrack, showWarnings,
} from './webview';
import { copySelection } from './copyCmd';
import { saveAsFormat, exportOptions } from './convert';
import { handleToolMessage, toolsPayload } from './tools';
import { ProcessPanel } from './processPanel';

export class HexDocument implements vscode.CustomDocument {
  /** 每次从磁盘整体重载后递增，使旧的撤销/重做闭包失效 */
  generation = 0;
  /** 撤销栈位置；与 savedPos 不同即为脏 */
  pos = 0;
  savedPos = 0;
  /** 保存后首次被修改的字节的原值，用于标记"已修改" */
  baseline = new Map<number, number>();
  panel?: vscode.WebviewPanel;
  private ignoreChangeUntil = 0;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onReloadEmitter = new vscode.EventEmitter<void>();
  readonly onReload = this.onReloadEmitter.event;

  private constructor(readonly uri: vscode.Uri, public image: MemoryImage) {}

  static async create(uri: vscode.Uri, backupId?: string): Promise<HexDocument> {
    const src = backupId ? vscode.Uri.parse(backupId) : uri;
    const bytes = await vscode.workspace.fs.readFile(src);
    const doc = new HexDocument(uri, parseImage(uri.path, bytes));
    doc.watch();
    return doc;
  }

  get dirty() {
    return this.pos !== this.savedPos;
  }

  /** 写入并向 webview 推送变化（含每个字节是否仍与保存时不同） */
  apply(addr: number, data: Uint8Array, notify: boolean) {
    writeBytes(this.image, addr, data);
    const flags = Array.from(data, (v, i) => {
      const base = this.baseline.get(addr + i);
      return base !== undefined && base !== v;
    });
    if (notify) {
      this.panel?.webview.postMessage({ type: 'update', addr, data, flags });
    }
  }

  /** 记录一次编辑并通知 VS Code（进入撤销栈、置脏） */
  edit(addr: number, after: Uint8Array, notify: boolean, emitter: vscode.EventEmitter<vscode.CustomDocumentEditEvent<HexDocument>>, label: string) {
    this.editMany([{ address: addr, bytes: after }], notify, emitter, label);
  }

  /** 多处写入合并为一个撤销步骤；跨越空洞的写入被忽略 */
  editMany(writes: { address: number; bytes: Uint8Array }[], notify: boolean,
    emitter: vscode.EventEmitter<vscode.CustomDocumentEditEvent<HexDocument>>, label: string) {
    const steps = writes
      .map(w => ({ addr: w.address, after: w.bytes, before: readBytes(this.image, w.address, w.address + w.bytes.length) }))
      .filter(x => x.before.length === x.after.length);
    if (!steps.length) {
      return;
    }
    for (const x of steps) {
      x.before.forEach((v, i) => {
        if (!this.baseline.has(x.addr + i)) {
          this.baseline.set(x.addr + i, v);
        }
      });
      // 先取 before 再写：同一列表中后面的写入可能覆盖前面的
      x.before = readBytes(this.image, x.addr, x.addr + x.after.length);
      this.apply(x.addr, x.after, notify);
    }
    this.pos++;
    const gen = this.generation;
    emitter.fire({
      document: this,
      label,
      undo: () => { if (gen === this.generation) { [...steps].reverse().forEach(x => this.apply(x.addr, x.before, true)); this.pos--; } },
      redo: () => { if (gen === this.generation) { steps.forEach(x => this.apply(x.addr, x.after, true)); this.pos++; } },
    });
  }

  async save(target = this.uri, format?: FormatId) {
    const fmt = format ?? this.image.format;
    const bytes = serializeImage(this.image, fmt, exportOptions());
    this.ignoreChangeUntil = Date.now() + 2000;
    await vscode.workspace.fs.writeFile(target, bytes);
    if (target.toString() === this.uri.toString()) {
      this.savedPos = this.pos;
      this.baseline.clear();
      this.panel?.webview.postMessage({ type: 'saved' });
    }
  }

  async reload() {
    const bytes = await vscode.workspace.fs.readFile(this.uri);
    this.image = parseImage(this.uri.path, bytes);
    this.generation++;
    this.pos = this.savedPos = 0;
    this.baseline.clear();
    this.onReloadEmitter.fire();
  }

  /** 检测外部程序对文件的修改：未修改时静默重载，有未保存修改时询问 */
  private watch() {
    if (this.uri.scheme !== 'file') {
      return;
    }
    const dir = vscode.Uri.joinPath(this.uri, '..');
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, this.uri.path.split('/').pop()!));
    const onChange = async () => {
      if (Date.now() < this.ignoreChangeUntil) {
        return;
      }
      if (!this.dirty) {
        await this.reload();
        this.panel?.webview.postMessage({ type: 'flash', text: l10n.t('File changed on disk and was reloaded automatically') });
        return;
      }
      const reload = l10n.t('Reload (Discard Changes)');
      const pick = await vscode.window.showWarningMessage(
        l10n.t('{0} was modified by another program, and the editor has unsaved changes.', this.uri.fsPath), reload, l10n.t('Keep My Changes'));
      if (pick === reload) {
        this.panel?.reveal();
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
    };
    this.disposables.push(w, w.onDidChange(onChange), w.onDidCreate(onChange));
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
    this.onReloadEmitter.dispose();
  }
}

/** 另存为时按目标扩展名选择格式；无法识别时保持原格式 */
export function formatForPath(path: string, fallback: FormatId): FormatId {
  const ext = (path.match(/\.([^./\\]+)$/)?.[1] ?? '').toLowerCase();
  if (['hex', 'ihex', 'ihx'].includes(ext)) { return 'ihex'; }
  if (['srec', 's19', 's28', 's37', 'mot'].includes(ext)) { return 'srec'; }
  if (ext === 'txt') { return 'titxt'; }
  if (ext === 'bin') { return 'bin'; }
  if (['elf', 'out'].includes(ext) && fallback === 'elf') { return 'elf'; }
  return fallback;
}

function setupPanel(ctx: vscode.ExtensionContext, doc: HexDocument, panel: vscode.WebviewPanel, editable: boolean,
  emitter?: vscode.EventEmitter<vscode.CustomDocumentEditEvent<HexDocument>>) {
  doc.panel = panel;
  panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
  panel.webview.html = webviewHtml(panel.webview, ctx.extensionUri);
  const cfg = vscode.workspace.getConfiguration('HexPlusPlus');

  const target: HexTarget = {
    panel,
    selection: defaultSelection() as Selection,
    imageOf: () => doc.image,
    nameOf: () => doc.uri.path.split('/').pop() ?? '',
    docUri: doc.uri,
    fill: emitter && ((start, end, pattern) => {
      const data = new Uint8Array(end - start).map((_, i) => pattern[i % pattern.length]);
      doc.edit(start, data, true, emitter, l10n.t('Fill'));
    }),
    applyWrites: emitter && ((writes, label) => doc.editMany(writes, true, emitter, label)),
  };

  const sendInit = () => panel.webview.postMessage({
    type: 'init',
    mode: editable ? 'edit' : 'view',
    unit: cfg.get('defaultUnit', 1),
    le: cfg.get('littleEndian', true),
    readOnly: !editable || cfg.get('readOnlyByDefault', true),
    sides: [sidePayload(doc.image, doc.uri)],
    layouts: { all: layoutRanges(doc.image.segments.map(s => ({ start: s.address, end: s.address + s.data.length }))) },
    edited: [...doc.baseline].filter(([a, v]) => readBytes(doc.image, a, a + 1)[0] !== v).map(([a]) => a),
    tools: toolsPayload(doc.uri, editable),
  });

  const subs: vscode.Disposable[] = [
    trackActive(target),
    doc.onReload(sendInit),
    panel.webview.onDidReceiveMessage(async m => {
      switch (m.type) {
        case 'ready': sendInit(); break;
        case 'sel': target.selection = m; break;
        case 'copy': await copySelection(target); break;
        case 'edit':
          if (editable && emitter) {
            doc.edit(m.addr, Uint8Array.from(m.data), false, emitter, l10n.t('Edit'));
          }
          break;
        case 'saveAs': await saveAsFormat(doc.uri, doc.image); break;
        case 'compareWith': await vscode.commands.executeCommand('HexPlusPlus.compareWith', doc.uri); break;
        case 'showWarnings': showWarnings(doc.uri.fsPath, doc.image.warnings); break;
        case 'process': ProcessPanel.open(ctx, [{ uri: doc.uri, image: doc.image }]); break;
        default: await handleToolMessage(target, m);
      }
    }),
  ];
  panel.onDidDispose(() => {
    untrack(target);
    subs.forEach(d => d.dispose());
    if (doc.panel === panel) {
      doc.panel = undefined;
    }
  });
}

export class HexEditorProvider implements vscode.CustomEditorProvider<HexDocument> {
  static readonly viewType = 'HexPlusPlus.hexEdit';
  /** 同一编辑器的另一个 viewType：仅匹配固件扩展名，priority 为 default（双击默认打开） */
  static readonly firmwareViewType = 'HexPlusPlus.firmware';
  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<HexDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri, open: vscode.CustomDocumentOpenContext): Promise<HexDocument> {
    return HexDocument.create(uri, open.backupId);
  }

  resolveCustomEditor(doc: HexDocument, panel: vscode.WebviewPanel): void {
    setupPanel(this.ctx, doc, panel, true, this.changeEmitter);
  }

  saveCustomDocument(doc: HexDocument): Promise<void> {
    return doc.save();
  }

  async saveCustomDocumentAs(doc: HexDocument, target: vscode.Uri): Promise<void> {
    const fmt = formatForPath(target.path, doc.image.format);
    if (fmt === 'elf' && !doc.image.elf) {
      throw new Error(l10n.t('Only an ELF file can be saved as ELF'));
    }
    await doc.save(target, fmt);
  }

  async revertCustomDocument(doc: HexDocument): Promise<void> {
    await doc.reload();
  }

  async backupCustomDocument(doc: HexDocument, ctx: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    await vscode.workspace.fs.writeFile(ctx.destination, serializeImage(doc.image, doc.image.format, exportOptions()));
    return {
      id: ctx.destination.toString(),
      delete: () => vscode.workspace.fs.delete(ctx.destination).then(undefined, () => undefined),
    };
  }
}

export class HexViewProvider implements vscode.CustomReadonlyEditorProvider<HexDocument> {
  static readonly viewType = 'HexPlusPlus.view';
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): Promise<HexDocument> {
    return HexDocument.create(uri);
  }

  resolveCustomEditor(doc: HexDocument, panel: vscode.WebviewPanel): void {
    setupPanel(this.ctx, doc, panel, false);
  }
}

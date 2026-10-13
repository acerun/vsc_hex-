import * as vscode from 'vscode';
import { HexEditorProvider, HexViewProvider } from './hexEditor';
import { ComparePanel } from './compare';
import { activeTarget } from './webview';
import { copyOffset, copySelection, copySelectionAs, initCopy } from './copyCmd';
import { saveAsFormat } from './convert';

export function activate(ctx: vscode.ExtensionContext) {
  initCopy(ctx);
  const cmd = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(HexEditorProvider.viewType, new HexEditorProvider(ctx), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.window.registerCustomEditorProvider(HexViewProvider.viewType, new HexViewProvider(ctx), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  /** 命令的文件参数：资源管理器传入的 Uri，否则取当前活动编辑器/标签页的文件 */
  const currentUri = (arg?: unknown): vscode.Uri | undefined => {
    if (arg instanceof vscode.Uri) {
      return arg;
    }
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (tab instanceof vscode.TabInputCustom || tab instanceof vscode.TabInputText) {
      return tab.uri;
    }
    return vscode.window.activeTextEditor?.document.uri;
  };
  const pickFile = async (title: string, near?: vscode.Uri) =>
    (await vscode.window.showOpenDialog({ title, canSelectMany: false, defaultUri: near && vscode.Uri.joinPath(near, '..') }))?.[0];

  const post = (msg: unknown) => activeTarget()?.panel.webview.postMessage(msg);
  const withTarget = (fn: (t: NonNullable<ReturnType<typeof activeTarget>>) => unknown) => () => {
    const t = activeTarget();
    return t ? fn(t) : vscode.window.showInformationMessage('Hex++: 请先打开 Hex++ 编辑器或对比视图');
  };
  const withCompare = (fn: (c: ComparePanel) => unknown) => () => {
    const t = activeTarget();
    const c = t && ComparePanel.forPanel(t.panel);
    return c && fn(c);
  };

  cmd('HexPlusPlus.open', async (arg?: unknown) => {
    const uri = currentUri(arg) ?? await pickFile('用 Hex++ 打开');
    if (uri) {
      await vscode.commands.executeCommand('vscode.openWith', uri, HexEditorProvider.viewType);
    }
  });

  cmd('HexPlusPlus.compare', async () => {
    const picked = await vscode.window.showOpenDialog({ title: '选择要比较的文件（可一次选两个）', canSelectMany: true });
    if (!picked?.length) {
      return;
    }
    const right = picked[1] ?? await pickFile('选择第二个文件', picked[0]);
    if (right) {
      await ComparePanel.open(ctx, picked[0], right);
    }
  });

  cmd('HexPlusPlus.compareSelected', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    if (uris?.length === 2) {
      await ComparePanel.open(ctx, uris[0], uris[1]);
    }
  });

  cmd('HexPlusPlus.compareWith', async (arg?: unknown) => {
    const left = currentUri(arg) ?? await pickFile('选择第一个文件');
    if (!left) {
      return;
    }
    const right = await pickFile(`选择与 ${left.path.split('/').pop()} 比较的文件`, left);
    if (right) {
      await ComparePanel.open(ctx, left, right);
    }
  });

  cmd('HexPlusPlus.saveAs', async (arg?: unknown) => {
    const t = activeTarget();
    if (!(arg instanceof vscode.Uri) && t?.docUri) {
      // 来自 Hex++ 编辑器：包含未保存的修改
      return saveAsFormat(t.docUri, t.imageOf(0));
    }
    const uri = currentUri(arg) ?? await pickFile('选择要转换的文件');
    if (uri) {
      await saveAsFormat(uri);
    }
  });

  cmd('HexPlusPlus.copy', withTarget(copySelection));
  cmd('HexPlusPlus.copyAs', withTarget(copySelectionAs));
  cmd('HexPlusPlus.copyOffsetHex', withTarget(t => copyOffset(t, 16)));
  cmd('HexPlusPlus.copyOffsetDec', withTarget(t => copyOffset(t, 10)));
  cmd('HexPlusPlus.goTo', () => post({ type: 'goto' }));
  cmd('HexPlusPlus.find', () => post({ type: 'find' }));
  cmd('HexPlusPlus.unit1', () => post({ type: 'setUnit', unit: 1 }));
  cmd('HexPlusPlus.unit2', () => post({ type: 'setUnit', unit: 2 }));
  cmd('HexPlusPlus.unit4', () => post({ type: 'setUnit', unit: 4 }));
  cmd('HexPlusPlus.toggleReadOnly', () => post({ type: 'toggleReadOnly' }));
  cmd('HexPlusPlus.toggleInspector', () => post({ type: 'toggleInspector' }));

  cmd('HexPlusPlus.selectRange', withTarget(async t => {
    const parse = (v: string) => parseInt(v.trim().replace(/_/g, '').replace(/^0x/i, ''), 16);
    const valid = (v: string) => (/^(0x)?[0-9a-f_]+$/i.test(v.trim()) ? undefined : '请输入十六进制地址');
    const from = await vscode.window.showInputBox({ title: '选择范围：起始地址（含）', value: '0x' + t.selection.start.toString(16).toUpperCase(), validateInput: valid });
    if (from === undefined) {
      return;
    }
    const to = await vscode.window.showInputBox({ title: '选择范围：结束地址（含）', value: '0x' + (t.selection.end - 1).toString(16).toUpperCase(), validateInput: valid });
    if (to === undefined) {
      return;
    }
    const [a, b] = [parse(from), parse(to)].sort((x, y) => x - y);
    t.panel.webview.postMessage({ type: 'selectRange', start: a, end: b + 1 });
  }));

  cmd('HexPlusPlus.fill', withTarget(async t => {
    if (!t.fill) {
      return;
    }
    if (t.selection.ro) {
      vscode.window.showInformationMessage('Hex++: 当前为只读模式，按 Insert 切换为读写后再填充');
      return;
    }
    const input = await vscode.window.showInputBox({
      title: `填充选区（${(t.selection.end - t.selection.start).toLocaleString('en-US')} 字节）`,
      prompt: '十六进制字节序列，按顺序循环填充，如 FF 或 DE AD BE EF',
      value: 'FF',
      validateInput: v => (/^\s*([0-9a-f]{2}\s*)+$/i.test(v) ? undefined : '请输入十六进制字节，如 FF 或 DE AD'),
    });
    if (input) {
      const pattern = Uint8Array.from(input.match(/[0-9a-f]{2}/gi)!.map(x => parseInt(x, 16)));
      t.fill(t.selection.start, t.selection.end, pattern);
    }
  }));

  cmd('HexPlusPlus.compare.next', () => post({ type: 'next' }));
  cmd('HexPlusPlus.compare.prev', () => post({ type: 'prev' }));
  cmd('HexPlusPlus.compare.swap', withCompare(c => c.swap()));
  cmd('HexPlusPlus.compare.reload', withCompare(c => c.reload()));
  cmd('HexPlusPlus.compare.exportReport', withCompare(c => c.exportReport()));
}

export function deactivate() {}

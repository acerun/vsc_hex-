// 另存为 / 格式互转：BIN、Intel HEX、S-Record、TI-TXT 任意互转；ELF 只能原样另存（含编辑）。
import * as vscode from 'vscode';
import { FORMAT_INFO, FormatId, MemoryImage, binExportNote, hex, parseImage, serializeImage } from './formats';

export function exportOptions() {
  const cfg = vscode.workspace.getConfiguration('HexPlusPlus');
  return { recordLength: cfg.get('export.recordLength', 16), fillByte: cfg.get('export.fillByte', 0xff) };
}

export async function saveAsFormat(uri: vscode.Uri, image?: MemoryImage) {
  if (!image) {
    image = parseImage(uri.path, await vscode.workspace.fs.readFile(uri));
  }
  const src = image;
  const targets = (Object.keys(FORMAT_INFO) as FormatId[]).filter(f => f !== 'elf' || src.elf);
  const pick = await vscode.window.showQuickPick(
    targets.map(f => ({
      label: FORMAT_INFO[f].label,
      description: '.' + FORMAT_INFO[f].ext + (f === src.format ? '  （当前格式）' : ''),
      id: f,
    })),
    { title: `Hex++: 另存为 — 源格式 ${FORMAT_INFO[src.format].label}`, placeHolder: '选择目标格式' },
  );
  if (!pick) {
    return;
  }
  const fmt = pick.id;
  let img = src;

  // BIN 不含地址：转为带地址的格式时询问起始地址
  if (src.format === 'bin' && fmt !== 'bin') {
    const input = await vscode.window.showInputBox({
      title: 'Hex++: BIN 起始地址',
      prompt: 'BIN 文件不含地址信息，请输入数据在目标中的起始地址（十六进制），如 0x08000000',
      value: '0x00000000',
      validateInput: v => (/^(0x)?[0-9a-f]{1,8}$/i.test(v.trim().replace(/_/g, '')) ? undefined : '请输入 32 位以内的十六进制地址'),
    });
    if (input === undefined) {
      return;
    }
    const base = parseInt(input.trim().replace(/_/g, '').replace(/^0x/i, ''), 16);
    img = { ...src, segments: src.segments.map(s => ({ address: s.address + base, data: s.data })) };
  }

  const opts = exportOptions();
  let bytes: Uint8Array;
  try {
    bytes = serializeImage(img, fmt, opts);
  } catch (e) {
    vscode.window.showErrorMessage(`Hex++: ${(e as Error).message}`);
    return;
  }

  const base = uri.path.replace(/\.[^./]*$/, '');
  let defaultUri = uri.with({ path: `${base}.${FORMAT_INFO[fmt].ext}` });
  if (defaultUri.toString() === uri.toString()) {
    defaultUri = uri.with({ path: `${base}_copy.${FORMAT_INFO[fmt].ext}` });
  }
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    title: `另存为 ${FORMAT_INFO[fmt].label}`,
    filters: { [FORMAT_INFO[fmt].label]: [FORMAT_INFO[fmt].ext], 'All Files': ['*'] },
  });
  if (!target) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, bytes);

  const note = fmt === 'bin' ? binExportNote(img, opts.fillByte) : undefined;
  const open = '打开';
  const msg = `已保存为 ${FORMAT_INFO[fmt].label}：${target.fsPath}（${bytes.length.toLocaleString('en-US')} 字节）` +
    (note ? `。注意：${note}` : '') +
    (img.entry !== undefined && fmt === 'bin' ? `；入口地址 0x${hex(img.entry, 8)} 未保留` : '');
  const r = await (note ? vscode.window.showWarningMessage(msg, open) : vscode.window.showInformationMessage(msg, open));
  if (r === open) {
    await vscode.commands.executeCommand('vscode.openWith', target, 'HexPlusPlus.hexEdit');
  }
}

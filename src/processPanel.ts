// 固件加工面板：多个输入 → 各自偏移 → 合并 → 步骤列表 → 输出（可拆分），任何修改都即时预览。
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import * as path from 'path';
import { FORMAT_INFO, FormatId, MemoryImage, cloneImage, hex, imageRange, imageSize, parseImage, serializeImage } from './formats';
import { OverlapPolicy, SplitMode, StepSpec, runPipeline, splitImage } from './transform';
import { advanceSerials } from './patch';
import { checksumImage, formatDigest, algoInfo } from './checksum';
import { FieldError, parseAddress, parseByte, parseValue } from './numbers';
import { algoList, customCrc, fillByte, resultPayload } from './tools';
import { exportOptions } from './convert';
import { webviewL10n } from './webview';

interface Input {
  id: number;
  name: string;
  path: string;
  note?: string;
  image: MemoryImage;
}

type SplitBy = 'none' | 'segment' | 'size' | 'boundary';

interface Config {
  inputs: { id: number; offset: string }[];
  policy: OverlapPolicy;
  steps: StepSpec[];
  output: { format: FormatId; recordLength: number; fill: string; split: SplitBy; splitValue: string; path: string };
}

const OUT_FORMATS: FormatId[] = ['ihex', 'srec', 'titxt', 'bin'];
const MAX_RANGES = 2000;

const ranges = (img: MemoryImage) => img.segments.slice(0, MAX_RANGES).map(s => [s.address, s.address + s.data.length]);

export class ProcessPanel {
  static readonly viewType = 'HexPlusPlus.process';
  private readonly inputs = new Map<number, Input>();
  private nextId = 1;
  private config?: Config;

  /** sources：资源管理器选中的文件；来自编辑器时附带当前映像（含未保存修改） */
  static open(ctx: vscode.ExtensionContext, sources: { uri: vscode.Uri; image?: MemoryImage }[]) {
    const panel = vscode.window.createWebviewPanel(ProcessPanel.viewType, l10n.t('Hex++ Firmware Processing'), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.png');
    new ProcessPanel(ctx, panel, sources);
  }

  private constructor(ctx: vscode.ExtensionContext, private readonly panel: vscode.WebviewPanel, private pending: { uri: vscode.Uri; image?: MemoryImage }[]) {
    panel.webview.html = this.html(ctx.extensionUri);
    const sub = panel.webview.onDidReceiveMessage(async m => {
      try {
        switch (m.type) {
          case 'ready': await this.ready(); break;
          case 'addFiles': await this.pickFiles(); break;
          case 'config': this.config = m.config; this.prune(); this.preview(); break;
          case 'browseOutput': await this.browseOutput(); break;
          case 'generate': await this.generate(m.open); break;
          case 'exportRecipe': await this.exportRecipe(); break;
          case 'importRecipe': await this.importRecipe(); break;
          case 'clipboard':
            await vscode.env.clipboard.writeText(m.text);
            vscode.window.setStatusBarMessage(l10n.t('Hex++: Copied {0}', m.text), 3000);
            break;
        }
      } catch (e) {
        vscode.window.showErrorMessage(l10n.t('Hex++: {0}', (e as Error).message));
      }
    });
    panel.onDidDispose(() => sub.dispose());
  }

  private post(msg: unknown) {
    return this.panel.webview.postMessage(msg);
  }

  private async ready() {
    const opts = exportOptions();
    const first = this.pending[0];
    const srcFmt = first?.image?.format;
    this.post({
      type: 'init',
      algos: algoList(),
      formats: OUT_FORMATS.map(f => ({ id: f, label: FORMAT_INFO[f].label, ext: FORMAT_INFO[f].ext })),
      defaults: { recordLength: opts.recordLength, fill: hex(fillByte(), 2), format: srcFmt && srcFmt !== 'elf' && srcFmt !== 'bin' ? srcFmt : undefined },
    });
    const pending = this.pending;
    this.pending = [];
    await this.addSources(pending);
  }

  private async addSources(sources: { uri: vscode.Uri; image?: MemoryImage }[]) {
    const added: Input[] = [];
    for (const s of sources) {
      try {
        const image = s.image ? cloneImage(s.image) : parseImage(s.uri.path, await vscode.workspace.fs.readFile(s.uri));
        const inp: Input = {
          id: this.nextId++,
          name: s.uri.path.split('/').pop() ?? s.uri.toString(),
          path: s.uri.scheme === 'file' ? s.uri.fsPath : s.uri.toString(),
          note: s.image ? l10n.t('From editor (includes unsaved changes)') : undefined,
          image,
        };
        this.inputs.set(inp.id, inp);
        added.push(inp);
      } catch (e) {
        vscode.window.showErrorMessage(l10n.t('Hex++: Cannot read {0}: {1}', s.uri.fsPath, (e as Error).message));
      }
    }
    if (added.length) {
      this.post({ type: 'inputsAdded', inputs: added.map(i => this.inputInfo(i)), suggestPath: this.suggestPath(added[0]) });
    }
  }

  private inputInfo(i: Input) {
    const r = imageRange(i.image);
    return {
      id: i.id, name: i.name, path: i.path, note: i.note,
      format: FORMAT_INFO[i.image.format].label, isBin: i.image.format === 'bin',
      size: imageSize(i.image), segs: i.image.segments.length, start: r?.start, end: r?.end,
      warnings: i.image.warnings.length,
    };
  }

  private suggestPath(i: Input) {
    const p = path.parse(i.path);
    return path.join(p.dir, `${p.name}_out`);
  }

  private prune() {
    const keep = new Set(this.config?.inputs.map(i => i.id));
    [...this.inputs.keys()].filter(id => !keep.has(id)).forEach(id => this.inputs.delete(id));
  }

  private async pickFiles() {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, title: l10n.t('Add Input Files (multiple allowed)'), defaultUri: this.baseDir() });
    if (uris?.length) {
      await this.addSources(uris.map(uri => ({ uri })));
    }
  }

  private baseDir(): vscode.Uri | undefined {
    const first = this.inputs.values().next().value as Input | undefined;
    return first && path.isAbsolute(first.path) ? vscode.Uri.file(path.dirname(first.path)) : undefined;
  }

  /** 执行流水线并计算输出文件列表 */
  private run(cfg: Config) {
    const inputs = cfg.inputs.map(i => ({ image: this.inputs.get(i.id)?.image, offset: i.offset }));
    const res = runPipeline(inputs.filter(i => i.image).map(i => ({ image: i.image!, offset: i.offset })), cfg.policy, cfg.steps, { custom: customCrc() });
    let files: { path: string; address: number; image: MemoryImage }[] = [];
    let outError: string | undefined;
    let outField: string | undefined;
    if (res.image) {
      try {
        const fmt = cfg.output.format;
        const parts = splitImage(res.image, this.splitMode(cfg));
        const base = cfg.output.path.trim().replace(/\.[^./\\]*$/, '');
        if (!base) {
          throw new FieldError('path', l10n.t('Select an output path'));
        }
        const ext = '.' + FORMAT_INFO[fmt].ext;
        files = cfg.output.split === 'none'
          ? parts.map(p => ({ path: base + ext, ...p }))
          : parts.map(p => ({ path: `${base}_${hex(p.address, 8)}${ext}`, ...p }));
        if (fmt === 'bin' && Number.isNaN(parseByte(cfg.output.fill))) {
          throw new FieldError('fill', l10n.t('Invalid fill byte'));
        }
      } catch (e) {
        outError = (e as Error).message;
        outField = e instanceof FieldError ? e.field : undefined;
      }
    }
    return { res, files, outError, outField };
  }

  private splitMode(cfg: Config): SplitMode {
    const v = cfg.output.splitValue;
    switch (cfg.output.split) {
      case 'segment': return { by: 'segment' };
      case 'size': {
        const n = parseValue(v);
        if (!Number.isInteger(n) || n < 16) {
          throw new FieldError('splitValue', l10n.t('Invalid split size (in bytes, e.g. 0x10000 or 65536)'));
        }
        return { by: 'size', size: n };
      }
      case 'boundary': {
        const list = v.split(/[\s,;]+/).filter(Boolean).map(parseAddress);
        if (!list.length || list.some(Number.isNaN)) {
          throw new FieldError('splitValue', l10n.t('Invalid split addresses (hexadecimal, comma-separated)'));
        }
        return { by: 'boundary', addresses: list };
      }
      default: return { by: 'boundary', addresses: [] };
    }
  }

  private preview() {
    if (!this.config) {
      return;
    }
    const cfg = this.config;
    const { res, files, outError, outField } = this.run(cfg);
    let result;
    if (res.image) {
      const r = imageRange(res.image);
      const crc = checksumImage(res.image, ['crc32'], r?.start ?? 0, r?.end ?? 0).results[0].value;
      result = {
        ranges: ranges(res.image), segs: res.image.segments.length, size: imageSize(res.image),
        start: r?.start, end: r?.end, entry: res.image.entry,
        crc: crc ? formatDigest(algoInfo('crc32')!, crc) : '',
      };
    }
    const fill = parseByte(cfg.output.fill);
    this.post({
      type: 'preview',
      error: res.error,
      inputs: cfg.inputs.map((inp, k) => ({ id: inp.id, ranges: res.inputs[k]?.image ? ranges(res.inputs[k].image!) : [], error: res.inputs[k]?.error })),
      steps: res.steps.map(resultPayload),
      overlaps: res.overlaps.slice(0, 50).map(o => [o.start, o.end, o.a, o.b]),
      result,
      outError, outField,
      files: files.map(f => {
        const fr = imageRange(f.image);
        const size = cfg.output.format === 'bin' && fr ? fr.end - fr.start : imageSize(f.image);
        return { name: path.basename(f.path), size, holes: cfg.output.format === 'bin' && !Number.isNaN(fill) && f.image.segments.length > 1 };
      }),
    });
  }

  private async browseOutput() {
    const cfg = this.config;
    const fmt = cfg?.output.format ?? 'ihex';
    const cur = cfg?.output.path.trim();
    const target = await vscode.window.showSaveDialog({
      defaultUri: cur ? vscode.Uri.file(cur.replace(/\.[^./\\]*$/, '') + '.' + FORMAT_INFO[fmt].ext) : this.baseDir(),
      filters: { [FORMAT_INFO[fmt].label]: [FORMAT_INFO[fmt].ext], 'All Files': ['*'] },
      title: l10n.t('Output File'),
    });
    if (target) {
      this.post({ type: 'outputPath', path: target.fsPath });
    }
  }

  private async generate(open: boolean) {
    const cfg = this.config;
    if (!cfg) {
      return;
    }
    const { res, files, outError } = this.run(cfg);
    if (!res.image || outError) {
      vscode.window.showErrorMessage(l10n.t('Hex++: Cannot generate: {0}', res.error ?? outError ?? ''));
      return;
    }
    const stepErr = res.steps.filter(s => s.error).length;
    if (stepErr) {
      const go = l10n.t('Generate Anyway');
      if (await vscode.window.showWarningMessage(l10n.t('Hex++: {0} steps have errors and were skipped.', stepErr), { modal: true }, go) !== go) {
        return;
      }
    }
    if (!files.length) {
      vscode.window.showErrorMessage(l10n.t('Hex++: The result contains no data'));
      return;
    }
    const exists = (await Promise.all(files.map(f => vscode.workspace.fs.stat(vscode.Uri.file(f.path)).then(() => true, () => false)))).filter(Boolean).length;
    if (exists) {
      const go = l10n.t('Overwrite');
      if (await vscode.window.showWarningMessage(l10n.t('Hex++: {0} output files already exist. Overwrite?', exists), { modal: true }, go) !== go) {
        return;
      }
    }
    const opts = { recordLength: cfg.output.recordLength, fillByte: parseByte(cfg.output.fill) };
    for (const f of files) {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(f.path), serializeImage(f.image, cfg.output.format, opts));
    }
    // 序列号在成功生成后递增
    if (cfg.steps.some(s => s.enabled && s.op === 'patch' && s.patch?.kind === 'serial' && s.patch.enabled !== false)) {
      cfg.steps = cfg.steps.map(s => (s.enabled && s.op === 'patch' && s.patch ? { ...s, patch: advanceSerials([{ ...s.patch, enabled: true }])[0] } : s));
      this.post({ type: 'steps', steps: cfg.steps });
      this.preview();
    }
    const first = vscode.Uri.file(files[0].path);
    const msg = files.length === 1 ? l10n.t('Generated {0}', files[0].path) : l10n.t('Generated {0} files: {1}', files.length, path.dirname(files[0].path));
    this.post({ type: 'generated', text: files.length === 1 ? l10n.t('Generated {0}', path.basename(files[0].path)) : l10n.t('Generated {0} files', files.length) });
    if (open) {
      await vscode.commands.executeCommand('vscode.openWith', first, 'HexPlusPlus.hexEdit', vscode.ViewColumn.Beside);
      return;
    }
    const reveal = l10n.t('Reveal in File Explorer'), openIt = l10n.t('Open with Hex++');
    const pick = await vscode.window.showInformationMessage(l10n.t('Hex++: {0}', msg), openIt, reveal);
    if (pick === openIt) {
      await vscode.commands.executeCommand('vscode.openWith', first, 'HexPlusPlus.hexEdit', vscode.ViewColumn.Beside);
    } else if (pick === reveal) {
      await vscode.commands.executeCommand('revealFileInOS', first);
    }
  }

  // ---------------- 方案（JSON，路径相对方案文件） ----------------
  private async exportRecipe() {
    const cfg = this.config;
    if (!cfg) {
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: cfg.output.path ? vscode.Uri.file(cfg.output.path.replace(/\.[^./\\]*$/, '') + '.hexpp.json') : this.baseDir(),
      filters: { [l10n.t('Hex++ Processing Recipe')]: ['json'] },
      title: l10n.t('Export Processing Recipe'),
    });
    if (!target) {
      return;
    }
    const dir = path.dirname(target.fsPath);
    const rel = (p: string) => (path.isAbsolute(p) ? path.relative(dir, p).split(path.sep).join('/') : p);
    const strip = ({ open, ...s }: StepSpec) => (s.patch ? { ...s, patch: (({ open: _o, ...p }) => p)(s.patch) } : s);
    const recipe = {
      hexpp: 'process',
      version: 1,
      inputs: cfg.inputs.map(i => ({ path: rel(this.inputs.get(i.id)?.path ?? ''), offset: i.offset })),
      policy: cfg.policy,
      steps: cfg.steps.map(strip),
      output: { ...cfg.output, path: cfg.output.path ? rel(cfg.output.path) : '' },
    };
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(JSON.stringify(recipe, null, 2)));
    vscode.window.setStatusBarMessage(l10n.t('Hex++: Exported processing recipe {0}', path.basename(target.fsPath)), 3000);
  }

  private async importRecipe() {
    const pick = await vscode.window.showOpenDialog({ filters: { [l10n.t('Hex++ Processing Recipe')]: ['json'] }, title: l10n.t('Import Processing Recipe'), defaultUri: this.baseDir() });
    if (!pick?.[0]) {
      return;
    }
    const j = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(pick[0])));
    if (j?.hexpp !== 'process' || !Array.isArray(j.inputs) || !Array.isArray(j.steps)) {
      throw new Error(l10n.t('Not a Hex++ processing recipe file'));
    }
    const dir = path.dirname(pick[0].fsPath);
    const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(dir, p));
    this.inputs.clear();
    const inputs = [];
    for (const i of j.inputs as { path: string; offset: string }[]) {
      const uri = vscode.Uri.file(abs(i.path));
      try {
        const inp: Input = { id: this.nextId++, name: path.basename(uri.fsPath), path: uri.fsPath, image: parseImage(uri.path, await vscode.workspace.fs.readFile(uri)) };
        this.inputs.set(inp.id, inp);
        inputs.push({ ...this.inputInfo(inp), offset: i.offset ?? '' });
      } catch (e) {
        vscode.window.showWarningMessage(l10n.t('Hex++: Cannot read input file in recipe: {0}', uri.fsPath));
      }
    }
    const output = { ...j.output, path: j.output?.path ? abs(j.output.path) : '' };
    this.post({ type: 'state', inputs, policy: j.policy ?? 'error', steps: j.steps, output });
  }

  private html(extUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', f));
    const wl = webviewL10n(nonce);
    return `<!DOCTYPE html>
<html lang="${wl.lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${media('hexview.css')}" rel="stylesheet">
<link href="${media('tools.css')}" rel="stylesheet">
<link href="${media('process.css')}" rel="stylesheet">
</head>
<body class="process">
${wl.script}
<script nonce="${nonce}" src="${media('toolsui.js')}"></script>
<script nonce="${nonce}" src="${media('process.js')}"></script>
</body>
</html>`;
  }
}

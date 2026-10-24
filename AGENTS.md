# Hex++

VS Code 十六进制查看 / 编辑 / 对比扩展，支持 BIN、Intel HEX、S-Record、TI-TXT、ELF 固件格式。
UI 参考：对比界面参考 Beyond Compare，查看界面参考 J-Flash。

## 开发

```bash
npm install
npm test        # tsc 编译 + node --test 运行 out/test/*.test.js
npm run package # 打包 vsix（含运行时依赖 @vscode/l10n；.vscodeignore 在 node_modules 中只放行它）
```

F5（`.vscode/launch.json` 的 Run Hex++）启动扩展开发宿主，并打开 `Reference/` 作为测试目录，界面语言跟随当前 VS Code。
按语言测试：运行任务「Run Hex++ (English)」/「Run Hex++ (中文)」（`code --locale` 另起独立实例，用 `.vscode-test/` 下的独立用户目录；F5 的调试窗口与当前 VS Code 共用主进程，`--locale` 无效）。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `src/formats/` | 纯逻辑：各格式解析/写出，统一为 `MemoryImage`（按地址排序、互不重叠的段） |
| `src/copyAs.ts` `src/diff.ts` `src/layout.ts` `src/report.ts` | 纯逻辑：复制格式、逐字节对比、行布局（空洞/折叠）、HTML 报告 |
| `src/checksum.ts` `src/patch.ts` `src/transform.ts` `src/numbers.ts` | 纯逻辑：CRC/校验和/哈希、写入补丁、映像加工流水线、地址/数值输入解析 |
| `src/hexEditor.ts` | 自定义编辑器 `HexPlusPlus.hexEdit`（读写）/ `HexPlusPlus.view`（只读）/ `HexPlusPlus.firmware`（同 hexEdit，固件扩展名默认打开） |
| `src/compare.ts` | 对比面板 `HexPlusPlus.compare` |
| `src/convert.ts` `src/copyCmd.ts` `src/extension.ts` `src/webview.ts` | 另存为、复制命令、命令注册、webview 公共部分 |
| `src/tools.ts` | 侧面板「校验」「补丁」的扩展侧消息处理 |
| `src/processPanel.ts` | 固件加工面板 `HexPlusPlus.process` |
| `media/hexview.js` `media/hexview.css` | webview 前端：编辑/查看/对比共用一套虚拟滚动网格与侧面板 |
| `media/toolsui.js` `media/tools.css` | 侧面板与加工面板共用的卡片列表、表单字段、弹出菜单 |
| `media/process.js` `media/process.css` | 固件加工面板前端 |
| `l10n/` | 中文翻译包 `bundle.l10n.zh-cn.json` |
| `.vscode-test/` | 按语言测试时的独立用户目录（不提交、不打包） |
| `test/` | 单元测试（只测纯逻辑，不依赖 vscode） |
| `images/` | 扩展图标（`icon.svg` 为源文件）与 README 截图（不打入 vsix） |
| `Reference/` | UI 参考截图与测试固件 `1_PFlash.bin` / `2_PFlash.bin` |

## 约定

- 纯逻辑模块不得 import `vscode`，以便 `node --test` 直接测试；新逻辑优先放在纯模块并补测试。
- 布局（`Run` 列表）、差异块由扩展侧计算，webview 只负责渲染与交互。
- 传给 webview 的字节必须是纯 `Uint8Array`（Node `Buffer` 经 postMessage 后不再是类型化数组）。
- 中英双语：源码文案一律写英文，中文译文放 `l10n/bundle.l10n.zh-cn.json`（键为英文原文，参数用 `{0}` `{1}`）。
  - 扩展侧与纯逻辑模块统一用 `@vscode/l10n` 的 `l10n.t('...')`（`activate()` 中以 `vscode.l10n.bundle` 配置）；webview 用 `HexppTools.t('...')`（翻译表由 `webviewL10n()` 注入）。
  - 第一个参数必须是字符串字面量；模块顶层常量里不能调用 `l10n.t()`（早于配置执行），需在使用时翻译。
  - 命令标题、配置说明走 `package.nls.json` / `package.nls.zh-cn.json`。
  - `test/l10n.test.ts` 检查：译文齐全、无多余条目、代码中（注释除外）无残留中文。
  - 文档：`README.md`（英文，插件市场显示）与 `README.zh-CN.md`（中文）内容保持同步，截图 / GIF 共用 `images/`（英文界面、暗色主题）。
- 补丁 / 加工步骤的字段保存用户输入的原始文本，由扩展侧纯模块解析，出错时抛 `FieldError(field)` 让界面高亮对应输入框。
- webview CSP 只允许 `cspSource` 样式：HTML 字符串里不能写 `style="..."`，动态样式用 `el.style` 设置。
- 读写编辑器有两个 viewType（`hexEdit` 匹配 `*`、priority option；`firmware` 匹配固件扩展名、priority default），`package.json` 里限定读写的 `when` 条件用 `/^HexPlusPlus\\.(hexEdit|firmware)$/`。
- 地址显示格式 `0000_0000`；2/4 字节单元与数据检查器的字节序由 `HexPlusPlus.littleEndian` 控制。

## 功能

**语言**：界面中英双语，跟随 VS Code 显示语言（`zh-cn` 显示中文，其他语言显示英文）。

**格式**（按扩展名识别，并用内容二次确认，不匹配按 BIN 处理）

| 格式 | 扩展名 | 说明 |
| --- | --- | --- |
| Intel HEX | `.hex` `.ihex` `.ihx` | 记录类型 00–05，校验和检查 |
| S-Record | `.srec` `.s19` `.s28` `.s37` `.mot` | S0–S9，校验和检查 |
| TI-TXT | `.txt` | `@` 地址行，`q` 结束 |
| ELF | 任意（魔数识别） | 32/64 位、大小端，取 `PT_LOAD` 段（按物理地址）与入口点 |
| BIN | 其他 | 从地址 0 开始 |

解析错误不中断，记为警告显示在状态栏。

**查看 / 编辑**
- 按 1 / 2 / 4 字节单元显示（工具栏或 `Ctrl+1/2/4`），可切换大小端。
- `Ctrl+G` 跳转：`0800_1000` / `0x1000`（十六进制）、`#4096`（十进制）、`+10` / `-10`（相对）。
- 查找（`Ctrl+F`）：Hex（`*` / `??` 通配任意字节）、文本、正则，可区分大小写，结果流式显示。
- 数据检查器：Int8–64、Uint8–64、Float、Double。
- 编辑：`Insert` 切换只读/读写，只能覆盖已有字节（不能插入/删除）；撤销/重做、填充（`Ctrl+I`）、热退出备份、外部修改检测。

**复制**
- `Ctrl+C`：默认按当前显示复制（随 1/2/4 字节单元和字节序变化），可由 `HexPlusPlus.copy.defaultFormat` 修改。
- `Ctrl+Alt+C` 复制为（带预览，最近使用的排第一）：

| 格式 | `00 01 02 FF` 的输出 |
| --- | --- |
| Hex Octets | `00 01 02 FF` |
| Hex | `000102FF` |
| Literal | `\x00\x01\x02\xff` |
| C | `unsigned char data[4] = { 0x00, 0x01, 0x02, 0xFF };` |
| Go | `var data = []byte{0x00, 0x01, 0x02, 0xFF}` |
| Java | `byte data[] = { 0x00, 0x01, 0x02, (byte) 0xFF };` |
| JSON | `[0, 1, 2, 255]` |
| Base64 | `AAEC/w==` |
| UTF-8 | 原始文本 |
| Intel HEX / S-Record / TI-TXT | 保留选区地址 |

**另存为 / 格式互转**
- BIN、Intel HEX、S-Record、TI-TXT 任意互转；ELF 只能从 ELF 另存（原位回写编辑）。
- BIN → 带地址格式时询问起始地址；转 BIN 时空洞用 `HexPlusPlus.export.fillByte`（默认 `0xFF`）填充并提示。

**对比**
- 入口：资源管理器多选两个文件右键、单个文件 "Compare With…"、编辑器工具栏 "比较…"。
- 工具栏：全部 / 差异、下一个 `F8` / 上一个 `Shift+F8`、交换、重载 `F5`、导出 HTML 报告。
- 按地址逐字节比较，支持不同格式（如 `.hex` 与 `.elf`）；一侧有数据另一侧为空洞也算差异。
- "差异"视图保留差异前后 64 字节，≥256 字节的相同区域折叠为一行；左侧概览条可点击跳转。

**校验 / 补丁 / 加工**（侧面板「校验」「补丁」，独立的「固件加工」面板）
- 校验：16 种 CRC 预设（含按小端 32 位字输入的 CRC-32/STM32）+ 自定义 CRC、各类校验和、MD5/SHA-1/SHA-256；范围为选区 / 全部 / 自定义（结束含，或 `+长度`），空洞填充或跳过。
- 补丁：校验值、数值、序列号、时间戳、文本、字节序列，按顺序规划后一次写入（一个撤销步骤）；只能写已有字节；方案按文件存在 `workspaceState`。
- 加工：输入偏移 → 合并 → 步骤 → 输出 / 拆分，不修改输入映像；方案 `.hexpp.json` 中路径相对方案文件。
- 对比读取的是磁盘文件，不含编辑器中未保存的修改。

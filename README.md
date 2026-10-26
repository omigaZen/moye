# 墨页 Moye

以 Typora 的即时渲染编辑体验为目标的跨平台、本地 Markdown 编辑器。当前版本为 **0.5.0 开发预览**；验收范围、实际通过记录和待实测项目分别保存在 `docs/`。源码、构建脚本和测试均随交付提供。

当前目标为最新稳定版 Typora 的全部设置与行为兼容，具体见 `docs/Typora设置兼容性.md`。官方稳定发布页基准为 1.14.10（2026-10-25，Asia/Shanghai）。0.5.0 的设置模型包含 **72 项配置：70 项可见设置和 2 项排版方案内部字段**，支持 36 个命令的快捷键配置。新增独立阅读模式、TXT 章节阅读、工作区文件树与标签、PDF/PNG 导出、排版方案和配色编辑器，并补充表格、图片和代码展示。0.5.0继续加入独立最近文件、中英文切换、长TXT分段、下一篇提示、复杂内联断行和真实Linux缩略图提供程序。Telari 体验对照及实现边界见 `docs/Telari体验对照.md`。尚未完成 Typora 全部设置、默认值与逐步行为对照，也不声称已经完整复刻 Telari。

原版参考获取取得了新的事实：官方 Linux 浮动下载包的实际元数据为 1.14.9，与稳定发布页顶部 1.14.10 不同；原版运行受当前环境限制，尚未取得 UI 和默认值。详细记录见 `tests/typora-reference-report.json`。

## 下载（0.5.0 开发预览）

| 平台 | 发布包 | 启动方式 |
| --- | --- | --- |
| Windows x64 | [下载 ZIP](https://github.com/omigaZen/moye/releases/download/v0.5.0/Moye-0.5.0-Windows-x64.zip) | 解压后运行 `Moye.exe` |
| Linux x64 | [下载 tar.gz](https://github.com/omigaZen/moye/releases/download/v0.5.0/Moye-0.5.0-Linux-x64.tar.gz) | 解压保留权限，运行 `start-moye.sh` |
| macOS Intel | [下载 ZIP](https://github.com/omigaZen/moye/releases/download/v0.5.0/Moye-0.5.0-macOS-x64.zip) | 解压后运行 `Moye.app` |
| macOS Apple Silicon | [下载 ZIP](https://github.com/omigaZen/moye/releases/download/v0.5.0/Moye-0.5.0-macOS-arm64.zip) | 解压后运行 `Moye.app` |

[发布说明与全部附件](https://github.com/omigaZen/moye/releases/tag/v0.5.0) · [完整离线源码 ZIP](https://github.com/omigaZen/moye/releases/download/v0.5.0/Moye-0.5.0-source.zip) · [SHA256 校验清单](https://github.com/omigaZen/moye/releases/download/v0.5.0/Moye-0.5.0-SHA256SUMS.txt)

本版为未签名开发预览：Linux 已完成无头环境验证，Windows/macOS 为交叉构建，尚未实机验证。完整限制和测试记录见 [验收报告](docs/验收报告.md)。

## 使用

下载上方对应平台的便携包并解压，按以下方式启动；0.5.0 各包的构建与实测情况，以 `docs/验收报告.md` 为准：

- Windows x64：运行 `Moye.exe`。
- macOS Apple Silicon：使用 arm64 包；Intel Mac 使用 x64 包，运行 `Moye.app`。
- Linux x64：解压保留执行权限，运行 `start-moye.sh`。

发布包尚未进行开发者签名。Windows/macOS 的包在 Linux 上构造，须在对应系统继续实测。不要把“成功构建”理解成“全部平台验收完成”。

## 编辑

书写区实时渲染 Markdown，编辑格式内容时显示相关标记。顶部切换书写、阅读与源码，左侧大纲导航；底部可调整字号、主题。更多菜单提供插入图片、复制为 Markdown、专注模式、打字机模式和完整语法示例。专注模式弱化非当前块/行；打字机模式可选仅输入后居中，或鼠标选中后也居中。

阅读模式使用独立只读正文，保留书写区的选区与撤销历史。正文聚焦时，空格与 PageDown 向后翻页，Shift+空格与 PageUp 向前翻页，按完整视觉行定位并保留两行上下文；Esc 返回书写。可选自动隐藏的浮动工具栏、阅读位置记忆，支持标题、目录和脚注跳转后返回。TXT 可按字面文本阅读，选择空行或逐行分段，并识别中英文章节。图片查看器提供适应窗口、100%、缩放和拖动。

通过“打开文件夹”浏览 Markdown/TXT 文件树，按文件名或扩展名筛选，单击预览，双击或 Enter 保留标签，并切换同目录上一篇/下一篇。更多菜单或系统文件菜单可导出分页 PDF 与整篇 PNG，选择正文宽度、纸张、图片倍率和白纸/当前配色；导出范围与图片尺寸限制见使用说明。

基础语法包括标题、列表、任务、引用、表格、代码、链接和图片。扩展包括离线 MathJax 4.1.3 公式、Mermaid、脚注、文内目录、YAML、高亮和上下标。公式、图表、代码高亮、中文字体均随程序提供；设置中可切换 KaTeX。

新文档默认保存为 UTF-8；已有文本支持 UTF-8、UTF-16 LE/BE、GB18030、Big5、Shift_JIS 和 EUC-KR，状态栏可确认、重新解释或转换编码。保留 BOM 和已有换行风格；未编辑保存保留原始字节。图片默认复制到文档旁的资源目录，可设 `${filename}` 相对目录模板、引用原位置，以及路径形式与转义。拖放和剪贴板位图仍需落盘。未保存更改有关闭确认和崩溃草稿恢复。外部程序修改文件后，保存时提示选择处理方式。

通过更多菜单或 `Ctrl/Cmd + ,` 打开偏好设置，可搜索选项、切换和保存排版方案、对照排版样例、逐项复位，以及导入、导出和编辑墨页配置文件。排版包括中西文字体、间距、标点悬挂、首行缩进、对齐、表格宽度与三线表。阅读中的优化断行仅改变显示，复杂段落会回退浏览器排版。大部分显示更改保存后立即生效；Markdown 和数学设置先保存，再通过“重新载入”应用，保留原文、修改状态和编辑位置，**撤销记录会重新开始**。这些是当前墨页行为，仍需与原版逐项对照。

| 操作 | Windows / Linux | macOS |
| --- | --- | --- |
| 新建 / 打开 / 保存 | Ctrl+N / O / S | Cmd+N / O / S |
| 另存为 | Ctrl+Shift+S | Cmd+Shift+S |
| 切换源码 | Ctrl+/ | Cmd+/ |
| 阅读模式 | 可在快捷键设置中绑定 | 可在快捷键设置中绑定 |
| 查找替换 | Ctrl+F | Cmd+F |
| 粗体 / 斜体 / 链接 | Ctrl+B / I / K | Cmd+B / I / K |
| 撤销 / 重做 | Ctrl+Z / Ctrl+Shift+Z | Cmd+Z / Cmd+Shift+Z |
| 专注 / 打字机模式 | F8 / F9 | F8 / F9 |
| 偏好设置 | Ctrl+, | Cmd+, |

设置中的“快捷键”接受命令 ID 到组合键的 JSON，可立即重绑或禁用当前 36 个命令；它不是 Typora 配置直接导入。0.4 新增 `reading`、`workspace`、`previous-file`、`next-file`、`export-pdf`、`export-image`；六项默认未分配，避免占用旧版自定义快捷键。0.5新增 `recent`、`system-preview`、`close-window`，同样默认未绑定；Ctrl/Cmd+W在多个工作区标签时关闭当前标签，原生窗口关闭仍关闭窗口。原有命令表见 `docs/0.3.0设置进展.md`。

## 开发与构建

需要 Node.js 24、npm 和 Python 3.11 或更新版本（归档脚本使用）。在项目根目录：

```sh
npm ci
node node_modules/electron/install.js
npm run prepare-assets
npm start
npm test
npm run test:ui
npm run package -- all
npm run test:packaged:features
npm run verify:packages
```

`npm run test:ui` 测试真实 Electron 页面，无须另下浏览器。Linux 自动化使用 headless 和测试专用隔离用户目录。真实系统中文输入法、实体屏幕延迟、Windows/macOS 行为仍须在相应机器单独验证。性能测试会如实保留未达目标的指标，并可能返回非零退出状态。

`install.js` 显式确认宿主 Electron 45 运行时，避免依赖脚本未执行时只有 npm 包而无法启动。最终性能、Linux 系统预览显式注册、macOS Quick Look SDK/签名边界及发布哈希链，见构建详情；Windows Explorer 预览处理器尚未实现。

构建详情见 `docs/BUILDING.md`；用户操作见 `docs/使用说明.md`；语法能力见 `docs/语法范围.md`；设置清单见 `docs/0.5.0设置进展.md`；新增体验与范围见 `docs/Telari体验对照.md`；验收记录见 `docs/验收报告.md`。

## 依赖与授权

项目应用代码使用 MIT。编辑内核使用 Vditor 4.0.1，桌面运行时使用 Electron 45.0.0，默认公式引擎使用 MathJax 4.1.3，中文字体使用 Noto Sans SC。组件授权与本地补丁见 `THIRD-PARTY-NOTICES.md`。本项目的界面、图标与应用代码独立制作。

## 源码仓库

源码持续保存于 [omigaZen/moye](https://github.com/omigaZen/moye)。0.5.0初始快照、生成资源与历史提交说明见 [GitHub同步说明](docs/GitHub同步说明.md)。

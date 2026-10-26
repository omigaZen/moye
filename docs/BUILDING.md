# 构建与分发

开发环境需要 Node.js 24 和 Python 3.11 或更新版本。交付后的桌面包自带运行时，用户不需要这些开发工具。

```sh
npm ci
node node_modules/electron/install.js
npm run prepare-assets
npm start
npm test
```

本轮在 `npm ci` 后显式执行 Electron 自带的 `install.js`，确认当前宿主的 **Electron 45.0.0** 二进制已安装；依赖生命周期脚本未执行时，只有 npm 包文件并不足以启动或测试编辑器。该安装脚本可重复检查已有运行时，不需要另下载 Playwright 浏览器。

Electron 安装和首次打包会从官方发布下载相应平台的运行时，并使用下载缓存。源码运行使用当前宿主运行时，交叉打包还需要目标平台的官方 ZIP，两者不能互相代替。
Markdown 编辑、公式、Mermaid、语法高亮和字体全部从本地资源加载。

Linux 仍需系统提供 Electron 所需的共享库，无头模式不会免除这些依赖。PDF/PNG 专项还使用 Poppler 的 `pdfinfo`、`pdftotext`、`pdftoppm`，以及 Python 的 Pillow、PyMuPDF、pypdf。本轮环境分别为 Pillow 12.3.0、PyMuPDF 1.26.6、pypdf 6.10.0；这些是测试工具，不随桌面包安装。

## 打包目标

```sh
npm run package -- win32-x64
npm run package -- linux-x64
npm run package -- darwin-x64
npm run package -- darwin-arm64
npm run package -- all
```

输出在 `release/`，每个归档旁都有 SHA-256 校验文件。
0.5.0 的四个目标归档为 `Moye-0.5.0-Windows-x64.zip`、`Moye-0.5.0-Linux-x64.tar.gz`、`Moye-0.5.0-macOS-x64.zip`、`Moye-0.5.0-macOS-arm64.zip`。
Windows ZIP 解压后运行 `Moye.exe`，保留同目录全部文件。
Linux tar.gz 解压后运行 `start-moye.sh` 或 `Moye`。
macOS ZIP 包含 `Moye.app`，可放入应用程序目录。

在对应系统完成打包后，可通过 Playwright 对实际产物执行离线渲染检查：

```sh
node tests/packaged-smoke.cjs
```

也可以在命令末尾传入具体可执行文件路径。此检查验证 ASAR 内的欢迎文档、
8 类 Mermaid 图表、5 个数学公式、中文字体和本地图像，并阻止外网请求。
它不能替代真实输入法和系统桌面交互验收。

如需要使用已下载的 Electron ZIP，设置 `MOYE_ELECTRON_ZIP_DIR` 为其目录。
ZIP 文件名应保持官方格式，如 `electron-v45.0.0-win32-x64.zip`。
可通过 `PYTHON` 环境变量指定 Python 可执行文件。

本项目的可移植构建未接入 Windows 代码签名、macOS Developer ID 或 Apple 公证。

Linux 可用 `node tests/editor-memory.cjs` 对实际包单独采集长文稳定后的 `/proc` RSS/PSS快照，结果在 `artifacts/memory-report.json`。这项诊断不重复输入延迟采样，也不将部分环境中 Electron 返回的零工作集当作真实内存占用。
构造目标平台归档不等于在该系统完成运行验证；验收记录应分别注明实际测试的
操作系统、输入法、缩放比例和应用版本。

## 系统预览的单独构建与启用

Linux 包内提供一次性缩略图命令和 GNOME 兼容 `.thumbnailer` 注册能力。构建、首次启动和回归测试不会自动向真实桌面注册。用户明确启用时执行：

```sh
/absolute/path/Moye --register-system-preview
/absolute/path/Moye --unregister-system-preview
```

记录位于用户的 `$XDG_DATA_HOME/thumbnailers/moye.thumbnailer`，未设置时使用默认用户数据目录。开发验证可用 `node scripts/system-preview-linux.cjs install --executable /absolute/path/Moye --data-home /isolated/xdg`，配合同目录的 `uninstall`；测试使用隔离目录。CLI 通过不等于真实文件管理器已激活，桌面沙箱、缩略图设置和缓存仍需目标桌面验证。

macOS Quick Look 是 `native/system-preview/macos/` 下的原生扩展源码，需要 macOS 和 Xcode SDK 另行构建：

```sh
node scripts/system-preview-macos.cjs --arch arm64 --output /absolute/build/quicklook --embed-app /absolute/Moye.app
```

Intel 使用 `--arch x86_64`。普通 `npm run package -- darwin-*` 只构建 Electron 宿主，不会自动编译或嵌入扩展。Linux 交叉构建不能验证该扩展；Apple 团队、App Group、宿主与扩展签名、公证及 Finder 激活仍待真实 macOS 环境完成。嵌入或签名后必须重新归档、核对哈希和验证，不能沿用之前的归档校验结果。Windows Explorer 预览处理器尚未实现。协议、渲染边界及只读设置同步详见 [系统预览说明](../native/system-preview/README.md)。

## 持续集成

`.github/workflows/build.yml` 提供 Windows、Linux、macOS Intel 和 macOS Apple
Silicon 的原生构建矩阵。手动执行工作流或推送 `v*` 标签时运行。
工作流只构建并保存 artifact，不发布商店、不自动创建公开 Release。
工作流文件存在不代表本轮已在这些原生 runner 上执行，实际状态以验收报告为准。

打包脚本会将源码复制到临时目录后生成 ASAR，不会把 `node_modules`、开发测试、
自动化测试脚本、用户草稿或历史构建放入应用。

## 完整功能产物验证

`npm run test:packaged:features` 串行运行实际桌面包的全部功能套件，可在命令末尾用 `-- /绝对路径/Moye` 指定可执行文件。`npm run verify:packages` 随后检查四平台归档、架构、完整资源字节、版本及本轮实际包测试证据；成功构建不能替代这些检查。0.4.0 的编码转换依赖离线 vendored iconv-lite 与 safer-buffer，来源、许可证和 SHA256 位于 `electron/vendor/encoding-provenance.json`，无需运行时下载。

建议先完成源码回归，再从同一冻结运行树打四包并验证实际包：

```sh
npm test
npm run test:ui
npm run package -- all
npm run test:packaged:features
npm run verify:packages
```

0.5.0 的全量 UI 和实际包运行器已收录以下新增专项；单独运行使用 `node tests/文件名`。专项的 `MOYE_<前缀>_EXECUTABLE` 可指定实际可执行文件，`MOYE_<前缀>_OUTPUT` 可指定 JSON 报告路径：

| 专项脚本 | 内容 | 环境变量前缀 |
| --- | --- | --- |
| `editor-recent-files.cjs` | 最近文件、缺失记录、移除与重启 | `RECENT` |
| `editor-reading-longform.cjs` | 大 TXT 分段、远端章节、全文复制、下一篇提示和独立内存快照 | `LONGFORM` |
| `editor-typography-rich.cjs` | 复杂内联、标点实际几何、悬挂和复制保护 | `RICH_TYPOGRAPHY` |
| `editor-export-pagination.cjs` | 原生 PDF 分页、脚注链接、宽表、公式、图像及方向/边距界面 | `PAGINATION` |
| `editor-i18n.cjs` | 中英文切换、动态界面、文档隔离及持久化 | `I18N` |
| `editor-system-preview.cjs` | 独立缩略图 CLI、只读与隔离注册 | `SYSTEM_PREVIEW` |
| `editor-file-refresh.cjs` | 外部改写、删除/改名、锚点与重启窗口状态 | `REFRESH` |
| `editor-tab-close.cjs` | Ctrl/Cmd+W 当前标签与原生窗口关闭的区别 | `TAB_CLOSE` |

这些检查与既有源码和实际包用例有重叠，不能相加宣称为不同功能数量。系统预览专项在源码与正式 Linux 包路径下的注册检查范围也不同，不能互相替代。

最终延迟测量应在构建、压缩及功能回归结束后单独运行实际包，例如 Linux：

```sh
MOYE_PERF_EXECUTABLE=/absolute/path/Moye node tests/editor-performance.cjs
MOYE_MEMORY_EXECUTABLE=/absolute/path/Moye node tests/editor-memory.cjs
```

前者的原始结果为 `artifacts/performance-report.json`，后者为独立的 `artifacts/memory-report.json`。保留首次最终采样和未通过门槛，不以重复采样挑选较好值；内存快照与长 TXT 专项不替换输入端到端延迟结果。

## 发布源码与哈希链

发布时先冻结应用代码及离线资源，再保留两个提交身份：应用运行树冻结提交与包含最终文档/报告的完整源码提交。`tests/package-build-report.json` 保存冻结树 SHA256、逐文件哈希、源 `package.json` 哈希和四包构建记录；打包结束会检查运行树是否被并发更改。

`tests/package-report.json` 将每个平台实际 ASAR 内的 `src/`、`electron/`、`assets/` 和授权文件逐字节对比，检查归档 CRC、可执行架构、归档内外 ASAR/可执行文件哈希及实际包运行身份。实际包专项的报告必须对应当前版本并晚于该次构建，旧包或仅源码运行的报告不能代替。

发布元数据 `RELEASE-MANIFEST.json`、`SOURCE_VERSION.txt` 在完整源码提交后生成，记录两个提交身份、运行树及归档校验值，避免提交自引用；必须刷新为当前版本后再运行 `npm run archive:source`。完整源码 ZIP 包含代码、锁文件、离线资源、`native/` 源码、构建/测试脚本、文档及证据，不含开发依赖、用户目录或原版应用二进制。

最后生成外部 `Moye-0.5.0-SHA256SUMS.txt` 覆盖四个平台包、完整源码及交付文档。源码 ZIP 自身的哈希保存在外部清单，不能放进它内部的元数据形成循环。任何构建资源、嵌入扩展或签名变化都应重新归档、更新哈希并完成相关验证。

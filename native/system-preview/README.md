# 系统预览提供程序

这部分是操作系统提供程序，不是把应用内阅读面板改名为 Quick Look。Linux缩略图与macOS交互式Quick Look分开交付和验证。

## Linux：真实 `.thumbnailer` 协议

便携包提供一次性命令：

```sh
/absolute/path/Moye --system-preview --input 'file:///home/user/notes/note.md' --output /absolute/thumb.png --size 256
```

输入仅接受本地 Markdown/TXT 普通文件，最多8 MiB。最大边为64—1024像素，按纸张比例生成PNG；输出含`Thumb::URI`、`Thumb::MTime`、文件字节数和MIME元数据。写入采用同目录临时文件及原子替换，权限600，不改源文件。UTF-8/UTF-16及编辑器已有的推测编码解码策略共享；推测编码有可见标记，不写编码记忆。

缩略图只渲染开头65536个Unicode码点，超限明确显示片段标记。使用本地Lute生成受限Markdown HTML，本地KaTeX静态生成常用公式；行内/块级/数学围栏的独立开关及脚注等解析设置共用，支持基本本地公式宏。单式2048 UTF-16单元、最多64式、总TeX 16384单元、宏展开256次，失败或超限保留源码。图表围栏以源码显示。它不等同完整编辑器、MathJax物理扩展/带可选参数默认值的宏或Telari自研数学引擎。

页面禁用JavaScript、Node、外网、导航、窗口打开及权限。图片和字体仅允许本文件真实目录及应用资源目录内的文件，跨根符号链接被拒绝；单资源最多16 MiB。窗口15秒销毁保护。独立临时用户目录和会话由主入口创建；不进入编辑器恢复、历史、最近文件或保存流程。

字号、行高、字体、段落缩进/对齐、明暗与内置配色取自当前设置；自定义颜色及继承链通过只读TOML读取。已确认的单文件编码记忆可纯读取，BOM优先，不刷新使用时间或写配置。字体最终取决于本机已安装字体及随包回退。缩略图不执行阅读态整段DP、不使用未完成的字体/任意CSS等价假设。桌面缓存按源文件修改时间失效，字体/主题变化不保证立即刷新已有缩略图，须由桌面重新生成。

仅在用户主动启用时安装到`$XDG_DATA_HOME/thumbnailers/moye.thumbnailer`，默认用户数据目录。正式Linux包支持：

```sh
/absolute/path/Moye --register-system-preview
/absolute/path/Moye --unregister-system-preview
```

开发机也可用`node scripts/system-preview-linux.cjs print|install|uninstall --executable /absolute/path/Moye --data-home /isolated/xdg`生成或隔离验证。安装拒绝覆盖同名非墨页文件；卸载只删除自身记录，不删除源文档、其他提供程序或已有缩略图缓存。**仓库构建及测试不会自动向真实桌面注册。**

`.thumbnailer`面向GNOME兼容消费者；桌面进程可能有自己的缩略图开关、可执行路径沙箱或缓存规则，KDE/其他环境的原生插件不是这一协议的同义词。无头CLI及隔离注册验证不能代替真实文件管理器激活验证。

## macOS：真实 Quick Look Preview Extension 源码

`macos/MoyeQuickLook.xcodeproj`产出`MoyeQuickLook.appex`，入口为`NSViewController + QLPreviewingController`，声明`com.apple.quicklook.preview`及Markdown/TXT内容类型。使用AppKit只读可选择文本，Foundation有界Markdown解析；没有Web视图、JavaScript或网络权限。只读安全作用域、8 MiB输入及65536 Unicode码点显示上限，超限有片段标记。支持UTF-8/带BOM UTF-16；其他编码不静默猜测。公式、图表及更高级Markdown仍保留为有限原生表现，不声称完整编辑呈现一致。

macOS + Xcode SDK环境构建：

```sh
node scripts/system-preview-macos.cjs --arch arm64 --output /absolute/build/quicklook
node scripts/system-preview-macos.cjs --arch x86_64 --output /absolute/build/quicklook --embed-app /absolute/Moye.app
```

默认只编译不签名。可用`--team <10位Apple Team ID>`请求已配置开发者环境签名，仍需实际验证权限、宿主签名、Finder激活、公证和分发。脚本不会因缺少SDK而输出伪造的扩展二进制，也不自动运行`pluginkit`安装或修改系统扩展状态。

App Group为`group.com.moye.editor`。只有系统已配置其容器后，主程序`syncMacPreviewPreferences()`才写白名单排版快照；扩展只读该快照。快照没有文档、路径、宏或任意CSS。未配置容器则使用原生默认外观，不把未共享的设置宣称已同步。使用自己的Apple团队时须相应注册/配置App Group和宿主/扩展签名能力。

**Linux环境只能验证源码/PLIST/Scheme格式，不能编译或运行这个macOS扩展；未编译、未签名、未Finder实测即保持待验证。Windows Explorer预览处理器尚未实现。**

## 验证与官方依据

- `node --test tests/system-preview.test.cjs`：参数、文件预算、只读解码、静态渲染、主题、PNG元数据CRC、原子写、隔离XDG注册与App Group白名单。
- `node tests/editor-system-preview.cjs`：实际Electron CLI；`MOYE_SYSTEM_PREVIEW_EXECUTABLE`可指定实际包，`MOYE_SYSTEM_PREVIEW_OUTPUT`可改报告路径。实际包在隔离XDG下额外验证启用/移除命令。
- [GNOME Desktop Thumbnail Factory协议](https://gnome.pages.gitlab.gnome.org/gnome-desktop/html/gnome-desktop3/gnome-desktop3-GnomeDesktopThumbnailFactory.html)：`.thumbnailer`的Exec、URI、输出及尺寸参数。
- [freedesktop Thumbnail Managing Standard](https://specifications.freedesktop.org/thumbnail/latest-single/)：尺寸、PNG元数据、缓存身份和权限。
- [Apple Quick Look UI](https://developer.apple.com/documentation/quicklookui)与[QLPreviewingController](https://developer.apple.com/documentation/quicklookui/qlpreviewingcontroller)：真实预览扩展入口。
- [Apple扩展点标识](https://developer.apple.com/documentation/bundleresources/information-property-list/nsextension/nsextensionpointidentifier)：`com.apple.quicklook.preview`。
- [Apple Foundation Markdown读取](https://developer.apple.com/documentation/foundation/nsattributedstring/init(contentsof:options:baseurl:))：原生Markdown读取接口。

测试为墨页自身证据，不是Telari或Typora原版差分。

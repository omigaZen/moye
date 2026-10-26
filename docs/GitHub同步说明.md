# GitHub 源码同步说明

2026-10-26，墨页 0.5.0 源码快照导入私有仓库 https://github.com/omigaZen/moye ，默认分支为 main。后续以该仓库保存源码和改动历史。

同日按用户要求改为公开仓库，并发布 [0.5.0 开发预览及下载附件](https://github.com/omigaZen/moye/releases/tag/v0.5.0)。各平台直接下载链接及 SHA256 校验清单见 README。

## 初始快照来源

- 原始文件：Moye-0.5.0-source.zip，1091项。
- 归档SHA256：f4be88723b1505f75f17860e01e7c878ae5a4a9515715ea03c388f58e208c773。
- 原发布源码提交：e615233e13a49bd2fe3b1641d3a37bee1ff6b3f6。
- 原应用冻结提交：83e289616f6f04579a33ac20f45f188bef45fefc。
- 原运行树SHA256：cf4b65be61d300ff17582565fe3b965cf2441b79045e45482bb541c224f76e46。

原归档没有Git对象库，因此这里导入完整源码快照，不伪造旧提交历史。原发布提交和验收结果表示0.5.0交付时的记录；GitHub首次导入提交具有新的SHA。本次导入不修改编辑器运行代码，也不新增原版行为一致的承诺。

## 仓库范围与重建

遵循原.gitignore：提交自写src、electron（含不可省略的electron/vendor）、assets、根samples、native、scripts、锁文件、许可证、文档、测试与JSON验收证据。

src/vendor由npm run prepare-assets从锁定npm依赖复制并应用准备脚本中的补丁；src/samples从根samples复制。两者是生成资源，完整离线副本仍保存在原源码归档。node_modules、发布包、运行用户目录、日志、缓存和密钥不进入Git。原归档中提交之后生成的RELEASE-MANIFEST.json和SOURCE_VERSION.txt不作为当前Git提交元数据重新提交。

首次构建按README与docs/BUILDING.md执行：npm ci、node node_modules/electron/install.js、npm run prepare-assets。随后可npm start或运行相应构建命令。当前仍为开发预览，Windows/macOS原生验证及Typora/Telari全部行为对齐的缺口以验收文档为准。

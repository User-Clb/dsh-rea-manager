# dsh-rea

**REA（Reverse Engineer Anything）的 DeepSeek Harness 插件**：一条命令装好 REA 的 MCP 服务，支持从仓库更新到最新版、查看全部历史版本并回退到任意指定版本；所有网络访问都走多镜像链，国内直连 GitHub 不通时自动兜底。

## 它做什么

- **装 REA**：把 [morluto/rea](https://github.com/morluto/rea) 以 `rea-agents` npm 包（自带预编译 `dist/`）或 git 源码构建两种通道装进 `~/.dsh/dsh-rea/versions/<版本>/`，互不污染 profile 的依赖树。
- **更新**：`rea_update` 拉最新发布版，旧版本保留在磁盘上。
- **回退**：`rea_versions` 给出**全部**版本记录列表（git tag ∪ npm 版本，含日期与来源），`rea_rollback {"version":"6.5.0"}` 一键切回；GUI 设置页同样可选。
- **调工具**：REA 有 229 个分析工具（原生二进制、APK/Android、Electron/JS、Firmware、Frida、ADB、Ghidra/IDA/Hopper、证据比对……）。插件不把它们全塞进模型工具表（那会吃掉 300 KB~3.5 MB 的 schema 预算），而是暴露 3 个入口：`rea_tools` 检索、`rea_tool_schema` 取参数、`rea_call` 执行。
- **多镜像兜底**：git（GitHub 直连 + Gitee 镜像 + 40 个 GitHub 加速站）、npm（npmmirror / cnpmjs / 腾讯 / 官方 / USTC / yarnpkg）、Node 二进制（npmmirror CDN / nodejs.org）。任一环节失败自动换下一个，`rea_mirrors` 可实测延迟并落盘健康度。

## 安装

```bash
# 在 DSH profile 里
cd ~/.dsh/profiles/desktop
# package.json: "dsh-rea": "link:G:/laboratory/dsh-rea"（或 git+https://github.com/User-Clb/dsh-rea.git）
#              dsh.profile.bundles 追加 "dsh-rea"
# 然后重启 DSH
```

装好后模型可用这些工具，也可以直接用 CLI：

```bash
node scripts/dsh-rea-cli.mjs status
node scripts/dsh-rea-cli.mjs versions --refresh
node scripts/dsh-rea-cli.mjs install 6.8.0
node scripts/dsh-rea-cli.mjs update
node scripts/dsh-rea-cli.mjs rollback 6.5.0
node scripts/dsh-rea-cli.mjs mirrors
node scripts/dsh-rea-cli.mjs tools --query apk
node scripts/dsh-rea-cli.mjs call inspect_android_package '{"apk_path":"C:/x/app.apk"}'
```

## 工具

| 工具 | 作用 |
|---|---|
| `rea_status` | 当前版本、已装版本、Node 运行时、MCP 会话、镜像配置 |
| `rea_versions` | 全部版本列表（新旧排序，标注当前/已安装/已弃用/来源） |
| `rea_install` | 安装并启用某版本（`latest` / `6.8.0` / 唯一前缀） |
| `rea_update` | 更新到最新（保留旧版本，可回退） |
| `rea_rollback` | 回退到指定历史版本（缺省=回退一档） |
| `rea_tools` | 检索 REA 的 229 个工具 |
| `rea_tool_schema` | 取单个工具的完整入参 schema |
| `rea_call` | 执行任意 REA 工具 |
| `rea_mirrors` | 探测全部镜像，报告延迟与可达性 |
| `rea_config` | 读写配置（源偏好、固定版本、Node 路径、镜像、超时、schema 档位、保留版本数） |
| `rea_uninstall` | 停用并可选删除已装版本 |

## 配置

配置文件：`~/.dsh/dsh-rea/config.json`

```jsonc
{
  "source": "auto",              // auto | npm | git
  "pinnedVersion": "",           // 空 = 最新
  "nodePath": "",                // 空 = 自动探测；不满足 engines 时自动下载 24.22.1
  "mirrors": [],                 // 追加/禁用镜像：{ "id": "...", "disabled": true }
  "networkTimeoutMs": 120000,
  "probeTimeoutMs": 12000,
  "mcpStartupTimeoutMs": 60000,
  "mcpToolTimeoutMs": 180000,
  "mcpAutoReconnect": true,
  "inputSchemaProfile": "compact",
  "outputSchemaProfile": "off",
  "keepVersions": 6,
  "autoDownloadNode": true,
  "env": {}
}
```

`inputSchemaProfile: full` + `outputSchemaProfile: full` 会还原 REA 的完整字段说明，代价是工具表体积从约 300 KB 涨到 3.5 MB。

## 目录结构

```
~/.dsh/dsh-rea/
  config.json        配置
  active.json        当前启用的版本指针（回退=改这个文件）
  catalog.json       版本目录缓存（10 分钟）
  mirrors-health.json 最近一次镜像探测结果
  versions/<v>/      每个版本一份独立安装
  git/               部分克隆（--filter=blob:none），用于列 tag 与源码构建
  node/<v>/          自动下载的 Node 运行时
  logs/dsh-rea.log   安装/探测日志
```

## 说明

- 回退是**指针切换**，不重装：`rea_rollback` 只改 `active.json` 并重启 MCP 子进程，秒级完成。
- MCP 子进程按需启动、崩溃自动重连；工具表变化（REA 升级）会在下次调用时重新同步。
- 插件与 REA 版本解耦：升级 REA 不需要动插件，回退也不需要重装插件。
- 若某台机器所有镜像都不通，可在 `mirrors` 里塞自己的私有代理地址（`{url}` 占位符会被替换成上游地址）。

## License

MIT

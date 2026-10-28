# dsh-rea-manager

**REA（Reverse Engineer Anything）的 DeepSeek Harness 插件**：一条命令装好 REA 的 MCP 服务，支持从仓库更新到最新版、查看全部历史版本并回退到任意指定版本；所有网络访问都走多镜像链，国内直连 GitHub 不通时自动兜底。

## 它做什么

- **装 REA**：把 [morluto/rea](https://github.com/morluto/rea) 以 `rea-agents` npm 包（自带预编译 `dist/`）或 git 源码构建两种通道装进 `~/.dsh/dsh-rea-manager/versions/<版本>/`，互不污染 profile 的依赖树。
- **更新**：`rea_update` 拉最新发布版，旧版本保留在磁盘上。
- **回退**：`rea_versions` 给出**全部**版本记录列表（git tag ∪ npm 版本，含日期与来源），`rea_rollback {"version":"6.5.0"}` 一键切回；GUI 设置页同样可选。
- **调工具**：REA 有 229 个分析工具（原生二进制、APK/Android、Electron/JS、Firmware、Frida、ADB、Ghidra/IDA/Hopper、证据比对……）。插件不把它们全塞进模型工具表（那会吃掉 300 KB~3.5 MB 的 schema 预算），而是暴露 3 个入口：`rea_tools` 检索、`rea_tool_schema` 取参数、`rea_call` 执行。
- **工具目录管理**：`rea_tool_admin` 可列出/检索全部工具（含分组、参数数量、启用状态），按名字或分组批量启用/禁用，或查看单个工具的完整 schema。被禁用的工具不会出现在 `rea_tools` 里，`rea_call` 也会明确拒绝。设置页「MCP 工具」标签提供同样的界面。
- **服务进程控制**：`rea_mcp` 支持 `status` / `start` / `stop` / `restart`。停止是显式意图并持久化，不会在下次调用时自动复活。设置页顶部的「REA 服务」卡片可启动、重启、停止，并逐个调整参数（允许自动启动、崩溃自动重连、启动超时、调用超时），改完即时落盘。
- **多镜像兜底**：git（GitHub 直连 + Gitee 镜像 + 40 个 GitHub 加速站）、npm（npmmirror / cnpmjs / 腾讯 / 官方 / USTC / yarnpkg）、Node 二进制（npmmirror CDN / nodejs.org）。任一环节失败自动换下一个，`rea_mirrors` 可实测延迟并落盘健康度。
- **代理站点管理**：设置页「代理站点」标签可测试单个/全部站点、移除、添加自定义代理（支持 `{url}` 占位符）、按延迟重排、一键**重置为默认站点**；每次改动立即写入 `config.json` 持久化。模型侧对应 `rea_mirror_admin`。
- **版本删除**：已安装但未在使用的版本可以删除并释放磁盘空间；当前使用中的版本受保护，需要先切换到其他版本。

## 安装

```bash
# 在 DSH profile 里
cd ~/.dsh/profiles/desktop
# package.json: "dsh-rea-manager": "link:G:/laboratory/dsh-rea-manager"（或 git+https://github.com/User-Clb/dsh-rea-manager.git）
#              dsh.profile.bundles 追加 "dsh-rea-manager"
# 然后重启 DSH
```

装好后模型可用这些工具，也可以直接用 CLI：

```bash
node scripts/dsh-rea-manager-cli.mjs status
node scripts/dsh-rea-manager-cli.mjs versions --refresh
node scripts/dsh-rea-manager-cli.mjs install 6.8.0
node scripts/dsh-rea-manager-cli.mjs update
node scripts/dsh-rea-manager-cli.mjs rollback 6.5.0
node scripts/dsh-rea-manager-cli.mjs mirrors
node scripts/dsh-rea-manager-cli.mjs tools --query apk
node scripts/dsh-rea-manager-cli.mjs call inspect_android_package '{"apk_path":"C:/x/app.apk"}'
```

## 工具

| 工具 | 作用 |
|---|---|
| `rea_status` | 当前版本、已装版本、Node 运行时、MCP 会话、镜像配置 |
| `rea_versions` | 全部版本列表（新旧排序，标注当前/已安装/已弃用/来源） |
| `rea_install` | 安装并启用某版本（`latest` / `6.8.0` / 唯一前缀） |
| `rea_update` | 更新到最新（保留旧版本，可回退） |
| `rea_rollback` | 回退到指定历史版本（缺省=回退一档） |
| `rea_remove` | 删除已安装但未使用的版本，报告释放的空间；当前版本受保护 |
| `rea_tools` | 检索 REA 的 229 个工具（自动隐藏已禁用项） |
| `rea_tool_schema` | 取单个工具的完整入参 schema |
| `rea_call` | 执行任意 REA 工具（被禁用的工具会被拒绝） |
| `rea_tool_admin` | 工具目录管理：list / enable / disable / bulk / reset / schema |
| `rea_mcp` | 服务进程控制：status / start / stop / restart |
| `rea_mirrors` | 探测全部镜像，报告延迟与可达性 |
| `rea_mirror_admin` | 代理站点管理：list / test / testAll / add / remove / update / reset / reorder |
| `rea_config` | 读写配置（源偏好、固定版本、Node 路径、镜像、超时、schema 档位、保留版本数） |
| `rea_uninstall` | 停用并可选删除已装版本 |

## 配置

配置文件：`~/.dsh/dsh-rea-manager/config.json`

```jsonc
{
  "source": "auto",              // auto | npm | git
  "pinnedVersion": "",           // 空 = 最新
  "nodePath": "",                // 空 = 自动探测；不满足 engines 时自动下载 24.22.1
  "mirrors": [],                 // 追加/禁用镜像：{ "id": "...", "disabled": true }
  "networkTimeoutMs": 120000,
  "probeTimeoutMs": 12000,
  "mcpEnabled": true,            // false = 已显式停止，工具调用会被拒绝直到手动启动
  "mcpAutoStart": true,          // 首次调用时惰性拉起子进程
  "mcpStartupTimeoutMs": 60000,  // 启动预算：拉起 + MCP 握手
  "mcpToolTimeoutMs": 180000,    // 单次工具调用预算
  "mcpAutoReconnect": true,      // 子进程意外退出后自动重连
  "disabledTools": [],           // 被隐藏/拒绝的 REA 工具名
  "inputSchemaProfile": "compact",
  "outputSchemaProfile": "off",
  "keepVersions": 6,
  "autoDownloadNode": true,
  "env": {}
}
```

`inputSchemaProfile: full` + `outputSchemaProfile: full` 会还原 REA 的完整字段说明，代价是工具表体积从约 300 KB 涨到 3.5 MB。

## 设置页

DSH 设置里打开「REA 逆向分析」，从上到下是：

1. **REA 服务卡片**：状态徽章、启动/重启/停止，以及四个可单独调整的参数（允许自动启动、崩溃自动重连、启动超时、调用超时）。参数改动即时保存，控件会回读主机实际值。
2. **三个标签页**：
   - **版本管理**：摘要条显示当前版本 / Node / 最新 / 选中项。列表每行按状态给出互斥操作 —— 未安装显示「安装」（行内显示安装中 / 安装失败），已安装且非当前显示「启用」+「删除」，当前使用中的行不提供删除。
   - **MCP 工具**：按名字或描述搜索、按分组筛选、只看已禁用；单行可查看 schema 或启用/禁用，也可按当前筛选条件批量启用/禁用，或一键全部启用。
   - **代理站点**：测试单个或全部站点、添加自定义代理、移除、按延迟重排、重置为默认站点。

列表行都支持悬停高亮与点击选中，表头固定对齐。

## 目录结构

```
~/.dsh/dsh-rea-manager/
  config.json        配置
  active.json        当前启用的版本指针（回退=改这个文件）
  catalog.json       版本目录缓存（10 分钟）
  mirrors-health.json 最近一次镜像探测结果
  versions/<v>/      每个版本一份独立安装
  git/               部分克隆（--filter=blob:none），用于列 tag 与源码构建
  node/<v>/          自动下载的 Node 运行时
  logs/              插件日志（dsh-rea-manager.log 为插件自身，dsh-rea.log 为服务子进程）
```

## 说明

- 回退是**指针切换**，不重装：`rea_rollback` 只改 `active.json` 并重启 MCP 子进程，秒级完成。
- MCP 子进程按需启动、崩溃自动重连；工具表变化（REA 升级）会在下次调用时重新同步。
- 插件与 REA 版本解耦：升级 REA 不需要动插件，回退也不需要重装插件。
- 若某台机器所有镜像都不通，可在 `mirrors` 里塞自己的私有代理地址（`{url}` 占位符会被替换成上游地址）。

## License

MIT

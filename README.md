# dsh-rtk-adapter

把 [rtk](https://github.com/rtk-ai/rtk) 的命令改写建议接入 DSH，**不替代 DSH 的 `bash` 工具**。

插件注册建议工具 `rtk_rewrite`：给它一条 shell 命令，它只运行 `rtk hook check -- <command>` 并返回 rtk 建议的命令，例如 `git status` → `rtk git status`、`cat x` → `rtk read x`。它**不执行**原命令或改写后的命令；下一步由 Agent 通过内置 `bash` 执行。因此命令执行继续使用 DSH 自己的工具限制、审批、沙箱、输出捕获及后台任务机制。若无需改写、rtk 未安装、探测失败或输出不完整，就返回原命令和 `rewritten: false`。

## 环境与兼容性

- Node.js ≥ 22。
- DSH：本版本按 `0.2.1-alpha.2` 开发，并在 `0.2.1-rc.2` 实测；`package.json` 的 `engines.dsh` 为 `^0.2.1-alpha.2`。
- rtk：实测 `0.51.0`。更老的 rtk 如果没有 `hook check` 子命令，会因非零退出而静默回退到原命令。
- `rtk` 需要在 DSH Host 的 PATH 中，或用 `RTK_BIN` 指定**绝对路径**。探测进程使用 Host 的环境，不是某条 `bash` 命令内部的 mise/PATH 环境。

## 安装与卸载

安装时会通过 [cordis.patch.yml](cordis.patch.yml) 插入 Host 插件。命令行方式：

```sh
# 在 DSH 外执行；本地目录默认以 link: 依赖安装
dsh plugin --profile web add /home/ixu/project/dsh/dsh-rtk-adapter

# 验证 bundle 已进入 profile（该命令会写 profile 的 cordis.yml，需在沙箱外执行）
dsh --profile web --dump-config | grep -i rtk
```

也可以在插件管理器 GUI 中使用 `installBundle`，目标填本目录的绝对路径；`plugin_manager install_bundle` 是管理器 API 的名称，不是可直接执行的 shell 命令。

安装或修改插件代码后，需要**重启 DSH Host**（例如重新启动 `dsh web`，本机也可用对应的启动脚本）才能加载新模块。卸载：

```sh
dsh plugin --profile web remove @local/dsh-rtk
```

## 使用

1. 噪声较大的命令先调用 `rtk_rewrite({ command: 'git status' })`。
2. 审视返回值；需要压缩输出时，把返回的 `command` 交给 `bash` 执行。
3. 需要逐字精确输出（JSON、`--porcelain`）时跳过建议，直接用原命令调用 `bash`；即使有 `--porcelain`，rtk 自己仍可能建议过滤。
4. 需要固定探测目录时传 `workdir`；相对路径按会话工作目录解析，路径首尾空白会被去掉。
5. `RTK_DISABLED=1` 会让 `rtk_rewrite` 直接返回原命令，不再启动探测。`RTK_BIN` 可在启动 DSH 前指定非 PATH 的 rtk 可执行文件（必须是绝对路径）。

探测命令固定为 `rtk hook check -- <command>`。`--` 用于阻止 `-h`、`--help` 之类的前导参数被 rtk 当成自己的选项；这类输入会正常返回 `rewritten: false`。探测输出超过 64 KiB 时不会把残缺尾部作为命令返回，探测超时为 5 秒。

注意 rtk 自身可能读取项目里的配置；不要将探测结果视为经过信任审核的命令。

## 安全边界与已知限制

- 探测进程由 Host 的 `ctx.subprocess` 启动，**不经过 `bash` 的沙箱和审批**。它只执行 `rtk hook check`，不会执行模型给出的命令；但它是 Host 上的外部进程。限制 `bash` 的 Agent 仍可能调用 `rtk_rewrite`（`edge-test` 会验证这一点）。如果部署策略要求所有子进程都受限，请同时限制 `rtk_rewrite`，或明确接受这个例外。
- `rtk_rewrite` **不是** shell 执行工具。依赖原来的 `rtk` 工具名的调用在重启后要改成 `rtk_rewrite` → `bash` 两步；限制 `bash` 的 Agent 不应将建议结果再交给其他可执行工具。
- 在 workspace-write 沙箱下，通过 `bash` 执行 rtk 时，rtk 自己的统计/recall 数据库可能不可写；过滤功能通常仍可用。不要仅为统计功能默默放宽沙箱。
- 不透明改写 `bash` 的入参：DSH 的 `tools/pre-execute` 不能修改冻结的实参，`tools/execute` 的契约只允许改 `exec.signal`。独立的建议工具让命令执行继续走原生边界。
- `RTK_DISABLED` 只识别精确值 `'1'`；`RTK_BIN` 为空值时按未设置处理，回退到 `rtk`。

## 自检（在源码目录运行）

```sh
npm test                  # hermetic selftest + 真实 Cordis/ToolRuntime edge test；需要 dsh，不需要 rtk
npm run test:integration  # 真实 rtk；未安装时打印 SKIP
npm run test:provider     # 真实 dsh-subprocess-local + 临时 shim；Linux，约 6 秒
npm run test:all          # 全部
```

- `selftest.mjs` 使用桩 subprocess，覆盖改写、无匹配回退、长输出截断回退、rtk 缺失、spawn/done 失败、`RTK_DISABLED`、`workdir`、`ensure` 失败回退、取消和参数校验；同时断言探测 argv、stdio、超时/宽限参数，以及插件不持有 shell 服务。
- `edge-test.mjs` 使用独立的真实 Cordis/DSH 工具注册表（不修改当前 Host），测试五秒超时、探测期间取消、可执行文件查找期间取消、`rtk_rewrite`/`bash` 分别被限制时的可见性与 systemPrompt 段落隐藏。
- `integration-test.mjs` 使用真实 rtk，覆盖改写、无匹配、`workdir`、`-h` 回归和 `RTK_DISABLED`。
- `provider-test.mjs` 使用真实 `dsh-subprocess-local`，以临时 `RTK_BIN` shim 验证正常改写、stderr 忽略、64 KiB 截断回退、缺失可执行文件、5 秒超时和取消后的进程终止。该测试不代表当前 Host 的沙箱配置实测。

## 发布说明

- 许可证：MIT（见 [LICENSE](LICENSE)）。
- 当前包为 `private: true`、名称 `@local/dsh-rtk`，定位是本地/内部 bundle。若发布到 npm 或市场，需要改用可发布的包名并移除 `private`，同时确认文件权限（本仓库源码当前应保持 `644`）。
- 当前目录尚未初始化为 git 仓库；正式阶段发布前建议至少打一个 tag，并让 CI 运行 `npm test` 与 `npm run test:integration`。

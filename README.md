# dsh-rtk-adapter

把 [rtk](https://github.com/rtk-ai/rtk) 的命令改写建议接入 DSH，**不替代 DSH 的 `bash` 工具**。

插件注册建议工具 `rtk_rewrite`：给它一条 shell 命令，它只运行 `rtk rewrite -- <command>` 并返回 rtk 建议的命令，例如 `git status` → `rtk git status`、`cat x` → `rtk read x`。它**不执行**原命令或改写后的命令；下一步由 Agent 通过内置 `bash` 执行，因此命令执行继续使用 DSH 自己的工具限制、审批、沙箱、输出捕获及后台任务机制。无需改写、rtk 未安装、探测失败或输出不完整时返回原命令和 `rewritten: false`；rtk 返回拒绝（退出码 2）时返回原命令并附带固定文案的 `denial` 字段。

可选的强制模式（`enforce: true`）会把同一个 rtk 拒绝信号映射为 DSH 的 `tools/pre-execute` 拒绝：只有 rtk 明确拒绝的 `bash` 调用会被拦下，其余一律放行。默认关闭。

## 环境与兼容性

- Node.js ≥ 22；DSH `^0.2.1-alpha.2`（见 `package.json` 的 `engines.dsh`）。
- **只支持 rtk 1.x，不向下也不向上兼容。** 首次探测执行一次 `rtk --version`，解析出主版本为 1 才继续，0.x 与 ≥2.x 都按“不支持”处理，`rtk_rewrite` 一律返回原命令，强制模式也不会拒绝任何调用。0.x 没有 `rewrite` 子命令，且会把“未知子命令”报成退出码 2，不能与 rtk 的拒绝区分，必须挡在版本闸门之外。只有确定的版本结论会被缓存：探测超时、spawn 失败或输出无法解析都视为“不确定”，下次调用会重新探测。
- `rtk` 需要在 DSH Host 的 PATH 中，或用 `RTK_BIN` 指定**绝对路径**。探测进程使用 Host 的环境，不是某条 `bash` 命令内部的 mise/PATH 环境。

## 安装与卸载

安装时会通过 [cordis.patch.yml](cordis.patch.yml) 插入 Host 插件：

```sh
dsh plugin --profile web add @ixuzone/dsh-rtk-adapter        # 从 npm 安装
dsh plugin --profile web add /path/to/dsh-rtk-adapter        # 本地源码目录（以 link: 依赖安装）
dsh plugin --profile web remove @ixuzone/dsh-rtk-adapter     # 卸载
```

也可以在插件管理器的 `installBundle` 中安装，目标填包名 `@ixuzone/dsh-rtk-adapter` 或源码目录的绝对路径。安装或修改插件代码后，需要**重启 DSH Host** 才能加载新模块。

## 使用

1. 噪声较大的命令先调用 `rtk_rewrite({ command: 'git status' })`。
2. 审视返回值；需要压缩输出时，把返回的 `command` 交给 `bash` 执行。
3. 需要逐字精确输出（JSON、`--porcelain`）时跳过建议，直接用原命令调用 `bash`；即使有 `--porcelain`，rtk 自己仍可能建议过滤。
4. 需要固定探测目录时传 `workdir`；相对路径按会话工作目录解析，路径首尾空白会被去掉。
5. `RTK_DISABLED=1` 会让 `rtk_rewrite` 直接返回原命令，不再启动探测。`RTK_BIN` 可在启动 DSH 前指定非 PATH 的 rtk 可执行文件（必须是绝对路径）。

探测命令固定为 `rtk rewrite -- <command>`。`--` 用于阻止 `-h`、`--help`、`--version` 之类的前导参数被 rtk 当成自己的选项；不带分隔符时 rtk 会打印帮助并以 0 退出，因此分隔符是必需的。探测输出超过 64 KiB 或读取不完整时不会把残缺尾部作为命令返回，探测超时为 5 秒。

### rtk 退出码映射

| 退出码 | 含义（rtk 1.x 文档） | 插件行为 |
|---|---|---|
| `0` | 有改写，allow 规则覆盖全部命令 | 返回改写结果 |
| `3` | 有改写，需把审批交给宿主（无规则时恒为此值） | 返回改写结果 |
| `1` | 无改写 | 返回原命令 |
| `2` | rtk 拒绝该命令 | 返回原命令 + 固定 `denial` 文案 `rtk denied this command` |
| 其他 / 被杀 | 探测失败 | 返回原命令 |

`0` 与 `3` 都会读取 stdout，再经“非空、未截断、与原命令不等价”三项校验后才会作为建议返回；rtk 可能把已经是 rtk 形式的命令原样回显，此时按无改写处理。**stderr 不参与判定**：rtk 也会向 stderr 写普通诊断信息，拒绝原因统一使用固定文案，不转述 stderr。

### 强制模式

在 profile 的 patch 里给插件加配置，或设置环境变量：

```yaml
- id: rtk-adapter
  name: '@ixuzone/dsh-rtk-adapter'
  config:
    enforce: true
```

```sh
RTK_ENFORCE=1 dsh web   # 等价的环境变量开关
```

强制模式只把 rtk 的“退出码 2”映射为 `tools/pre-execute` 的 `deny`（reason 为固定文案 `rtk denied this command`）；它不改写任何命令，不替代 DSH 的审批，rtk 不可用、版本不受支持、超时或返回其他结果时一律放行。代价是**每次 `bash` 调用都会多一次 rtk 探测**（通常约 10ms，超时上限 5 秒）；不需要强制执行时保持默认关闭。强制模式按 `bash` 调用原样传递 `workdir`（不做 trim），与 DSH 的目录解析保持一致。

**强制模式不是完整的权限边界**，它只覆盖 rtk 能直接判定的 `bash` 命令字符串：

- rtk 对 shell wrapper 内的拒绝按设计返回退出码 1（例如 `rtk rewrite -- 'bash -c "rm -rf /tmp/x"'` 返回 1，而 `rtk rewrite -- 'rm -rf /tmp/x'` 返回 2），因此 `bash -c` 这类包装命令不会被拦下；
- `rtk rewrite` 只评估 rtk 的权限规则，不加载 `rtk pipeline` 中的规则，pipeline 级别的 deny 不在覆盖范围内；
- 其他执行通道（`pwsh`、后台作业内部的再调用等）也不在覆盖范围内。

需要完整覆盖时，请使用 `rtk hook <agent>` 接入或依赖 DSH 原生的审批与沙箱；不要把强制模式当作 sandbox 或完整的 deny 层。

## 安全边界与已知限制

- 探测进程由 Host 的 `ctx.subprocess` 启动，**不经过 `bash` 的沙箱和审批**。它只执行 `rtk --version` 与 `rtk rewrite`，不会执行模型给出的命令；但它是 Host 上的外部进程。如果部署策略要求所有子进程都受限，请同时限制 `rtk_rewrite`，或明确接受这个例外。
- `rtk_rewrite` **不是** shell 执行工具。依赖原来的 `rtk` 工具名的调用要改成 `rtk_rewrite` → `bash` 两步；限制 `bash` 的 Agent 不应将建议结果再交给其他可执行工具。
- `rtk_rewrite` 返回 `denial` 时**不会阻止**后续 `bash` 调用：建议工具没有执行权，是否运行仍由 DSH 的审批与沙箱决定。需要强制执行时使用上面的强制模式。
- rtk 的改写与拒绝判定受 rtk 自身的权限规则与项目配置（如 `.claude/settings*.json`）影响，这些配置不在本插件的审计范围内；不要把探测结果视为经过信任审核的命令。
- 在 workspace-write 沙箱下，通过 `bash` 执行 rtk 时，rtk 自己的统计/recall 数据库可能不可写；过滤功能通常仍可用。不要仅为统计功能默默放宽沙箱。
- 不透明改写 `bash` 的入参：DSH 的 `tools/pre-execute` 不能修改冻结的实参，`tools/execute` 的契约只允许改 `exec.signal`。独立的建议工具让命令执行继续走原生边界。
- `RTK_DISABLED` 只识别精确值 `'1'`；`RTK_BIN` 为空值时按未设置处理，回退到 `rtk`。

## 开发与测试

```sh
npm test                  # 自检 + Cordis 工具注册边界测试（需要 dsh，不需要 rtk）
npm run test:integration  # 真实 rtk 1.x；未安装或主版本不是 1 时打印 SKIP
npm run test:provider     # 真实 dsh-subprocess-local + 临时 shim
npm run test:all          # 全部
```

npm 包名 `@ixuzone/dsh-rtk-adapter`，MIT 许可证（见 [LICENSE](LICENSE)）；发布用 `npm publish`，发布前先跑 `npm test` 与 `npm pack --dry-run`。

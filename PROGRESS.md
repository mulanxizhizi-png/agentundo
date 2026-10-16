# agentundo 进度

## v0.1.0（2026-10-16，开发和调试）

### 已完成
- `init`：给 Codex（`~/.codex/hooks.json`）和 Claude Code（`.claude/settings.local.json`）装两个钩子：`PreToolUse` 在每次执行命令或改文件前拍快照，`UserPromptSubmit` 在每轮开始时兜底拍一次。钩子固定调用 `~/.agentundo/bin/agentundo-hook`，以后升级不用重新信任。装完先拍一张基线快照。
- 轮次：Codex 按 `turn_id` 区分，Claude 按 `prompt_id` 区分。`list` 里显示成 `t2.1`，意思是第 2 轮第 1 条命令之前。
- `list`：每张快照显示轮次、时间、agent、变化的文件数，以及它是在哪条命令之前拍的（如 `before rm -rf src`）。`rm -rf`、`git reset --hard`、`drop table`、`git clean -f`、apply_patch 删文件等危险操作会标 ⚠。
- `diff <id> [--patch] [-- 路径]`、`restore <id> [--dry-run] [--yes] [-- 路径]`、`status`、`snap`、`prune --keep N`、`uninstall [--global] [--purge] [--yes]`。
- 快照存在项目外的影子 git 仓库 `~/.agentundo/stores/<hash>/`，用独立的 GIT_DIR、工作区和 index，不碰用户自己的 `.git`、暂存区、分支和 stash。不是 git 仓库的项目也能用。
- 默认排除 `.gitignore` 忽略的文件，以及 `node_modules`、`.venv`、`dist`、`build` 等目录和 `.env*`。SQLite 文件（含 `-wal`、`-shm`）即使被忽略也会存。单个文件上限 50MB，超过的跳过，每次都警告。总量上限 2GB，超了自动删最旧的快照（至少保留最近 20 张），每次都提示，不会悄悄停拍。
- `restore` 先给当前状态拍一张，所以恢复本身也能撤销。文件先写到临时目录，再逐个改名放到原位置。中途按 Ctrl+C 会留下记录，重跑同一条 restore 就能补全，也能退回恢复前的状态。没有终端又没加 `--yes` 时拒绝执行。
- 钩子出错一律放行（退出码 0），错误写进日志，并通过 systemMessage 告诉用户这一步没拍上。

### 测试
- `npm test`：18 个 node:test 用例，覆盖方案清单的第 3 到 8 项、第 11 到 16 项，另外测了按路径部分恢复、命令标签和危险命令识别。
- 性能（第 9、10 项，5000 个源码文件加 6000 个 node_modules 文件）：首次快照 0.46 秒；每次钩子约 120 到 135 毫秒，其中 Node 启动约 65 毫秒；影子仓库 20MB；恢复 5000 个文件 0.58 秒。node_modules 默认排除。
- 真实端到端：
  - Codex CLI 0.163（`codex exec --dangerously-bypass-hook-trust`）：agent 执行 `rm -r src scratch.txt` 前拍到了快照（列表显示 `before rm -r src scratch.txt ⚠`），`restore` 后 src 和没被 git 跟踪的 scratch.txt 都回来了，git 跟踪的文件状态干净。另外：Codex 自己的规则会拒绝 `rm -rf`，所以改用 `rm -r` 测。
  - Claude Code 2.1.x（DeepSeek 接口）：agent 先用 Write 建文件，再执行 `rm -rf src`。列表显示 `before Write`、`before rm -rf src ⚠`，`restore` 后 src（含未跟踪文件）全部回来，`git status` 里没有已跟踪文件的改动，`diff` 显示无差异。

### 已知缺口 / 待部署复测
- 终端里手动输入 y/n 确认那一步没有自动化测试，请部署实际跑一遍。
- Codex 交互模式下要在 `/hooks` 里信任一次，未在交互 TUI 里实测。
- 只在 Linux 上测过，macOS 待测，Windows 不保证。
- 恢复是逐个文件原子替换，不是整棵目录树一次性替换。
- 远程数据库、项目外的文件和 `.env` 救不了（README 已写明），对这类命令只做提醒。
- 和 agentreceipt 的打通（红色收据附 restore 命令）留到下一版。

# agentundo 进度

## v0.1.8（2026-10-23）：新增只读子命令 `agentundo changes`（包 5）
- `agentundo changes [tN | <id>] [--batches] [--md] [--json]`：列出某一轮（或某快照到现在）新增/修改/删除的文件、每文件增删行数与总计；按依赖与锁文件/配置/源码/测试/文档分组，高亮新增文件、新增顶层目录、入口文件、依赖与配置、删除。只用路径规则，不调 LLM、不联网。
- `--md` 输出可粘贴的 Markdown 清单；`--batches` 只打印建议分批（配置/依赖 → 源码 → 测试 → 文档，各批并集 = 全部变化文件）。
- 只读：不拍快照、不动 hook、不写用户 `.git`、不改默认拦截语义。`Store` 只新增了一个只读 `numstat()`（`git diff-tree --numstat`，与现有 `changes()` 同一套 shadow repo 封装，不需要改快照格式）。
- 0.1.8: 新增只读 `agentundo changes` 子命令。

## 未发布（2026-10-17）：修 Codex 验收发现的 AU-001、AU-002
- AU-001（会误删文件）：只新增一个超大文件时，`snap` 判断「没变化」直接复用旧记录，没记下这个文件被跳过；之后文件变小再恢复，就会被当成多出来的文件删掉。现在「被跳过的文件」变了也算新快照；恢复时，目标快照或它之后任何一张快照里被跳过过的文件都不删。
- 顺带修复同类问题：文件先被正常存过、后来变大超限时，`git rm --cached` 会报错（没加 `-f`）且被吞掉，快照里留着旧的小版本；恢复那张快照会用旧内容盖掉没存过的大文件。现在加了 `-f`，恢复时也不会写回目标快照标记为跳过的文件。
- AU-002：钩子读取命令时兼容 `tool_input.cmd`（exec_command）、`command` 为字符串或数组、apply_patch 的 `tool_input.input`、以及 `tool_input` 直接是字符串（含 JSON 字符串）。在 box 上用真实 Codex 0.163.0 抓了两条 PreToolUse 数据（shell 和 apply_patch），脱敏后放在 `test/fixtures/`。真实格式是 `tool_name: "Bash"` / `"apply_patch"`，参数都在 `tool_input.command` 里。
- `restore --dry-run` 和「没事可做」时也会列出保留下来的文件。
- 只读目录下错误日志写不进去（AU-003）这次没修。

## v0.1.3（2026-10-16 晚）：项目目录被删时提示改温和
- 已登记的项目目录被删后，钩子不再报「snapshot FAILED」，改为提示「agentundo: project directory no longer exists, skipped snapshot」。退出码仍是 0，不会拦截 agent。
- 查了其他会输出 FAILED 的地方：只剩快照真正出错（比如快照仓库损坏）时的提示，这种情况确实没法撤销，保留原样。卸载时的提示本来就是「no longer exists」，没改。
- 新增 1 个测试（PreToolUse 和 UserPromptSubmit 都覆盖，真实跑 hook 进程），共 41 个，连跑 10 次全部通过。

## v0.1.2（2026-10-16 晚）：危险命令提醒
- 重写危险命令识别（`src/danger.js`）：按 shell 语法拆分命令，只看真正执行的程序（跳过 sudo/env/xargs/timeout 等，`bash -c` 递归分析）。覆盖 `rm -r/-rf/-fr/-r -f/--recursive --force`、`git reset --hard`、`git clean -fd/-fdx/-xdf`、`git checkout -- .`、`git restore .`、`find -delete` 等；SQL 的 `DROP TABLE/DATABASE`、`TRUNCATE`、`DELETE FROM` 只在运行数据库客户端时才算（含 `psql -c`、`mysql -e`、`sqlite3 db "..."`、管道给 psql）。`echo rm -rf`、grep、提交信息里的文字不算。
- 危险命令一定单独拍一张快照（即使文件没变化），`list` 里标「⚠ dangerous (原因)」，新增 `list --dangerous` 只看这些；钩子同时提示「已先存快照 #N，撤销用 agentundo restore N」。
- 远程数据库提醒：连接串或 `-h`/`PGHOST`/`DATABASE_URL` 指向非本机地址、且有写入/破坏性 SQL/迁移工具时，提示「⚠ agentundo: this step touches a remote database (<host>) — local snapshots cannot undo it.」。只提醒不拦截，出错一律放行。本机、unix socket、只读查询不提醒。
- 脱敏：连接串密码、`*_PASSWORD=`、`--password=`、`mysql -p密码`、`redis-cli -a` 在存储、列表、日志、提示里都换成 `***`。
- 修复部署发现的问题：Codex 第一轮的 `rm a.txt` 没有单独的「before rm a.txt」快照。原因是轮次开始时刚拍过一张，文件没变化，第一条命令就被合并掉了。现在每轮第一条命令、以及所有删/移文件的命令都单独记一条。已加复现测试。
- 测试：新增 12 个（大量正反例、本机/远程、脱敏、单独快照、Codex 首条命令复现），共 39 个，连跑 10 次全部通过。
- 真实端到端（用独立的 AGENTUNDO_HOME/CODEX_HOME，没碰 box 上的全局安装，测完已删除）：
  - Claude Code 2.1.301（DeepSeek）：`rm -rf src` 前单独拍了快照并标 ⚠，restore 后 src（含未跟踪文件）回来；远程 psql 命令出现远程数据库提醒，列表和存储里密码都是 `***`。
  - Codex 0.163：`rm b.txt`（每轮第一条）、`rm -rf src`、远程 psql 都有单独快照和标记；TUI 里显示「↳ Hook · ⚠ agentundo: this step touches a remote database (db.example.com) …」。
- 已知缺口：`codex exec` 非交互模式不显示钩子消息（TUI 显示）；agent 自己的界面仍会显示它执行的原始命令（含密码），这不归 agentundo 管；macOS 仍未测。

## v0.1.1（2026-10-16 晚）：和 agentreceipt 打通
- 新增给程序调用的稳定接口：`agentundo receipt --status green|red|blocked --json` 会拍下验证时的状态（文件没变化就不新建），在这张快照上记下收据结果，并返回最后一张测试通过的快照编号和恢复命令。另外新增 `snap --json [--label]` 和 `list --json`。项目没初始化时返回 `ok:false`，退出码始终是 0。
- `list` 会在对应的快照后面标“✓ tests passed”或“✗ tests failed”，并在底部提示最后一张测试通过的快照。
- 容量超限清理旧快照时，最新那张测试通过的快照不会被删。agentreceipt 自己的 `.agentreceipt/receipts`、`state`、`logs` 目录不进快照，恢复时不会删掉更新的收据。
- 新增 4 个测试，共 22 个，连跑 3 次都通过。跨工具端到端测试放在 agentreceipt 那边。

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

### 部署复测问题修复（仍为 v0.1.0）
1. **数据丢失**：快照时被 `.gitignore` 忽略的文件，后来改了 `.gitignore` 再恢复，会被误删。现在恢复时只删除目标快照按当时规则本来会存下的文件。被忽略、被默认排除（`node_modules`、`.env`）或超过大小上限的文件一律不删，并在确认列表里列出“kept”。已用部署给的复现步骤加了回归测试。
2. 解包失败时，报错里会写明 git 的错误信息，或者退出码和信号，并告诉用户可以重跑哪条命令、恢复前的状态是哪张快照。
3. 在确认提示里回答 n，退出码改为 1，和 agentreceipt 一致。
4. `--` 后面的 `--yes`、`-y`、`--dry-run` 当作选项处理，不再当成路径，并给出提示。
5. 影子仓库被删后，下一次钩子会自动重建并拍新的基线，同时明确提示旧快照已经丢失，并记进 `status` 的最近失败。

### 已知缺口 / 待部署复测
- 终端里手动输入 y/n 确认那一步没有自动化测试，请部署实际跑一遍。
- Codex 交互模式下要在 `/hooks` 里信任一次，未在交互 TUI 里实测。
- 只在 Linux 上测过，macOS 待测，Windows 不保证。
- 恢复是逐个文件原子替换，不是整棵目录树一次性替换。
- 远程数据库、项目外的文件和 `.env` 救不了（README 已写明），对这类命令只做提醒。
- 和 agentreceipt 的打通（红色收据附 restore 命令）留到下一版。

### 部署复测 a46a3bc 的两个问题（未发版）
1. **必须修**：`~/.agentundo/stores` 不可写、`projects.json` 可写时，旧快照目录搬不动，登记表却被改成新路径，导致 `list` 显示没有快照。现在只有搬成功（或新目录已存在）才改登记表；搬不动就保留旧条目、继续用旧目录，并提示一行（每个进程一次）。权限恢复后下一次命令会自动搬并改登记表。
2. **建议修**：`uninstall --purge` 现在会一并删掉同一项目的旧版/被标记 superseded 的快照目录；加 `--global` 时还会删 stores 里所有其他快照目录（孤儿）。只处理 `~/.agentundo/stores` 下 16 位十六进制命名的条目，符号链接只删链接本身。删不掉的会逐条列出并以非 0 退出。
- 新增 3 个测试；两个 chmod 测试在 root 下跳过（root 不受目录权限限制，模拟不了）。

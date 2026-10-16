# agentundo

**An undo button for coding agents.** agentundo snapshots your project right before every command Codex or Claude Code runs (`rm`, `mv`, scripts, file edits) and at the start of every turn. When the agent deletes or breaks something, one command takes you back:

```
$ agentundo list
ID    TURN    WHEN     AGENT   FILES  SNAPSHOT TAKEN
1     t0      10s ago  -       -      baseline (agentundo init)
2     t1.1    6s ago   claude  0      before Write notes.md
3     t1.2    4s ago   claude  1      before rm -rf src ⚠ dangerous
4     t1.3    2s ago   claude  3      before ls

$ agentundo restore 3
Restore snapshot #3 (t1.2, before rm -rf src)
  3 file(s) to write back, 0 file(s) to remove
Proceed? Your current state is snapshotted first, so this can be undone. [y/N] y
Restored #3: wrote 3, removed 0.
Undo this restore: agentundo restore 5
```

Claude Code's `/rewind` [does not track files changed by Bash commands](https://code.claude.com/docs/en/checkpointing). agentundo does, including files git doesn't track, for both Codex and Claude Code.

## Install

Requires Node 20+ and git. In your project folder:

```
npx github:mulanxizhizi-png/agentundo#v0.1.1 init
```

This installs hooks for both agents (`--agent codex` or `--agent claude` for one) and takes a baseline snapshot. After init you can also call `~/.agentundo/bin/agentundo` directly.

- **Codex**: hooks go to `~/.codex/hooks.json` (user level; they do nothing in folders where you didn't run init). Codex asks you to trust new hooks once: start `codex`, open `/hooks`, and trust the two `agentundo-hook` entries (`PreToolUse`, `UserPromptSubmit`).
- **Claude Code**: hooks go to `.claude/settings.local.json` in the project (not committed; agentundo adds it to `.git/info/exclude`). Use `--claude-scope user` for `~/.claude/settings.json` instead.

## Commands

```
agentundo list [--limit 20 | --all] [--dangerous]   snapshots: id, turn, the command it preceded, ⚠ + reason for dangerous ones
agentundo diff <id> [--patch] [-- <paths>]   what changed between that snapshot and now
agentundo restore <id> [--dry-run] [--yes] [-- <paths>]
agentundo snap [note] [--json]               take a snapshot by hand
agentundo receipt --status <s> --json        used by agentreceipt (see below)
agentundo status                             storage, caps, hooks, last failure
agentundo prune --keep <n>
agentundo uninstall [--global] [--purge] [--yes]
```

`<id>` is a snapshot number (`3`), the start of a turn (`t2`), or a step inside a turn (`t2.1` = turn 2, before its first command).

- **restore always snapshots the current state first**, so every restore can be undone (`Undo this restore: agentundo restore <n>`).
- `restore <id> -- src/foo.js docs/` only restores those paths and leaves the agent's other changes alone. Everything after `--` is a path, except `--yes`, `-y`, and `--dry-run`, which are accepted on either side of `--`.
- restore only deletes files the snapshot would have captured. Files that were ignored, excluded (`node_modules`, `.env`…), or over the size cap at snapshot time are never deleted, even if your `.gitignore` changed since then.
- Answering `n` at the prompt cancels the restore and exits with code 1.
- restore lists what it will write and remove and asks first. Without a terminal it refuses unless you pass `--yes`.
- Files are written to a temp folder and renamed into place one by one. If a restore is interrupted (Ctrl+C, crash), agentundo remembers it: re-run the same `restore` to finish, or restore the pre-restore snapshot to go back.

## Dangerous-command alerts (v0.1.2)

agentundo only **notifies**; it never blocks a command.

- **Dedicated snapshot.** Before a dangerous command the hook always takes its own snapshot, even if no file changed since the previous one, and `list` marks it `⚠ dangerous (<reason>)`. `agentundo list --dangerous` shows only those. The first command of every turn and every file-removing command (`rm`, `mv`, `unlink`, ...) also always get their own `before …` entry.
- **What counts as dangerous:** `rm -r`/`-rf`/`-fr`/`-r -f`/`--recursive [--force]`, `rimraf`, `find -delete`, `find -exec rm`, `git reset --hard`, `git clean -f…` (`-fd`, `-fdx`, `-xdf`), `git checkout -- <path>` / `git checkout .`, `git restore <path>` (not `--staged` only), `git stash drop|clear`, `git push --force`, `git branch -D`, `mkfs`, `dd of=`, `shred`, `prisma migrate reset`, apply_patch file deletions; and, when a database client runs (`psql`, `mysql`, `sqlite3`, `mongosh`, `redis-cli`, ...), `DROP TABLE|DATABASE|SCHEMA`, `TRUNCATE`, `DELETE FROM`, `dropDatabase()`, `FLUSHALL` (case-insensitive, including inside `psql -c`, `mysql -e`, `sqlite3 db "…"` and `echo … | psql`).
- **What does not:** the command is parsed like a shell would (quotes, `;`, `&&`, `|`, `$( )`), and only the program actually run is checked, after skipping `sudo`, `env`, `VAR=x`, `xargs`, `timeout` etc. `bash -c '…'`/`sh -c` are analysed recursively. So `echo rm -rf x`, `grep "git reset --hard" notes`, `git commit -m "drop table"` are not flagged, and SQL keywords are ignored unless a database client runs.
- **Remote databases.** If a write (or destructive SQL, a `-f file.sql`/`< dump.sql` input, or a migration tool) targets a non-local host — `postgres://`, `postgresql://`, `mysql://`, `mongodb(+srv)://`, `redis://` URIs, `psql/mysql -h <host>`, `PGHOST=…`, inline `DATABASE_URL=…` — the user sees:
  `⚠ agentundo: this step touches a remote database (<host>) — local snapshots cannot undo it.`
  `localhost`, `127.x`, `::1`, empty hosts and unix sockets (`host=/var/run/…`) count as local. Read-only queries (`SELECT`, `\dt`) against a remote host do not warn.
- **How it is shown.** Claude Code and Codex: the PreToolUse hook prints `{"systemMessage": …}` and exits 0 (no decision field, so the command always runs). Claude Code shows it as a hook message; the Codex TUI shows it as `↳ Hook · …`. `codex exec` (non-interactive) does not print hook messages. Any error in the hook fails open.
- **Secrets.** Passwords in connection strings (`u:***@`), `*_PASSWORD=`/`*_TOKEN=`/`*_API_KEY=` assignments, `--password=…`, `mysql -p<pw>` and `redis-cli -a <pw>` are redacted before anything is stored, listed, logged or shown. (The agent's own UI may still display the raw command it ran.)

## How it works

- Snapshots live in a private git repo **outside your project**: `~/.agentundo/stores/<hash>/`. agentundo runs git with its own `GIT_DIR`, work tree, and index, so your `.git` (history, index, branches, stash) is never read or changed, and an agent running `rm -rf .` can't delete the snapshots. Projects without git work too.
- Identical files are stored once. When nothing changed, no new snapshot is made, except that the first command of each turn and dangerous commands always get a `before …` entry.
- Included: tracked and untracked files, symlinks, the executable bit, binaries, and SQLite databases (`*.db`, `*.sqlite`, `*.sqlite3` with `-wal`/`-shm`), even if your `.gitignore` ignores them.
- Excluded by default: whatever your `.gitignore` ignores, plus `node_modules/ .venv/ venv/ __pycache__/ dist/ build/ target/ .next/ .nuxt/ .cache/ coverage/` and `.env` / `.env.*` (except `.env.example`).
- Caps: files over **50MB** are skipped. You get a warning each time, and `list` shows the skipped files. Total storage is capped at **2GB**. Over the cap, the oldest snapshots are deleted (the newest 20 are always kept) and you are told **every time**. Snapshotting never stops silently.
- If the snapshot store is deleted, the next hook recreates it, takes a new baseline, and warns that earlier snapshots are lost.
- Hooks fail open. If a snapshot fails, the agent keeps working, the error is logged (`agentundo status`), and the agent shows a `systemMessage` saying that step isn't undoable. A hook adds about 60ms per tool call in a 5,000-file repo.

Optional `.agentundo/config.json` in the project:

```json
{ "maxFileMB": 50, "maxTotalMB": 2048, "keepMin": 20, "includeEnv": false, "exclude": ["data/raw/"] }
```

## Limitations

- **Remote databases and cloud resources can't be restored.** `DROP TABLE` on a remote Postgres, `git push --force`, `terraform destroy`, or API calls are outside the project. agentundo warns when it sees such commands, but a local snapshot can't undo them.
- **Files outside the project folder are not snapshotted.** `rm -rf ~/Documents` can't be undone. agentundo only warns.
- **`.env` files are not snapshotted** by default, to keep secrets out of the store. Set `"includeEnv": true` to include them. Snapshots stay on your machine either way.
- Files ignored by your `.gitignore` (other than database files) and the default excluded folders are not snapshotted. `restore` never deletes them.
- A SQLite file snapshotted while another process is writing to it may be inconsistent. Close the app using the database before you restore.
- Some special agent tools may not trigger the per-command hook. The per-turn snapshot is the fallback, so you can go back to the start of that turn.
- Restore is atomic per file, not for the whole tree. An interrupted restore can be finished or undone as described above.
- Needs git. Tested on Linux; macOS untested in v0.1. Windows is untested in v0.1.

## Uninstall

```
agentundo uninstall            # this project: removes its hooks and exclude block, keeps snapshots
agentundo uninstall --global   # every project
agentundo uninstall --purge    # also delete the snapshots (asks first; --yes without a terminal)
```

Uninstall only removes what agentundo added, and prints what it deleted and kept for each project. The Codex hook and the runtime are removed once no project uses them.

## With agentreceipt

If [agentreceipt](https://github.com/mulanxizhizi-png/agentreceipt) (v0.1.3+) is installed too, each receipt records the snapshot it verified. `agentundo list` then shows `✓ tests passed` / `✗ tests failed` next to those snapshots, plus the last snapshot where tests passed. Red receipts include the command to go back to that snapshot.

Machine interface (stable, `schemaVersion: 1`, always exits 0 with one JSON line):

```
agentundo receipt --status green|red|blocked [--receipt <name>] --json
  -> {"schemaVersion":1,"ok":true,"snapshotId":9,"created":true,"lastGreenSnapshotId":4,"restoreCommand":"~/.agentundo/bin/agentundo restore 4","warnings":[]}
  -> {"schemaVersion":1,"ok":false,"reason":"not-initialized"}   (agentundo not set up in this project)
agentundo snap --json [--label <text>]
agentundo list --json
```

When storage is over the cap, the newest green snapshot is never pruned. agentreceipt's own `.agentreceipt/receipts/`, `state/`, and `logs/` are not snapshotted, so a restore never deletes newer receipts.

## Works well with

- [agentreceipt](https://github.com/mulanxizhizi-png/agentreceipt): makes the agent show passing tests before it says "done". agentreceipt catches agents that falsely claim the work is done. agentundo undoes accidental deletions.
- [cc-safety-net](https://github.com/kenryu42/cc-safety-net): blocks dangerous commands before they run. agentundo is the backstop for everything a blocker lets through.

## License

MIT

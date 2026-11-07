# ai-tools

Small, dependency-free tools for running coding agents (Claude Code, Codex) on a real repository — several sessions at once, on one machine.

| Tool | What it does |
| --- | --- |
| [`test-queue`](#test-queue-one-test-run-per-machine) | One test run per machine. Every session's test runs wait in one first-come-first-served queue shared by all worktrees; a Claude Code hook refuses test commands that skip it; the `wait-for-tests` skill tells agents how to behave. |
| [`skill-sync`](#skill-sync-write-a-skill-once) | Write a skill once, use it in Claude Code and Codex. Relative symlinks expose `.claude/skills/` to Codex, and hooks keep a `SKILLS.md` catalog current. |

Requires Git and Node.js 22+. macOS and Linux (Windows: use WSL).

## Install

Into the repository you are standing in, without cloning:

```sh
npx -y github:CesarArdilaB/ai-tools install test-queue
npx -y github:CesarArdilaB/ai-tools install skill-sync
npx -y github:CesarArdilaB/ai-tools install all
```

Or from a clone:

```sh
git clone https://github.com/CesarArdilaB/ai-tools.git
node ai-tools/bin/ai-tools.mjs install test-queue --target ~/code/my-repo
```

| Command | Purpose |
| --- | --- |
| `ai-tools list` | Show the tools |
| `ai-tools install <tool…\|all>` | Copy the tool's files, merge its hooks into your settings |
| `ai-tools uninstall <tool…\|all>` | Remove the hooks and every file still identical to what was shipped |
| `--target <dir>` | Install into the git repository containing `<dir>` (default: the current directory's) |
| `--dry-run` | Print what would change; write nothing |
| `--force` | Replace (or remove) files you changed since install |

The installer is idempotent and conservative:

- Files land at the same relative paths they have in this repository. A file you already have and changed is **kept** (re-run with `--force` to replace it).
- Hooks are **merged** into `.claude/settings.json` / `.codex/hooks.json`: existing hooks and other settings are preserved, and running twice adds nothing.
- Skills are also linked into `.agents/skills/` when your repository uses that folder (Codex).
- Commit what it adds. Restart your agent (or review its hooks) so the new hooks load; Codex requires you to trust new hook definitions explicitly.

## test-queue: one test run per machine

Run three agent sessions in three worktrees and they will all start the test suite at once. The suites do not each finish in their usual time: they fight for the same cores — minutes become tens of minutes — and for any shared local resource (a test database, a port, a cache), where one run wipes another's state mid-run. Queuing is faster for everyone.

```text
scripts/test-lock.mjs                   # CLI: status | wait | run -- <cmd…>
scripts/lib/test-lock.mjs               # the lock (importable: acquireTestLock())
.claude/hooks/test-queue-guard.mjs      # PreToolUse(Bash) guard for Claude Code
.claude/skills/wait-for-tests/SKILL.md  # how agents use the queue
```

**The lock.** A directory in the git *common* dir (`.git/agent-test-run.lock`), so every worktree of the repository — every session — shares it. `mkdir` is atomic, so two runs can never both hold it. Waiting runs write a ticket into `.git/agent-test-run.lock.queue/` and start strictly in arrival order. The head of the queue also waits for test processes running anywhere on the machine outside this queue (`node --test`, `tsx --test`, `vitest`, `jest`) — a raw run in this repository, or another repository's suite — since they compete for the same cores.

**It cleans up after itself.** A holder whose process died is taken over. A run whose starting shell is gone (the agent stopped its background task, the session ended) leaves the queue, or — if it holds the lock — stops its whole process tree and releases it. A run killed by a signal takes its children down *before* it releases, so no orphaned workers run beside the next suite. An outside test process older than 45 min is reported as stale and no longer waited for.

```sh
node scripts/test-lock.mjs run -- npm test         # wait your turn, hold the lock, run, release
node scripts/test-lock.mjs status                   # holder, queue (every session), unlocked runs
node scripts/test-lock.mjs wait                     # wait for your turn, then hand it straight on
```

`run` exits with the command's status. A command started under the lock that takes the lock again (a nested `test-lock.mjs run`, or a runner calling `acquireTestLock()`) does not wait for itself.

### Wire it into your repository

1. Route the root test script through the lock, so `npm test` queues on its own:

   ```json
   { "scripts": { "test": "node scripts/test-lock.mjs run -- vitest run" } }
   ```

2. If a pre-push hook runs tests, run them the same way: `node scripts/test-lock.mjs run -- npm test`. The guard then treats `git push` as a queued test command.
3. A custom runner can take the lock itself:

   ```js
   import { acquireTestLock } from './lib/test-lock.mjs'
   const release = await acquireTestLock({ label: 'my-runner' })
   try { /* run the suite */ } finally { release() }
   ```

### The guard hook

Advice in a skill can be skipped; the hook makes the queue the rule. On every Bash call it refuses, with the reason and the exact command to run instead:

- a raw runner — `node --test`, `tsx --test`, `vitest`, `jest`, `bun test`, `pnpm --filter <pkg> test`, `npm test` inside a package, or a root test script that does not go through the lock — and suggests the same command wrapped in `scripts/test-lock.mjs run --`;
- a test command in the foreground (the wait would outlast the Bash timeout and lose the place in the queue) — use `run_in_background: true`;
- a second test run from a checkout that already holds or waits for the lock;
- the escapes (`TEST_NO_LOCK=1`, `TEST_LOCK_WAIT_UNLOCKED=0`) and `kill`/`pkill` aimed at test runs.

It never rewrites a command, and any unexpected error exits silently — the guard must never break Bash. A command that `cd`s into another repository is judged by that repository's queue, not this one.

Optional `.claude/test-queue.json`:

```json
{
    "selfQueuing": ["scripts/run-tests.mjs"],
    "escapes": ["PRE_PUSH_NO_LOCK=1"],
    "protect": ["my-test-postgres"]
}
```

| Key | Meaning |
| --- | --- |
| `selfQueuing` | Node scripts that call `acquireTestLock()` themselves — treated as queued, not raw |
| `escapes` | More `VAR=value` prefixes that skip your queue; refused like `TEST_NO_LOCK=1` |
| `protect` | Processes whose command contains one of these strings may not be killed (a test database, say) |

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEST_NO_LOCK=1` | — | Do not wait. For you, from your own terminal — the guard refuses it from an agent |
| `TEST_LOCK_POLL_MS` | `5000` | How often a waiting run retries |
| `TEST_LOCK_STALE_MIN` | `45` | Minutes after which an unlocked test process is reported stale and not waited for |
| `TEST_LOCK_DIR` | `<git common dir>/agent-test-run.lock` | Lock location override (tests) |
| `TEST_LOCK_WAIT_UNLOCKED=0` | — | The head of the queue does not wait for unlocked runs (tests) |

Codex gets the skill and the CLI; the guard is a Claude Code `PreToolUse` hook.

## skill-sync: write a skill once

```text
.claude/skills/explain-change/   # the maintained skill
.agents/skills/explain-change   # relative symlink to it (Codex discovers this)
SKILLS.md                       # catalog, updated automatically
```

Claude reads `.claude/skills/`. Codex discovers the linked folders in `.agents/skills/`. Both agents run `scripts/sync-agent-skills.mjs --hook` after file edits and shell commands, and again at the end of a turn. The updater only changes its marked catalog section and creates missing links. It preserves other prose, refuses conflicting entries, and reports dangling links without deleting them.

Add a skill by creating `.claude/skills/my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: Describe the specific task this skill helps with and when to use it.
---

Write the instructions here.
```

The next matching hook creates `.agents/skills/my-skill` and the catalog row; outside an agent, run `node scripts/sync-agent-skills.mjs`. Commit the source, link, and catalog together. Use portable instructions: a symlink shares files, it does not translate agent-specific tools.

| Command | Purpose |
| --- | --- |
| `node scripts/sync-agent-skills.mjs` | Create missing links and refresh the catalog |
| `node scripts/sync-agent-skills.mjs --check` | Validate without writing; exit nonzero for drift or conflicts |
| `node scripts/sync-agent-skills.mjs --hook` | Update with JSON output suitable for agent hooks |

If a skill is deleted or renamed, remove its obsolete link yourself after verifying the target.

This repository dogfoods it: [SKILLS.md](SKILLS.md) lists `wait-for-tests` and two example skills, `explain-change` and `document-command`.

- [Claude Code skills](https://code.claude.com/docs/en/skills#choose-where-skills-load) · [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex skills](https://learn.chatgpt.com/docs/build-skills) · [Codex hooks and trust](https://learn.chatgpt.com/docs/hooks)

## Develop

```sh
npm test               # every scripts/*.test.mjs, through this repo's own test queue
npm run skills:check
git diff --check
```

Contributions welcome: include your OS, Node version, agent version, and a minimal reproduction without secrets.

## License

MIT. The skills are original to this repository; no third-party skill bundles are included.

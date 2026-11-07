---
name: wait-for-tests
description: Use BEFORE running any local test command — `npm test`, `pnpm test`, `pnpm --filter <pkg> test`, `node --test`, `npx tsx --test <file>`, `vitest run`, `jest`, or a `git push` whose pre-push hook runs tests — and whenever a test run seems slow, stuck, or fails because another run wiped shared test state. Several agent sessions share this machine; only one test run may go at a time, and every session's runs wait in ONE first-come-first-served queue.
---

# Wait for tests — one test run per machine

Several agent sessions work on this machine at once, often one per git
worktree. Two test runs at the same time do not each finish in their usual
time: they fight for the same cores, so minutes become tens of minutes, and
they share local test resources (a database, a port, a cache directory) where
one run can wipe the other's state mid-run. Queuing is faster for everyone
than running side by side.

The queue is machine-wide, not per session: a lock in the git common dir
(`.git/agent-test-run.lock`), which every worktree — so every session —
shares, plus its waiting room `.git/agent-test-run.lock.queue/`
(`scripts/lib/test-lock.mjs`). A run from any session that has to wait writes
a ticket there, and runs start in arrival order: your run waits behind the
runs other sessions queued before it, and theirs wait behind yours.

The run at the front of the queue also waits for test runs some session
started WITHOUT the lock (a raw `node --test`, `vitest run`, `jest`) before it
starts.

## The guard hook enforces this

`.claude/hooks/test-queue-guard.mjs` (PreToolUse on every Bash call, every
session) refuses, with the reason and the command to run instead:

- a raw runner (`node --test`, `tsx --test`, `vitest`, `jest`, `bun test`,
  `pnpm --filter <pkg> test`, a root `npm test` whose script does not go
  through the lock) — it tells you the same command wrapped in
  `scripts/test-lock.mjs run --`;
- any test command in the foreground — re-run it with
  `run_in_background: true`;
- a second test run while your checkout already holds or waits for the lock;
- the escapes (`TEST_NO_LOCK=1`, `TEST_LOCK_WAIT_UNLOCKED=0`, and any the repo
  lists in `.claude/test-queue.json`) and kills aimed at test runs.

A refusal is not an error to work around — follow it. The reason ends with
the queue as it is now.

## What already queues on its own

- `node scripts/test-lock.mjs run -- …` and `node scripts/test-lock.mjs wait`
- a root test script whose body goes through `test-lock`
  (`"test": "node scripts/test-lock.mjs run -- vitest run"`)
- `git push`, when the pre-push hook runs its tests through `test-lock`
- any runner the repo lists as `selfQueuing` in `.claude/test-queue.json`

## Everything else: wrap it

A raw runner does not know about the queue. Put it behind the lock:

```bash
node scripts/test-lock.mjs run -- npm test
node scripts/test-lock.mjs run -- node --test src/foo.test.mjs
node scripts/test-lock.mjs run -- pnpm --filter @scope/pkg test
node scripts/test-lock.mjs run -- npx vitest run src/foo.test.ts
```

The exit status is the command's. Anything the command starts under the lock
(a nested `test-lock.mjs run`) does not wait for itself.

## Check before you start

```bash
node scripts/test-lock.mjs status   # the holder, the queue (every session), raw runs outside it
node scripts/test-lock.mjs wait     # take a place in the queue; returns when your turn comes (then start your run)
```

`status` prints three kinds of line:

- `busy — pid …` — the run holding the lock: pid, worktree, age, command.
- `queued #N — pid … in <worktree>, waiting M min` — runs from any session
  waiting their turn, in the order they will start. Yours is among them while
  you wait.
- `unlocked test process — pid …` — a raw run someone started without the
  wrapper. It still eats CPU and shared resources; the head of the queue and
  `wait` both wait for it.

## Waiting costs tool time — run tests in the background

The wait counts against the Bash call. A queue of two or three full suites can
be 20 minutes, past the 2-minute default and the 10-minute ceiling. So:

- Start any test command that may queue with **`run_in_background: true`**.
  You are notified when it exits — do not poll it, do not `sleep`.
- Meanwhile do work that is not a test run: read the diff, review, write the
  next test, update docs. Lint and type-checks are fine.
- A `[test-lock] another test run holds the machine (…); #N in the queue`
  line once a minute is the queue working, not a hang. `#N` is your place.

## Never

- Never kill, `kill -9` or `pkill` another session's test processes, or the
  lock holder — it is somebody's run.
- Never delete `.git/agent-test-run.lock` while its holder is alive, or
  another run's ticket in `.git/agent-test-run.lock.queue/`. A dead holder's
  lock is taken over, and a dead run's ticket removed, automatically.
- Never set `TEST_NO_LOCK=1` or another escape to jump the queue. Those are
  the user's, not an agent's.
- Never run two test commands of your own at once (two background test runs,
  or a test run beside `git push`). Wait for the first.

## Stopped sessions leave the queue

A run remembers the processes that started it. When one dies — you stopped
the background task, the session ended — the run leaves the queue if it is
waiting, or stops its tree and releases the lock if it is holding (within one
poll, 5 s). A dead session no longer keeps a place and runs for nobody.

## Kills and hung runs clean up after themselves

A run killed by a signal (a tool timeout, Ctrl-C) takes its whole process
tree down before it releases the lock — no orphaned workers left running
beside the next run. An outside test process older than 45 min
(`TEST_LOCK_STALE_MIN`) shows as `stale unlocked test process` in `status` and
is no longer waited for; report it to the user.

## When the holder looks stuck

If `status` shows the same holder for far longer than a full suite (over
~30 min) and its log is silent, do not kill it. Tell the user: the pid, the
worktree, the command and how long it has held the lock — they decide.

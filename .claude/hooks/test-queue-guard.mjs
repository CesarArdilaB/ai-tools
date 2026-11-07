#!/usr/bin/env node
/**
 * PreToolUse(Bash) guard for the machine's one test queue
 * (scripts/lib/test-lock.mjs, the `wait-for-tests` skill).
 *
 * The queue only works when every test run goes through it, and the skill
 * that says so is advice an agent can skip. This hook makes it the rule, for
 * every session in this repository:
 *
 *   1. A raw runner (`node --test`, `tsx --test`, `vitest`, `jest`,
 *      `bun test`, `npm test` whose script does not take the lock,
 *      `pnpm --filter <pkg> test`) is refused with the same command wrapped
 *      in `scripts/test-lock.mjs run --`. A raw run does not wait for anyone;
 *      it only makes everyone else wait for it.
 *   2. A test command in the foreground is refused: queueing plus a full
 *      suite outlasts the Bash tool's timeout, which kills the run and
 *      throws the place in the queue away. It must use run_in_background.
 *   3. A second test run from a checkout that already has one holding or
 *      waiting for the lock is refused (two runs of one session at once).
 *   4. The queue's escapes (TEST_NO_LOCK=1, TEST_LOCK_WAIT_UNLOCKED=0, and
 *      any listed in the config) and kills aimed at test runs are refused.
 *      They are the user's, from their own terminal.
 *
 * Optional config, `.claude/test-queue.json` next to this hook:
 *
 *   {
 *     "selfQueuing": ["scripts/run-tests.mjs"],  // node scripts that call
 *                                                // acquireTestLock() themselves
 *     "escapes": ["PRE_PUSH_NO_LOCK=1"],         // more env escapes to refuse
 *     "protect": ["my-test-pg"]                  // never kill processes whose
 *                                                // command contains these
 *   }
 *
 * A root `npm|pnpm|yarn test` counts as queued when its package.json script
 * goes through `test-lock`; `git push` counts as queued when the pre-push
 * hook does. Otherwise `git push` is not a test command at all.
 *
 * It refuses with a reason and never rewrites the command: a rewritten
 * command would be auto-approved, and the agent should see what it runs.
 * Anything unexpected exits 0 silently — the guard must never break Bash.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_ESCAPES = ['TEST_NO_LOCK=1', 'TEST_LOCK_WAIT_UNLOCKED=0']

const escapeRe = (s) =>
    new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)

/** The command without heredoc bodies (their lines are text, not commands). */
function stripHeredocs(command) {
    const lines = command.split('\n')
    const out = []
    let end = null
    for (const line of lines) {
        if (end !== null) {
            if (line.trim() === end) end = null
            continue
        }
        out.push(line)
        const open = line.match(/<<-?\s*['"]?([A-Za-z_][\w]*)['"]?/)
        if (open) end = open[1]
    }
    return out.join('\n')
}

/** Simple commands of a shell line: split on `&&`, `||`, `;`, `|`, newlines. */
export function segments(command) {
    return stripHeredocs(command)
        .split(/&&|\|\||;|\||\n/)
        .map((s) => s.trim().replace(/^[({]\s*/, ''))
        .filter(Boolean)
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/

/** argv of a segment with env assignments and launcher prefixes removed. */
export function argvOf(segment) {
    let t = segment.split(/\s+/).filter(Boolean)
    for (;;) {
        const before = t.length
        while (t.length && ASSIGN.test(t[0])) t.shift()
        if (['env', 'time', 'exec', 'command', 'nohup'].includes(t[0]))
            t.shift()
        if (
            t[0] === 'npx' ||
            t[0] === 'bunx' ||
            (['pnpm', 'yarn'].includes(t[0]) && ['exec', 'dlx'].includes(t[1]))
        ) {
            t.shift()
            if (['exec', 'dlx'].includes(t[0])) t.shift()
            while (t[0]?.startsWith('-')) t.shift()
        }
        if (t[0] && /(^|\/)dotenv$/.test(t[0])) {
            const dash = t.indexOf('--')
            t = dash === -1 ? [] : t.slice(dash + 1)
        }
        if (t.length === before) break
    }
    if (t[0]) t[0] = t[0].replace(/^.*node_modules\/\.bin\//, '')
    return t
}

const base = (arg = '') => arg.split('/').pop()

/** What the repository says goes through the lock on its own. */
const NO_CONTEXT = {
    queuedScripts: new Set(),
    pushQueued: false,
    selfQueuing: [],
}

/**
 * What a segment is to the queue:
 *   'queued' — goes through the lock on its own (`test-lock.mjs run|wait`,
 *              a root test script that wraps it, a self-queuing runner,
 *              `git push` when the pre-push hook takes the lock)
 *   'raw'    — a test run that ignores the lock
 *   null     — not a test run
 */
export function classify(segment, { atRoot = true, ctx = NO_CONTEXT } = {}) {
    const t = argvOf(segment)
    if (!t.length) return null
    const [cmd] = t
    if (cmd === 'git') {
        const sub = t
            .slice(1)
            .filter((a, i, all) => !a.startsWith('-') && all[i - 1] !== '-C')
        if (sub[0] !== 'push' || t.includes('--no-verify')) return null
        return ctx.pushQueued ? 'queued' : null
    }
    if (/^(node|tsx)(\d+)?$/.test(base(cmd))) {
        const script = t.slice(1).find((a) => !a.startsWith('-'))
        if (base(script) === 'test-lock.mjs')
            // `wait` holds a place in the queue, so it can wait as long.
            return ['run', 'wait'].includes(t[t.indexOf(script) + 1])
                ? 'queued'
                : null
        if (script && ctx.selfQueuing.some((s) => base(s) === base(script)))
            return 'queued'
        if (t.includes('--test') && !t.includes('--watch')) return 'raw'
        return null
    }
    if (base(cmd) === 'vitest') {
        const rest = t.slice(1)
        if (
            rest.includes('--watch') ||
            ['watch', 'dev', 'bench'].includes(rest[0])
        )
            return null
        return 'raw'
    }
    if (base(cmd) === 'jest') {
        if (t.includes('--watch') || t.includes('--watchAll')) return null
        return 'raw'
    }
    if (cmd === 'bun' && t[1] === 'test')
        return t.includes('--watch') ? null : 'raw'
    if (cmd === 'pnpm' || cmd === 'npm' || cmd === 'yarn' || cmd === 'bun') {
        let filtered = false
        let i = 1
        for (; i < t.length; i++) {
            const a = t[i]
            if (
                ['--filter', '-F', '-C', '--dir', '--prefix', '-w', '--workspace'].includes(a)
            ) {
                if (!['-C', '--dir', '--prefix'].includes(a)) filtered = true
                i++
            } else if (/^--(filter|workspace)=/.test(a)) filtered = true
            else if (['-r', '--recursive', '--workspaces', '-ws'].includes(a))
                filtered = true
            else if (!a.startsWith('-')) break
        }
        if (
            t
                .slice(i + 1)
                .some((a) =>
                    /^(-w|-ws|--workspaces?(=.*)?|--filter(=.*)?|-F|-r|--recursive)$/.test(
                        a,
                    ),
                )
        )
            filtered = true
        let script = t[i]
        if (script === 'run' || script === 'run-script') script = t[i + 1]
        if (cmd === 'yarn' && script === 'workspace') {
            filtered = true
            script = t[i + 2] === 'run' ? t[i + 3] : t[i + 2]
        }
        if (script === 'exec' || script === 'dlx')
            return classify(t.slice(i + 1).join(' '), { atRoot, ctx })
        if (!script) return null
        if (['vitest', 'tsx', 'jest'].includes(script))
            return classify(t.slice(i).join(' '), { atRoot, ctx })
        if (cmd === 'npm' && script === 't') script = 'test'
        if (!/^test(:|$)/.test(script)) return null
        // Only a root script that wraps the lock is queued; inside a package,
        // or across a workspace filter, a test script is that package's raw
        // runner.
        if (filtered || !atRoot || !ctx.queuedScripts.has(script)) return 'raw'
        return 'queued'
    }
    return null
}

const isKill = (t) => ['kill', 'pkill', 'killall'].includes(t[0])

/** Repository root of `cwd`, or null. */
function toplevel(cwd) {
    const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
    })
    return git.status === 0 ? git.stdout.trim() : null
}

const inside = (path, root) =>
    !!path && !!root && (path === root || path.startsWith(root + sep))

/**
 * Each segment with its kind, following `cd` so a bare `npm test` inside a
 * package counts as that package's raw runner.
 */
export function classifyAll(command, { cwd, root, ctx = NO_CONTEXT }) {
    let dir = cwd
    return segments(command).map((seg) => {
        const t = argvOf(seg)
        if (t[0] === 'cd' && t[1]) {
            const target = t[1].replace(/^['"]|['"]$/g, '')
            dir = target.startsWith('~') ? target : resolve(dir ?? '.', target)
            return [seg, null]
        }
        return [
            seg,
            classify(seg, {
                atRoot: !root || !dir || resolve(dir) === root,
                ctx,
            }),
        ]
    })
}

/**
 * The directory the command really runs in: a leading `cd <dir> &&` moves
 * it, so `cd ../other-repo && npm test` is judged by the other repository's
 * queue (or none), not by the session's.
 */
export function effectiveCwd(command, cwd) {
    const first = segments(command)[0]
    const t = first ? argvOf(first) : []
    if (t[0] !== 'cd' || !t[1]) return cwd
    const target = t[1].replace(/^['"]|['"]$/g, '')
    if (target === '~' || target.startsWith('~/'))
        return join(process.env.HOME ?? '/', target.slice(1))
    return resolve(cwd, target)
}

/** Is this Bash call something the guard must look at? */
export function relevant(
    command,
    { escapes = BASE_ESCAPES, selfQueuing = [] } = {},
) {
    // Here git push might be queued: read the state and decide properly.
    const ctx = { ...NO_CONTEXT, pushQueued: true, selfQueuing }
    return (
        escapes.some((e) => escapeRe(e).test(command)) ||
        segments(command).some(
            (s) => classify(s, { ctx }) || isKill(argvOf(s)),
        )
    )
}

/**
 * The decision for one Bash call: a deny reason, or null to let it run.
 * `s` is the lock state (`readState`): { root, lockCli, summary, mine,
 * protectedPids, ctx, escapes, protect }.
 */
export function decide(input, s) {
    const command = input.tool_input?.command
    if (typeof command !== 'string' || !command.trim()) return null
    const escapes = s.escapes ?? BASE_ESCAPES
    const bypass = escapes.find((e) => escapeRe(e).test(command))
    const segs = segments(command)
    const kinds = classifyAll(command, {
        cwd: input.cwd,
        root: s.root,
        ctx: s.ctx ?? NO_CONTEXT,
    })
    const tests = kinds.filter(([, k]) => k)
    const kills = segs.map(argvOf).filter(isKill)

    if (bypass && tests.length)
        return `${bypass} skips the machine's test queue. That escape is the user's, from their own terminal — never an agent's. Drop it and run the command in the background (run_in_background: true); it waits its turn. See the wait-for-tests skill.`

    if (kills.length) {
        const words = ['tsx', 'vitest', 'jest', 'test-lock', '--test', ...(s.protect ?? [])]
        const killsTests = kills.some((t) => {
            if (t[0] !== 'kill')
                return t.slice(1).some((a) => words.some((w) => a.includes(w)))
            const pids = t
                .slice(1)
                .filter((a) => /^\d+$/.test(a))
                .map(Number)
            return pids.some((p) => s.protectedPids.has(p))
        })
        if (killsTests)
            return `That kills a test run or a test resource — somebody's run, maybe another session's. Never kill test processes or the lock holder. If a run looks stuck (same holder for 30+ min, silent log), tell the user the pid, worktree, command and age from \`node scripts/test-lock.mjs status\`; they decide.`
    }

    if (!tests.length) return null
    const raw = tests.find(([, k]) => k === 'raw')
    if (raw) {
        const [seg] = raw
        const [, assigns, rest] = seg.match(
            /^((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)(.*)$/s,
        )
        const wrapped = `${assigns}node ${s.lockCli} run -- ${rest}`
        return `\`${rest.slice(0, 80)}\` runs tests outside the machine's queue: it does not wait for other sessions' runs, it only makes them wait (and fights them for CPU and shared test resources). Run it through the lock instead, with run_in_background: true:\n\n${command.replace(seg, wrapped)}\n\n${s.summary}`
    }
    if (!input.tool_input?.run_in_background)
        return `Test commands wait in the machine-wide queue (one test run at a time, every session) and can wait for minutes — past the Bash timeout, which would kill the run and lose its place. Re-run the same command with run_in_background: true and keep working; you are notified when it exits (do not poll or sleep).\n\n${s.summary}`
    if (s.mine)
        return `This checkout already has a test run ${s.mine}. One test run per session at a time: wait for its notification, then run this.`
    return null
}

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
        return null
    }
}

/** The repository's own queue wiring: wrapped scripts, pre-push, config. */
export function readContext(root, own) {
    const config = readJson(join(own, '.claude/test-queue.json')) ?? {}
    const scripts = readJson(join(root, 'package.json'))?.scripts ?? {}
    const queuedScripts = new Set(
        Object.entries(scripts)
            .filter(
                ([name, body]) =>
                    /^test(:|$)/.test(name) &&
                    typeof body === 'string' &&
                    /test-lock/.test(body),
            )
            .map(([name]) => name),
    )
    const hooks = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], {
        cwd: root,
        encoding: 'utf8',
    })
    let pushQueued = false
    if (hooks.status === 0) {
        const prePush = resolve(root, hooks.stdout.trim(), 'pre-push')
        pushQueued = existsSync(prePush) &&
            /test-lock/.test(readFileSync(prePush, 'utf8'))
    }
    return {
        ctx: {
            queuedScripts,
            pushQueued,
            selfQueuing: Array.isArray(config.selfQueuing)
                ? config.selfQueuing
                : [],
        },
        escapes: [
            ...BASE_ESCAPES,
            ...(Array.isArray(config.escapes) ? config.escapes : []),
        ],
        protect: Array.isArray(config.protect) ? config.protect : [],
    }
}

/** Lock state for `decide`, read lazily. */
function readState(cwd) {
    const here = dirname(fileURLToPath(import.meta.url))
    // Code is only ever loaded from the hook's own checkout — never from a
    // path derived from the call's cwd, which could be any repository.
    const own = resolve(here, '../..')
    const root = toplevel(cwd) ?? own
    const lockCli = existsSync(join(root, 'scripts/test-lock.mjs'))
        ? join(root, 'scripts/test-lock.mjs')
        : join(own, 'scripts/test-lock.mjs')
    const wiring = readContext(root, own)
    return import(join(own, 'scripts/lib/test-lock.mjs')).then((lock) => {
        const dir = lock.lockDir(cwd)
        // A command in another repository is not this repository's queue.
        if (dir !== lock.lockDir(own)) return null
        const holder = lock.readHolder(dir)
        const queue = lock.readQueue(dir)
        const rows = lock.processTable()
        const unlocked = lock.unlockedTestProcesses(holder?.pid, dir, rows)
        const known = [
            holder?.pid,
            ...queue.map((t) => t.pid),
            ...unlocked.map((p) => p.pid),
        ].filter(Boolean)
        const protectedPids = new Set(
            known.flatMap((p) => [p, ...lock.descendantsOf(p, rows)]),
        )
        for (const row of rows)
            if (wiring.protect.some((w) => row.command.includes(w)))
                protectedPids.add(row.pid)
        const lines = []
        lines.push(
            holder
                ? `Queue now: running pid ${holder.pid} in ${holder.cwd}: ${holder.command.slice(0, 100)}`
                : 'Queue now: free',
        )
        for (const [i, t] of queue.entries())
            lines.push(`  waiting #${i + 1}: pid ${t.pid} in ${t.cwd}`)
        for (const p of unlocked)
            lines.push(
                `  outside the queue${p.stale ? ' (stale)' : ''}: pid ${p.pid}, up ${p.etime}`,
            )
        let mine = null
        if (inside(holder?.cwd, root))
            mine = `holding the lock (pid ${holder.pid}: ${holder.command.slice(0, 80)})`
        else {
            const t = queue.find((q) => inside(q.cwd, root))
            if (t)
                mine = `waiting in the queue (pid ${t.pid}: ${t.command.slice(0, 80)})`
        }
        return {
            root,
            lockCli,
            summary: lines.join('\n'),
            mine,
            protectedPids,
            ...wiring,
        }
    })
}

async function main() {
    let input
    try {
        input = JSON.parse(readFileSync(0, 'utf8'))
    } catch {
        return
    }
    if (input.tool_name !== 'Bash') return
    const command = String(input.tool_input?.command ?? '')
    const cwd = effectiveCwd(command, input.cwd || process.cwd())
    const own = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    const config = readJson(join(own, '.claude/test-queue.json')) ?? {}
    const list = (v) => (Array.isArray(v) ? v : [])
    // Read the lock state (git, ps) only for a command that can matter.
    if (
        !relevant(command, {
            escapes: [...BASE_ESCAPES, ...list(config.escapes)],
            selfQueuing: list(config.selfQueuing),
        })
    )
        return
    const state = await readState(cwd)
    if (!state) return
    const reason = decide({ ...input, cwd }, state)
    if (!reason) return
    process.stdout.write(
        JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: reason,
            },
        }),
    )
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main().catch(() => {})

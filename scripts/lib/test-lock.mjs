/**
 * One local test run at a time on this machine.
 *
 * Several agent sessions (one per worktree) start test suites at once. Two
 * suites side by side do not each finish in their usual time: they fight for
 * the same cores (minutes become tens of minutes) and for any shared local
 * resource — a test database, a port, a cache directory — where one run can
 * wipe the other's state mid-run. Queuing is faster for everyone.
 *
 * The lock is a directory in the git common dir (shared by every worktree of
 * the repository — so by every session on this machine) holding
 * `holder.json`. `mkdir` is atomic, so two runs can never both take it. A
 * holder whose process is gone is taken over. Child processes inherit
 * `TEST_LOCK_HOLDER_PID`, so a test runner started under a held lock (one
 * that takes the lock itself) does not wait for itself.
 *
 * Waiting runs queue first come, first served, whichever session started
 * them: each writes a ticket into `<lock>.queue/` and only the oldest live
 * ticket may take the lock. The head of the queue also waits for test runs
 * some session started WITHOUT the lock (a raw `tsx --test`, `vitest run`,
 * or a runner from a branch that predates the lock) before it starts.
 *
 *   TEST_NO_LOCK=1   do not wait (for the user only — never an agent's way
 *                    around a queue)
 *   TEST_LOCK_DIR    lock directory override (tests)
 *   TEST_LOCK_POLL_MS  how often a waiting run retries (default 5000)
 *   TEST_LOCK_WAIT_UNLOCKED=0  the head of the queue does not wait for
 *                    unlocked test runs (tests of this module)
 *   TEST_LOCK_UNLOCKED_MATCH  only processes whose command contains this
 *                    count as unlocked test runs (tests of this module, so
 *                    other sessions' suites do not stall them)
 *   TEST_LOCK_STALE_MIN  an unlocked test process older than this many
 *                    minutes (default 45) is reported as stale and no longer
 *                    waited for — a hung orphan must not stop the machine
 *
 * A run whose starting shell is gone (an agent stopped its background task:
 * the shell dies, this process is re-parented and nobody reads its output)
 * leaves the queue while it waits, and stops its tree and releases the lock
 * while it holds. A dead session's run used to keep its place and run for
 * nobody while everyone behind it waited.
 *
 * A run killed by a signal (a Bash tool timeout, Ctrl-C) takes its whole
 * process tree down BEFORE it releases the lock. `process.exit()` alone
 * leaves a runner's worker children (`tsx --test`, vitest/jest workers)
 * running as orphans beside the next run.
 */
import { spawnSync } from 'node:child_process'
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

export const HOLDER_ENV = 'TEST_LOCK_HOLDER_PID'

/** The lock directory: `<git common dir>/agent-test-run.lock`. */
export function lockDir(cwd = process.cwd()) {
    if (process.env.TEST_LOCK_DIR) return resolve(process.env.TEST_LOCK_DIR)
    const git = spawnSync('git', ['rev-parse', '--git-common-dir'], {
        cwd,
        encoding: 'utf8',
    })
    if (git.status !== 0)
        throw new Error('test-lock: not inside a git checkout')
    return join(resolve(cwd, git.stdout.trim()), 'agent-test-run.lock')
}

export function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        // EPERM: the process exists but belongs to someone else.
        return error.code === 'EPERM'
    }
}

/**
 * The current holder, `{ pid, cwd, command, startedAt }`, or null when the
 * lock is free or its holder is dead.
 */
export function readHolder(dir = lockDir()) {
    let holder
    try {
        holder = JSON.parse(readFileSync(join(dir, 'holder.json'), 'utf8'))
    } catch {
        return null
    }
    return isAlive(holder.pid) ? holder : null
}

/** The waiting room: one ticket per run waiting for the lock. */
export function queueDir(dir = lockDir()) {
    return `${dir}.queue`
}

/**
 * The live tickets, oldest first: `{ pid, cwd, command, queuedAt }`. A
 * ticket whose run is gone (killed while waiting) is removed.
 */
export function readQueue(dir = lockDir()) {
    const queue = queueDir(dir)
    let names
    try {
        names = readdirSync(queue)
    } catch {
        return []
    }
    const tickets = []
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
        let ticket
        try {
            ticket = JSON.parse(readFileSync(join(queue, name), 'utf8'))
        } catch {
            continue // being written or removed
        }
        if (isAlive(ticket.pid)) tickets.push(ticket)
        else rmSync(join(queue, name), { force: true })
    }
    return tickets
}

function tryTake(dir, holder) {
    try {
        mkdirSync(dir)
    } catch (error) {
        if (error.code !== 'EEXIST') throw error
        return false
    }
    writeFileSync(join(dir, 'holder.json'), JSON.stringify(holder))
    return true
}

/**
 * Remove a lock whose holder is dead, or that never got a holder file; true
 * when it did.
 */
function clearIfStale(dir) {
    let holder = null
    try {
        holder = JSON.parse(readFileSync(join(dir, 'holder.json'), 'utf8'))
    } catch {
        // mkdir happened but holder.json is not written yet — a live taker
        // writes it within milliseconds; a crashed one never does.
        try {
            if (Date.now() - statSync(dir).mtimeMs < 30_000) return false
        } catch {
            return true // released meanwhile
        }
    }
    if (holder && isAlive(holder.pid)) return false
    rmSync(dir, { recursive: true, force: true })
    return true
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const age = (since) => {
    const seconds = Math.round((Date.now() - since) / 1000)
    return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`
}

/**
 * Wait for the lock, take it, and return `release()`. Returns a no-op when
 * TEST_NO_LOCK=1 or an ancestor process already holds it.
 */
export async function acquireTestLock({
    label = process.argv.slice(1).join(' '),
    pollMs = Number(process.env.TEST_LOCK_POLL_MS) || 5000,
    log = (line) => console.error(line),
} = {}) {
    if (process.env.TEST_NO_LOCK === '1') return () => {}
    const dir = lockDir()
    const inherited = Number(process.env[HOLDER_ENV])
    if (inherited && readHolder(dir)?.pid === inherited) return () => {}

    const me = {
        pid: process.pid,
        cwd: process.cwd(),
        command: label,
        startedAt: Date.now(),
    }
    const waitingSince = Date.now()
    const queue = queueDir(dir)
    mkdirSync(queue, { recursive: true })
    // Zero-padded time first, so a name sort is arrival order.
    const ticket = join(
        queue,
        `${String(waitingSince).padStart(15, '0')}-${process.pid}.json`,
    )
    writeFileSync(
        ticket,
        JSON.stringify({ ...me, queuedAt: waitingSince, startedAt: undefined }),
    )
    const leaveQueue = () => rmSync(ticket, { force: true })
    process.once('exit', leaveQueue)
    const waitUnlocked = process.env.TEST_LOCK_WAIT_UNLOCKED !== '0'
    const ownerGone = watchOwners()
    let lastNotice = 0
    try {
        for (;;) {
            const gone = ownerGone()
            if (gone) {
                log(
                    `[test-lock] the process that started this run (pid ${gone}) is gone; leaving the queue`,
                )
                leaveQueue()
                process.exit(129)
            }
            const tickets = readQueue(dir)
            const position =
                tickets.findIndex((t) => t.pid === process.pid) + 1 ||
                tickets.length + 1
            // A stale outsider (hung or orphaned for TEST_LOCK_STALE_MIN) is
            // listed by `status` for the user, but no longer waited for.
            const unlocked =
                position === 1 && waitUnlocked
                    ? unlockedTestProcesses(readHolder(dir)?.pid, dir).filter(
                          (p) => !p.stale,
                      )
                    : []
            if (position === 1 && !unlocked.length && tryTake(dir, me)) break
            // Only a lock that exists can be stale (and the clear skips the sleep).
            if (existsSync(dir) && clearIfStale(dir)) continue
            if (Date.now() - lastNotice >= 60_000) {
                const holder = readHolder(dir)
                const ahead = holder
                    ? `pid ${holder.pid}, ${holder.cwd}, running ${age(holder.startedAt)}: ${holder.command}`
                    : unlocked.length
                      ? `a test run outside the queue, pid ${unlocked[0].pid}: ${unlocked[0].command.slice(0, 120)}`
                      : 'the run before it is starting'
                log(
                    `[test-lock] another test run holds the machine (${ahead}); #${position} in the queue, waiting ${age(waitingSince)} so far`,
                )
                lastNotice = Date.now()
            }
            await sleep(pollMs)
        }
    } finally {
        leaveQueue()
        process.removeListener('exit', leaveQueue)
    }
    if (lastNotice) log(`[test-lock] acquired after ${age(waitingSince)}`)
    me.startedAt = Date.now()
    writeFileSync(join(dir, 'holder.json'), JSON.stringify(me))
    process.env[HOLDER_ENV] = String(process.pid)

    let released = false
    const release = () => {
        if (released) return
        released = true
        try {
            const holder = JSON.parse(
                readFileSync(join(dir, 'holder.json'), 'utf8'),
            )
            if (holder.pid === process.pid)
                rmSync(dir, { recursive: true, force: true })
        } catch {
            // already gone
        }
    }
    process.once('exit', release)
    // Holding: if the session that started us goes away, stop for it.
    const watch = setInterval(async () => {
        const gone = ownerGone()
        if (!gone) return
        clearInterval(watch)
        log(
            `[test-lock] the process that started this run (pid ${gone}) is gone; stopping the run and releasing the lock`,
        )
        await killDescendants(process.pid)
        release()
        process.exit(129)
    }, pollMs)
    watch.unref()
    for (const [signal, code] of [
        ['SIGINT', 130],
        ['SIGTERM', 143],
        ['SIGHUP', 129],
    ])
        process.once(signal, async () => {
            await killDescendants(process.pid)
            release()
            process.exit(code)
        })
    return release
}

/** The pids above `pid` (its parent first), without init. */
export function ancestorsOf(pid, rows = processTable()) {
    const parent = new Map(rows.map((row) => [row.pid, row.ppid]))
    const out = []
    for (let p = parent.get(pid); p && p > 1; p = parent.get(p)) out.push(p)
    return out
}

/**
 * Remember this process's ancestors now; the returned check gives the first
 * one that has died since (the shell an agent's task ran in), or null.
 */
function watchOwners() {
    const owners = ancestorsOf(process.pid)
    return () => owners.find((pid) => !isAlive(pid)) ?? null
}

/** Every process on the machine: `{ pid, ppid, etime, command }`. */
export function processTable() {
    const ps = spawnSync('ps', ['-Ao', 'pid=,ppid=,etime=,command='], {
        encoding: 'utf8',
    })
    if (ps.status !== 0) return []
    return ps.stdout
        .split('\n')
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
        .filter(Boolean)
        .map(([, pid, ppid, etime, command]) => ({
            pid: Number(pid),
            ppid: Number(ppid),
            etime,
            command,
        }))
}

/** `ps` elapsed time (`[[dd-]hh:]mm:ss`) in seconds. */
export function etimeSeconds(etime) {
    const [days, clock] = etime.includes('-') ? etime.split('-') : [0, etime]
    const parts = clock.split(':').map(Number)
    while (parts.length < 3) parts.unshift(0)
    const [h, m, s] = parts
    return Number(days) * 86_400 + h * 3600 + m * 60 + s
}

/** The pids below `pid`, deepest first. */
export function descendantsOf(pid, rows = processTable()) {
    const children = new Map()
    for (const row of rows) {
        if (!children.has(row.ppid)) children.set(row.ppid, [])
        children.get(row.ppid).push(row.pid)
    }
    const out = []
    const walk = (p) => {
        for (const child of children.get(p) ?? []) {
            walk(child)
            out.push(child)
        }
    }
    walk(pid)
    return out
}

/**
 * SIGTERM every descendant of `pid`, then SIGKILL whatever is still alive
 * after `graceMs`.
 */
export async function killDescendants(pid, graceMs = 2000) {
    const tree = descendantsOf(pid)
    const signal = (sig) => {
        for (const child of tree)
            try {
                process.kill(child, sig)
            } catch {
                // gone already
            }
    }
    signal('SIGTERM')
    const deadline = Date.now() + graceMs
    while (tree.some(isAlive) && Date.now() < deadline) await sleep(100)
    signal('SIGKILL')
}

/**
 * Test processes on this machine that are NOT under the lock: a raw
 * `node --test`, `tsx --test`, `vitest run` or `jest` some session started
 * directly. A run that holds the lock or waits in its queue is not one — nor
 * anything that started it (its npm/pnpm, dotenv and shell wrappers) or that
 * it started.
 */
export function unlockedTestProcesses(
    holderPid = readHolder()?.pid,
    dir = lockDir(),
    rows = processTable(),
) {
    const parent = new Map(rows.map((row) => [row.pid, row.ppid]))
    const lineage = (pid) => {
        const out = []
        for (let p = pid; p > 1; p = parent.get(p) ?? 0) out.push(p)
        return out
    }
    const known = new Set(
        [holderPid, process.pid, ...readQueue(dir).map((t) => t.pid)].filter(
            Boolean,
        ),
    )
    // Every ancestor of a known run (its pnpm, dotenv and shell wrappers).
    const wrappers = new Set([...known].flatMap(lineage))
    const related = (pid) =>
        wrappers.has(pid) || lineage(pid).some((p) => known.has(p))
    // Judge the argv, not the text: a shell whose command line merely
    // mentions `node --test` is not a test run.
    const isTest = (command) => {
        const args = command.split(/\s+/)
        if (!/(^|\/)(node|tsx)(\d+)?$/.test(args[0])) return false
        if (args.includes('--watch')) return false
        // A queue wrapper (this repository's or another's) is not a test
        // run: while it waits it runs nothing, and counting it would let two
        // repositories' queue heads wait on each other forever. The command
        // it starts once it holds its lock is still counted.
        if (args.some((arg) => /(^|\/)test-lock\.mjs$/.test(arg))) return false
        return args.some(
            (arg, i) =>
                arg === '--test' ||
                (/(^|\/)vitest(\.mjs)?$/.test(arg) &&
                    !['watch', 'dev', 'bench'].includes(args[i + 1])) ||
                /(^|\/)jest(\.js)?$/.test(arg),
        )
    }
    // Tests of this module see only their own raw run, not the machine's.
    const only = process.env.TEST_LOCK_UNLOCKED_MATCH
    const top = rows.filter(
        (row) =>
            isTest(row.command) &&
            !related(row.pid) &&
            (!only || row.command.includes(only)),
    )
    // Report each run once: drop processes whose parent is also listed.
    const listed = new Set(top.map((row) => row.pid))
    const staleAfter = (Number(process.env.TEST_LOCK_STALE_MIN) || 45) * 60
    return top
        .filter((row) => !listed.has(row.ppid))
        .map((row) => ({ ...row, stale: etimeSeconds(row.etime) > staleAfter }))
}

#!/usr/bin/env node
/**
 * The machine's test queue (scripts/lib/test-lock.mjs) from the shell.
 *
 *   node scripts/test-lock.mjs status          who holds it, who queues (any
 *                                              session), unlocked test runs
 *   node scripts/test-lock.mjs wait            take a place in the queue and
 *                                              return when it comes up
 *   node scripts/test-lock.mjs run -- <cmd…>   wait, hold the lock, run <cmd>
 *
 * Wrap every test command in `run --` (`npm test`, `npx vitest run`,
 * `node --test <file>`, `pnpm --filter <pkg> test`) unless the command
 * already takes the lock itself through `acquireTestLock()`.
 */
import { spawn } from 'node:child_process'
import {
    acquireTestLock,
    lockDir,
    readHolder,
    readQueue,
    unlockedTestProcesses,
} from './lib/test-lock.mjs'

const [mode = 'status', ...rest] = process.argv.slice(2)

const minutes = (since) => Math.round((Date.now() - since) / 60_000)

function describe() {
    const holder = readHolder()
    const queue = readQueue()
    const others = unlockedTestProcesses(holder?.pid)
    if (holder)
        console.log(
            `busy — pid ${holder.pid} in ${holder.cwd}, ${minutes(holder.startedAt)} min: ${holder.command}`,
        )
    else console.log('free — no test run holds the lock')
    for (const [i, t] of queue.entries())
        console.log(
            `queued #${i + 1} — pid ${t.pid} in ${t.cwd}, waiting ${minutes(t.queuedAt)} min: ${t.command}`,
        )
    for (const p of others)
        console.log(
            `${p.stale ? 'stale unlocked test process (not waited for — tell the user)' : 'unlocked test process'} — pid ${p.pid}, up ${p.etime}: ${p.command.slice(0, 160)}`,
        )
    return { holder, queue, others }
}

if (mode === 'status') {
    describe()
    console.log(`lock: ${lockDir()}`)
} else if (mode === 'wait') {
    // Wait for our turn IN the queue, then hand it straight on. Waiting for
    // "nothing queued at all" from outside the queue never returned while
    // other sessions kept queuing.
    const holder = readHolder()
    if (holder || readQueue().length) {
        describe()
        console.log('waiting for a turn in the queue…')
    }
    const release = await acquireTestLock({ label: 'wait (no run)' })
    release()
    console.log('free — your turn came; start your run now')
} else if (mode === 'run') {
    const command = rest[0] === '--' ? rest.slice(1) : rest
    if (!command.length) {
        console.error('usage: node scripts/test-lock.mjs run -- <command…>')
        process.exit(2)
    }
    const release = await acquireTestLock({ label: command.join(' ') })
    // Async, so the lock's signal handlers run while the command does: a
    // killed wrapper takes the command's tree down before it releases.
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
    const code = await new Promise((done) => {
        child.on('error', (error) => {
            console.error(error.message)
            done(1)
        })
        child.on('exit', (status, signal) => done(status ?? (signal ? 128 : 1)))
    })
    release()
    process.exit(code)
} else {
    console.error(
        'usage: node scripts/test-lock.mjs status | wait | run -- <command…>',
    )
    process.exit(2)
}

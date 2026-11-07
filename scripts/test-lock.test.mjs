import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { etimeSeconds, unlockedTestProcesses } from './lib/test-lock.mjs'

const cli = join(dirname(fileURLToPath(import.meta.url)), 'test-lock.mjs')

function lockEnv(t) {
    const root = mkdtempSync(join(tmpdir(), 'test-lock-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const dir = join(root, 'agent-test-run.lock')
    const env = {
        ...process.env,
        TEST_LOCK_DIR: dir,
        TEST_LOCK_POLL_MS: '100',
        // Other sessions' raw test runs on this machine must not stall these.
        TEST_LOCK_WAIT_UNLOCKED: '0',
    }
    delete env.TEST_LOCK_HOLDER_PID
    delete env.TEST_NO_LOCK
    return { dir, env }
}

const status = (env) =>
    spawnSync(process.execPath, [cli, 'status'], { env, encoding: 'utf8' })
        .stdout

test('run holds the lock for the command and releases it after', (t) => {
    const { dir, env } = lockEnv(t)
    const inside = spawnSync(
        process.execPath,
        [cli, 'run', '--', process.execPath, cli, 'status'],
        { env, encoding: 'utf8' },
    )
    assert.equal(inside.status, 0)
    assert.match(inside.stdout, /^busy — pid \d+/m)
    assert.equal(existsSync(dir), false)
    assert.match(status(env), /^free/m)
})

test('run passes the command exit status through', (t) => {
    const { env } = lockEnv(t)
    const result = spawnSync(
        process.execPath,
        [cli, 'run', '--', process.execPath, '-e', 'process.exit(7)'],
        { env },
    )
    assert.equal(result.status, 7)
})

test('a second run waits until the first releases', async (t) => {
    const { env } = lockEnv(t)
    const order = []
    const start = (name, ms) =>
        new Promise((done) => {
            const child = spawn(
                process.execPath,
                [
                    cli,
                    'run',
                    '--',
                    process.execPath,
                    '-e',
                    `console.log('start ${name}');setTimeout(()=>console.log('end ${name}'),${ms})`,
                ],
                { env },
            )
            child.stdout.on('data', (chunk) =>
                order.push(...String(chunk).trim().split('\n')),
            )
            child.on('exit', done)
        })
    const first = start('a', 1500)
    await new Promise((done) => setTimeout(done, 400))
    await Promise.all([first, start('b', 10)])
    assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b'])
})

function startRun(env, name, ms, order) {
    return new Promise((done) => {
        const child = spawn(
            process.execPath,
            [
                cli,
                'run',
                '--',
                process.execPath,
                '-e',
                `console.log('start ${name}');setTimeout(()=>console.log('end ${name}'),${ms})`,
            ],
            { env },
        )
        child.stdout.on('data', (chunk) =>
            order.push(...String(chunk).trim().split('\n')),
        )
        child.on('exit', done)
    })
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms))

test('waiting runs from any session go first come, first served', async (t) => {
    const { env } = lockEnv(t)
    const order = []
    const runs = [startRun(env, 'a', 1500, order)]
    await pause(300)
    runs.push(startRun(env, 'b', 10, order))
    await pause(300)
    runs.push(startRun({ ...env, PWD: '/another/worktree' }, 'c', 10, order))
    await Promise.all(runs)
    assert.deepEqual(order, [
        'start a',
        'end a',
        'start b',
        'end b',
        'start c',
        'end c',
    ])
})

test('status lists the queue in order, not as unlocked runs', async (t) => {
    const { env } = lockEnv(t)
    const order = []
    const runs = [startRun(env, 'a', 1500, order)]
    await pause(300)
    runs.push(startRun(env, 'b', 10, order))
    await pause(400)
    const shown = status(env)
    await Promise.all(runs)
    assert.match(shown, /^busy — pid \d+/m)
    assert.match(
        shown,
        /^queued #1 — pid \d+ in .*: .*console\.log\('start b'\)/m,
    )
    assert.doesNotMatch(shown, /unlocked test process/)
    const queue = `${env.TEST_LOCK_DIR}.queue`
    assert.deepEqual(existsSync(queue) ? readdirSync(queue) : [], [])
})

test('the head of the queue waits for a test run started without the lock', async (t) => {
    const { env } = lockEnv(t)
    const root = dirname(env.TEST_LOCK_DIR)
    const file = join(root, 'raw.test.mjs')
    writeFileSync(
        file,
        "import { test } from 'node:test'\ntest('raw', () => new Promise((r) => setTimeout(r, 1200)))\n",
    )
    // A raw run of its own: without the outer runner's NODE_TEST_CONTEXT,
    // which would make it report into this file and exit at once.
    const rawEnv = { ...process.env }
    delete rawEnv.NODE_TEST_CONTEXT
    let rawEnded = 0
    const raw = new Promise((done) => {
        const child = spawn(process.execPath, ['--test', file], {
            env: rawEnv,
        })
        child.on('exit', () => {
            rawEnded = Date.now()
            done()
        })
    })
    await pause(400)
    assert.equal(rawEnded, 0, 'the raw run is still going')
    let started = 0
    const code = await new Promise((done) => {
        const child = spawn(
            process.execPath,
            [
                cli,
                'run',
                '--',
                process.execPath,
                '-e',
                'console.log(Date.now())',
            ],
            {
                env: {
                    ...env,
                    TEST_LOCK_WAIT_UNLOCKED: '1',
                    // Only this test's raw run — not every suite other
                    // sessions run on the machine (that hung this ~10 min).
                    TEST_LOCK_UNLOCKED_MATCH: file,
                },
            },
        )
        child.stdout.on('data', (chunk) => {
            started = Number(String(chunk).trim())
        })
        child.on('exit', done)
    })
    await raw
    assert.equal(code, 0)
    assert.ok(
        rawEnded > 0 && started >= rawEnded - 50,
        `the locked run started (${started}) after the raw run ended (${rawEnded})`,
    )
})

test('a dead holder is taken over', (t) => {
    const { dir, env } = lockEnv(t)
    mkdirSync(dir)
    const dead = spawnSync(
        process.execPath,
        ['-e', 'console.log(process.pid)'],
        {
            encoding: 'utf8',
        },
    )
    writeFileSync(
        join(dir, 'holder.json'),
        JSON.stringify({
            pid: Number(dead.stdout.trim()),
            cwd: '/gone',
            command: 'x',
            startedAt: 0,
        }),
    )
    assert.match(status(env), /^free/m)
    const result = spawnSync(
        process.execPath,
        [cli, 'run', '--', process.execPath, '-e', ''],
        { env, timeout: 15_000 },
    )
    assert.equal(result.status, 0)
})

test('a run started under the lock does not wait for itself', (t) => {
    const { env } = lockEnv(t)
    const nested = spawnSync(
        process.execPath,
        [
            cli,
            'run',
            '--',
            process.execPath,
            cli,
            'run',
            '--',
            process.execPath,
            '-e',
            '',
        ],
        { env, timeout: 15_000 },
    )
    assert.equal(nested.status, 0)
})

test('a killed run takes its command tree down before it releases the lock', async (t) => {
    const { dir, env } = lockEnv(t)
    // The command starts a grandchild (a job pool's `tsx --test`) and waits.
    const script =
        "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"
    const wrapper = spawn(
        process.execPath,
        [cli, 'run', '--', process.execPath, '-e', script],
        { env },
    )
    const grandchild = await new Promise((done) =>
        wrapper.stdout.on('data', (chunk) =>
            done(Number(String(chunk).trim())),
        ),
    )
    assert.ok(existsSync(dir), 'the run holds the lock')
    const exited = new Promise((done) => wrapper.on('exit', done))
    wrapper.kill('SIGTERM')
    await exited
    const alive = (() => {
        try {
            process.kill(grandchild, 0)
            return true
        } catch {
            return false
        }
    })()
    assert.equal(alive, false, 'the grandchild is gone')
    assert.equal(existsSync(dir), false, 'the lock is released')
})

test('etimeSeconds reads ps elapsed times', () => {
    assert.equal(etimeSeconds('00:05'), 5)
    assert.equal(etimeSeconds('12:34'), 754)
    assert.equal(etimeSeconds('01:00:00'), 3600)
    assert.equal(etimeSeconds('2-00:00:01'), 172_801)
})

test('an outside test run older than TEST_LOCK_STALE_MIN is stale', (t) => {
    const { dir } = lockEnv(t)
    const rows = [
        {
            pid: 900001,
            ppid: 1,
            etime: '01:10:00',
            command: 'node --test hung.test.mjs',
        },
        {
            pid: 900002,
            ppid: 1,
            etime: '03:00',
            command: 'node --test fresh.test.mjs',
        },
    ]
    const found = unlockedTestProcesses(undefined, dir, rows)
    assert.deepEqual(
        found.map((p) => [p.pid, p.stale]),
        [
            [900001, true],
            [900002, false],
        ],
    )
})

test('a queue wrapper, of any repository, is not an unlocked test run', (t) => {
    const { dir } = lockEnv(t)
    const rows = [
        {
            pid: 910001,
            ppid: 1,
            etime: '02:00',
            command:
                'node /other/repo/scripts/test-lock.mjs run -- node --test a.test.mjs',
        },
        {
            pid: 910002,
            ppid: 910001,
            etime: '01:00',
            command: 'node --test a.test.mjs',
        },
    ]
    assert.deepEqual(
        unlockedTestProcesses(undefined, dir, rows).map((p) => p.pid),
        [910002],
    )
})

const holdFor = (env, ms) =>
    spawn(
        process.execPath,
        [
            cli,
            'run',
            '--',
            process.execPath,
            '-e',
            `setTimeout(() => {}, ${ms})`,
        ],
        { env },
    )

const until = async (check, ms = 10_000) => {
    const deadline = Date.now() + ms
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out')
        await pause(100)
    }
}

test('a waiting run whose shell is gone leaves the queue', async (t) => {
    const { dir, env } = lockEnv(t)
    const holder = holdFor(env, 5000)
    t.after(() => holder.kill())
    await until(() => existsSync(dir))
    // `; :` keeps sh alive as the waiter's parent (no exec of the last command).
    const shell = spawn(
        'sh',
        [
            '-c',
            `"${process.execPath}" "${cli}" run -- "${process.execPath}" -e "" ; :`,
        ],
        { env },
    )
    await until(() => /queued #1/.test(status(env)))
    shell.kill('SIGKILL') // what stopping an agent's background task does
    await until(() => !/queued #1/.test(status(env)))
    assert.ok(existsSync(dir), 'the holder still holds the lock')
})

test('a holding run whose shell is gone stops its tree and releases the lock', async (t) => {
    const { dir, env } = lockEnv(t)
    const script =
        "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"
    const shell = spawn(
        'sh',
        [
            '-c',
            `"${process.execPath}" "${cli}" run -- "${process.execPath}" -e "${script.replace(/"/g, '\\"')}" ; :`,
        ],
        { env },
    )
    const grandchild = await new Promise((done) =>
        shell.stdout.on('data', (chunk) => done(Number(String(chunk).trim()))),
    )
    assert.ok(existsSync(dir))
    shell.kill('SIGKILL')
    await until(() => !existsSync(dir))
    await until(() => {
        try {
            process.kill(grandchild, 0)
            return false
        } catch {
            return true
        }
    })
})

test('wait takes a place in the queue and returns when it comes up', async (t) => {
    const { dir, env } = lockEnv(t)
    const holder = holdFor(env, 1500)
    await until(() => existsSync(dir))
    let returned = 0
    const waiter = new Promise((done) => {
        const child = spawn(process.execPath, [cli, 'wait'], { env })
        child.on('exit', (code) => {
            returned = Date.now()
            done(code)
        })
    })
    await until(() => /queued #1 — .*wait \(no run\)/.test(status(env)))
    assert.equal(returned, 0, 'still waiting while the holder runs')
    const holderEnded = await new Promise((done) =>
        holder.on('exit', () => done(Date.now())),
    )
    assert.equal(await waiter, 0)
    assert.ok(returned >= holderEnded - 200)
    assert.equal(existsSync(dir), false, 'wait hands its turn straight on')
})

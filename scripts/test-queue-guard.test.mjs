import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
    classify,
    classifyAll,
    decide,
    readContext,
    relevant,
} from '../.claude/hooks/test-queue-guard.mjs'

const ROOT = '/repo'
const hook = join(
    dirname(fileURLToPath(import.meta.url)),
    '../.claude/hooks/test-queue-guard.mjs',
)

const wired = {
    queuedScripts: new Set(['test', 'test:all']),
    pushQueued: true,
    selfQueuing: ['scripts/run-tests.mjs'],
}

const state = (over = {}) => ({
    root: ROOT,
    lockCli: '/repo/scripts/test-lock.mjs',
    summary: 'Queue now: free',
    mine: null,
    protectedPids: new Set(),
    ctx: wired,
    ...over,
})

const call = (command, { background = false, cwd = ROOT, s = state() } = {}) =>
    decide({ cwd, tool_input: { command, run_in_background: background } }, s)

test('the wrapper, wrapped root scripts, self-queuing runners and a wired push queue', () => {
    for (const command of [
        'node scripts/test-lock.mjs run -- npx vitest run a.test.ts',
        'node scripts/test-lock.mjs wait',
        'npm test',
        'npm t',
        'pnpm test:all',
        'pnpm run test',
        'yarn test',
        'npx dotenv -- node scripts/run-tests.mjs --filter x',
        'git push -u origin HEAD',
        'git -C ../x push',
    ])
        assert.equal(classify(command, { ctx: wired }), 'queued', command)
})

test('without wiring, a root test script is raw and git push is not a test', () => {
    assert.equal(classify('npm test'), 'raw')
    assert.equal(classify('pnpm test'), 'raw')
    assert.equal(classify('git push'), null)
})

test('raw runners are raw', () => {
    for (const command of [
        'npx tsx --test src/tests/foo.test.ts',
        'tsx --test --test-concurrency=1 src/tests/*.test.ts',
        'node --test scripts/test-lock.test.mjs',
        'node_modules/.bin/vitest run src/foo.test.tsx',
        'npx vitest',
        'npx jest src/a.test.js',
        'bun test',
        'pnpm --filter @scope/pkg test',
        'pnpm -F app run test',
        'pnpm --filter=app exec vitest run src/a.test.tsx',
        'npm test --workspace=app',
        'npm -w app test',
        'yarn workspace app test',
        'npx dotenv -- pnpm --filter pkg test',
        'pnpm exec dotenv -e .env -- pnpm -r test',
        'DATABASE_URL=x npx tsx --test a.test.ts',
    ])
        assert.equal(classify(command, { ctx: wired }), 'raw', command)
})

test('everything else is not a test run', () => {
    for (const command of [
        'node scripts/test-lock.mjs status',
        'git push --no-verify origin main',
        'git commit -m "fix: npm test flake"',
        'vitest --watch',
        'npx jest --watch',
        'pnpm lint',
        'npm run build',
        'grep -rn "tsx --test" scripts',
    ])
        assert.equal(classify(command, { ctx: wired }), null, command)
})

test('a bare npm test inside a package is that package’s raw runner', () => {
    const kinds = classifyAll('cd packages/app && npm test', {
        cwd: ROOT,
        root: ROOT,
        ctx: wired,
    })
    assert.equal(kinds[1][1], 'raw')
    assert.equal(
        classifyAll('npm test', {
            cwd: '/repo/packages/app',
            root: ROOT,
            ctx: wired,
        })[0][1],
        'raw',
    )
    assert.equal(
        classifyAll('cd /repo && npm test', {
            cwd: '/elsewhere',
            root: ROOT,
            ctx: wired,
        })[1][1],
        'queued',
    )
})

test('heredoc bodies are text, not commands', () => {
    assert.equal(relevant("cat > notes.md <<'EOF'\nnpm test\nEOF"), false)
    assert.equal(relevant('ls -la'), false)
    assert.equal(relevant('git push'), true)
})

test('a test command in the foreground is refused', () => {
    const reason = call('npm test')
    assert.match(reason, /run_in_background: true/)
    assert.match(reason, /Queue now: free/)
})

test('a queued command in the background runs', () => {
    assert.equal(call('npm test', { background: true }), null)
    assert.equal(call('git push -u origin HEAD', { background: true }), null)
    assert.equal(
        call('node scripts/test-lock.mjs run -- npx tsx --test a.test.ts', {
            background: true,
        }),
        null,
    )
})

test('a raw runner is refused with the wrapped command to run instead', () => {
    const reason = call(
        'export NVM_DIR=x; cd /repo && DATABASE_URL=y npx tsx --test a.test.ts',
        { background: true },
    )
    assert.match(
        reason,
        /cd \/repo && DATABASE_URL=y node \/repo\/scripts\/test-lock\.mjs run -- npx tsx --test a\.test\.ts/,
    )
    assert.match(reason, /run_in_background: true/)
})

test('an unwrapped root test script is refused with the wrapper', () => {
    const reason = call('npm test', {
        background: true,
        s: state({ ctx: { ...wired, queuedScripts: new Set() } }),
    })
    assert.match(reason, /node \/repo\/scripts\/test-lock\.mjs run -- npm test/)
})

test('a second run from a checkout that already has one is refused', () => {
    const reason = call('npm test', {
        background: true,
        s: state({ mine: 'waiting in the queue (pid 42: npm test)' }),
    })
    assert.match(reason, /already has a test run waiting in the queue/)
})

test('the queue escapes are refused on a test command', () => {
    const s = state({
        escapes: ['TEST_NO_LOCK=1', 'TEST_LOCK_WAIT_UNLOCKED=0', 'MY_PG_PORT='],
    })
    for (const command of [
        'TEST_NO_LOCK=1 npm test',
        'TEST_LOCK_WAIT_UNLOCKED=0 npm test',
        'MY_PG_PORT=54400 npm test',
    ])
        assert.match(
            call(command, { background: true, s }),
            /user's/,
            command,
        )
    assert.equal(call('MY_PG_PORT=1 echo hi', { s }), null)
})

test('killing a test run or a protected process is refused', () => {
    const s = state({ protectedPids: new Set([4242]), protect: ['my-test-pg'] })
    assert.match(call('kill 4242', { s }), /Never kill test processes/)
    assert.match(call('pkill -f vitest', { s }), /Never kill test processes/)
    assert.match(call('pkill -f my-test-pg', { s }), /Never kill/)
    assert.equal(call('kill 999', { s }), null)
    assert.equal(call('pkill -f "vite dev"', { s }), null)
})

test('readContext reads wrapped scripts, the pre-push hook and the config', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'test-queue-ctx-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    spawnSync('git', ['init', '-q'], { cwd: root, env: cleanGitEnv() })
    writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
            scripts: {
                test: 'node scripts/test-lock.mjs run -- node --test',
                'test:unit': 'vitest run',
                lint: 'test-lock',
            },
        }),
    )
    const own = mkdtempSync(join(tmpdir(), 'test-queue-own-'))
    t.after(() => rmSync(own, { recursive: true, force: true }))
    spawnSync('mkdir', ['-p', join(own, '.claude')])
    writeFileSync(
        join(own, '.claude/test-queue.json'),
        JSON.stringify({ escapes: ['X=1'], protect: ['pg'], selfQueuing: ['r.mjs'] }),
    )
    let wiring = readContext(root, own)
    assert.deepEqual([...wiring.ctx.queuedScripts], ['test'])
    assert.equal(wiring.ctx.pushQueued, false)
    assert.deepEqual(wiring.ctx.selfQueuing, ['r.mjs'])
    assert.ok(wiring.escapes.includes('X=1'))
    assert.deepEqual(wiring.protect, ['pg'])
    writeFileSync(
        join(root, '.git/hooks/pre-push'),
        '#!/bin/sh\nnode scripts/test-lock.mjs run -- npm test\n',
    )
    wiring = readContext(root, own)
    assert.equal(wiring.ctx.pushQueued, true)
})

/** git under a hook inherits GIT_DIR & co.; tests must not touch that repo. */
function cleanGitEnv() {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    return env
}

test('the hook prints a deny decision and stays silent otherwise', () => {
    const run = (command, background) =>
        spawnSync(process.execPath, [hook], {
            input: JSON.stringify({
                tool_name: 'Bash',
                cwd: process.cwd(),
                tool_input: { command, run_in_background: background },
            }),
            encoding: 'utf8',
            env: {
                ...process.env,
                TEST_LOCK_DIR: join(tmpdir(), 'test-queue-guard-no-lock'),
            },
        })
    const denied = run('npx vitest run', true)
    assert.equal(denied.status, 0)
    const out = JSON.parse(denied.stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /test-lock\.mjs run --/)
    const quiet = run('ls -la', false)
    assert.equal(quiet.status, 0)
    assert.equal(quiet.stdout, '')
    const broken = spawnSync(process.execPath, [hook], {
        input: 'not json',
        encoding: 'utf8',
    })
    assert.equal(broken.status, 0)
    assert.equal(broken.stdout, '')
})

test('a leading cd moves the directory the command is judged in', async () => {
    const { effectiveCwd } = await import('../.claude/hooks/test-queue-guard.mjs')
    assert.equal(effectiveCwd('cd /x/y && npm test', '/repo'), '/x/y')
    assert.equal(effectiveCwd('cd ../b && npm test', '/repo/a'), '/repo/b')
    assert.equal(
        effectiveCwd('cd ~/code && npm test', '/repo'),
        join(process.env.HOME, 'code'),
    )
    assert.equal(effectiveCwd('npm test', '/repo'), '/repo')
})

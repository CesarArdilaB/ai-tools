import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = join(dirname(fileURLToPath(import.meta.url)), '../bin/ai-tools.mjs')

/** git under a hook inherits GIT_DIR & co.; never let it touch this repo. */
function cleanEnv() {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    return env
}

function repo(t) {
    const dir = mkdtempSync(join(tmpdir(), 'ai-tools-target-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, env: cleanEnv() }).status, 0)
    return dir
}

const run = (cwd, ...args) =>
    spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: cleanEnv() })

const json = (path) => JSON.parse(readFileSync(path, 'utf8'))

const guardEntries = (dir) =>
    (json(join(dir, '.claude/settings.json')).hooks?.PreToolUse ?? []).filter((e) =>
        e.hooks.some((h) => h.command.includes('test-queue-guard.mjs')),
    )

test('list names every tool', (t) => {
    const out = run(repo(t), 'list')
    assert.equal(out.status, 0)
    assert.match(out.stdout, /^test-queue /m)
    assert.match(out.stdout, /^skill-sync /m)
})

test('install test-queue copies the files and merges the guard hook, once', (t) => {
    const dir = repo(t)
    mkdirSync(join(dir, '.claude'))
    writeFileSync(
        join(dir, '.claude/settings.json'),
        JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo mine' }] }] } }),
    )
    const first = run(dir, 'install', 'test-queue')
    assert.equal(first.status, 0, first.stderr)
    for (const file of [
        'scripts/test-lock.mjs',
        'scripts/lib/test-lock.mjs',
        '.claude/hooks/test-queue-guard.mjs',
        '.claude/skills/wait-for-tests/SKILL.md',
    ])
        assert.ok(existsSync(join(dir, file)), file)
    const settings = json(join(dir, '.claude/settings.json'))
    assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] }, 'other settings kept')
    assert.equal(settings.hooks.PreToolUse.length, 2, 'existing hook kept')
    assert.equal(guardEntries(dir).length, 1)

    const again = run(dir, 'install', 'test-queue')
    assert.equal(again.status, 0)
    assert.doesNotMatch(again.stdout, /^(add|update|replace)/m)
    assert.equal(guardEntries(dir).length, 1, 'no duplicate hook')

    const status = spawnSync(process.execPath, ['scripts/test-lock.mjs', 'status'], {
        cwd: dir,
        encoding: 'utf8',
        env: cleanEnv(),
    })
    assert.equal(status.status, 0, status.stderr)
    assert.match(status.stdout, /^free/m)
    assert.match(status.stdout, /agent-test-run\.lock/)
})

test('a file the target changed is kept unless --force', (t) => {
    const dir = repo(t)
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts/test-lock.mjs'), '// mine\n')
    const out = run(dir, 'install', 'test-queue')
    assert.match(out.stdout, /^keep +scripts\/test-lock\.mjs/m)
    assert.equal(readFileSync(join(dir, 'scripts/test-lock.mjs'), 'utf8'), '// mine\n')
    run(dir, 'install', 'test-queue', '--force')
    assert.notEqual(readFileSync(join(dir, 'scripts/test-lock.mjs'), 'utf8'), '// mine\n')
})

test('--dry-run writes nothing', (t) => {
    const dir = repo(t)
    const out = run(dir, 'install', 'all', '--dry-run')
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /^add +scripts\/test-lock\.mjs/m)
    assert.equal(existsSync(join(dir, 'scripts')), false)
    assert.equal(existsSync(join(dir, '.claude')), false)
})

test('--target installs into another repository from anywhere inside it', (t) => {
    const dir = repo(t)
    mkdirSync(join(dir, 'packages/app'), { recursive: true })
    const out = run(tmpdir(), 'install', 'test-queue', '--target', join(dir, 'packages/app'))
    assert.equal(out.status, 0, out.stderr)
    assert.ok(existsSync(join(dir, 'scripts/test-lock.mjs')), 'installed at the repo root')
})

test('outside a git repository it refuses', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-tools-nogit-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const out = run(dir, 'install', 'test-queue')
    assert.equal(out.status, 2)
    assert.match(out.stderr, /not inside a git repository/)
})

test('install skill-sync wires both agents and links the Codex skills', (t) => {
    const dir = repo(t)
    const out = run(dir, 'install', 'test-queue', 'skill-sync')
    assert.equal(out.status, 0, out.stderr)
    assert.match(readFileSync(join(dir, 'SKILLS.md'), 'utf8'), /\| wait-for-tests \|/)
    assert.ok(lstatSync(join(dir, '.agents/skills/wait-for-tests')).isSymbolicLink())
    assert.ok(existsSync(join(dir, '.agents/skills/wait-for-tests/SKILL.md')))
    const codex = json(join(dir, '.codex/hooks.json'))
    assert.match(codex.hooks.PostToolUse[0].matcher, /apply_patch/)
    const check = spawnSync(process.execPath, ['scripts/sync-agent-skills.mjs', '--check'], {
        cwd: dir,
        encoding: 'utf8',
    })
    assert.equal(check.status, 0, check.stderr + check.stdout)
})

test('uninstall removes what it shipped and keeps the rest', (t) => {
    const dir = repo(t)
    mkdirSync(join(dir, 'scripts/lib'), { recursive: true })
    writeFileSync(join(dir, 'scripts/lib/other.mjs'), '')
    run(dir, 'install', 'test-queue')
    const out = run(dir, 'uninstall', 'test-queue')
    assert.equal(out.status, 0, out.stderr)
    assert.equal(existsSync(join(dir, 'scripts/test-lock.mjs')), false)
    assert.equal(existsSync(join(dir, '.claude/hooks')), false, 'empty dir removed')
    assert.ok(existsSync(join(dir, 'scripts/lib/other.mjs')), 'other files kept')
    assert.equal(guardEntries(dir).length, 0)
})

test('a symlinked folder in the target is refused, and nothing is written through it', (t) => {
    const dir = repo(t)
    const outside = mkdtempSync(join(tmpdir(), 'ai-tools-outside-'))
    t.after(() => rmSync(outside, { recursive: true, force: true }))
    symlinkSync(outside, join(dir, 'scripts'))
    const out = run(dir, 'install', 'test-queue')
    assert.equal(out.status, 1)
    assert.match(out.stderr, /scripts is a symlink/)
    assert.equal(existsSync(join(outside, 'test-lock.mjs')), false)
})

test('a symlinked file is not removed through on uninstall', (t) => {
    const dir = repo(t)
    run(dir, 'install', 'test-queue')
    const outside = mkdtempSync(join(tmpdir(), 'ai-tools-outside-'))
    t.after(() => rmSync(outside, { recursive: true, force: true }))
    writeFileSync(join(outside, 'victim'), 'keep me')
    rmSync(join(dir, 'scripts/test-lock.mjs'))
    symlinkSync(join(outside, 'victim'), join(dir, 'scripts/test-lock.mjs'))
    const out = run(dir, 'uninstall', 'test-queue', '--force')
    assert.equal(out.status, 1)
    assert.equal(readFileSync(join(outside, 'victim'), 'utf8'), 'keep me')
    assert.equal(guardEntries(dir).length, 1, 'nothing half-uninstalled')
})

test('skill-sync setup never runs a sync script the target changed', (t) => {
    const dir = repo(t)
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(
        join(dir, 'scripts/sync-agent-skills.mjs'),
        "require('fs').writeFileSync('pwned', '')\n",
    )
    const out = run(dir, 'install', 'skill-sync')
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /^skip +scripts\/sync-agent-skills\.mjs differs/m)
    assert.equal(existsSync(join(dir, 'pwned')), false)
})

test('a symlinked .agents folder is refused before any link is made through it', (t) => {
    const dir = repo(t)
    const outside = mkdtempSync(join(tmpdir(), 'ai-tools-outside-'))
    t.after(() => rmSync(outside, { recursive: true, force: true }))
    mkdirSync(join(outside, 'skills'))
    symlinkSync(outside, join(dir, '.agents'))
    const out = run(dir, 'install', 'test-queue', 'skill-sync')
    assert.equal(out.status, 1)
    assert.match(out.stderr, /\.agents is a symlink/)
    assert.deepEqual(readdirSync(join(outside, 'skills')), [])
    assert.equal(existsSync(join(dir, 'scripts')), false, 'nothing installed')
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = join(
    dirname(fileURLToPath(import.meta.url)),
    'sync-agent-skills.mjs',
)
const initial =
    '# Catalog\n\nKeep this prose.\n<!-- shared-skills:start -->\n<!-- shared-skills:end -->\nKeep this footer.\n'

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'ai-tools-hook-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, '.claude/skills'), { recursive: true })
    mkdirSync(join(root, 'nested directory'))
    copyFileSync(script, join(root, 'scripts/sync-agent-skills.mjs'))
    writeFileSync(join(root, 'SKILLS.md'), initial)
    const skill = (name) => {
        const dir = join(root, '.claude/skills', name)
        mkdirSync(dir, { recursive: true })
        writeFileSync(
            join(dir, 'SKILL.md'),
            `---\nname: ${name}\ndescription: Fixture skill\n---\n`,
        )
    }
    const run = (...args) =>
        spawnSync(
            process.execPath,
            [join(root, 'scripts/sync-agent-skills.mjs'), ...args],
            {
                cwd: join(root, 'nested directory'),
                encoding: 'utf8',
                input: JSON.stringify({
                    hook_event_name: 'PostToolUse',
                    tool_name: 'Write',
                    cwd: root,
                }),
            },
        )
    return { root, skill, run }
}

test('registers new skills for both agents, preserves prose, and is idempotent', (t) => {
    const { root, skill, run } = fixture(t)
    skill('zeta')
    mkdirSync(join(root, '.claude/skills/unfinished'))
    const before = run('--check')
    assert.equal(before.status, 1)
    assert.equal(readFileSync(join(root, 'SKILLS.md'), 'utf8'), initial)
    assert.equal(existsSync(join(root, '.agents/skills')), false)

    const result = run('--hook')
    assert.equal(result.status, 0, result.stderr)
    assert(JSON.parse(result.stdout).systemMessage)
    assert.equal(
        readlinkSync(join(root, '.agents/skills/zeta')),
        '../../.claude/skills/zeta',
    )
    assert.equal(existsSync(join(root, '.agents/skills/unfinished')), false)
    skill('alpha')
    assert.equal(run('--hook').status, 0)
    const catalogPath = join(root, 'SKILLS.md')
    const catalog = readFileSync(catalogPath, 'utf8')
    assert(catalog.startsWith('# Catalog\n\nKeep this prose.\n'))
    assert(catalog.endsWith('Keep this footer.\n'))
    assert(catalog.indexOf('| alpha |') < catalog.indexOf('| zeta |'))
    assert(catalog.includes('.agents/skills/alpha/SKILL.md'))
    assert(catalog.includes('.claude/skills/alpha/SKILL.md'))
    const mtime = statSync(catalogPath).mtimeMs
    assert.deepEqual(JSON.parse(run('--hook').stdout), {})
    assert.equal(statSync(catalogPath).mtimeMs, mtime)
    assert.equal(run('--check').status, 0)
})

test('preserves conflicting agent-specific folders', (t) => {
    const { root, skill, run } = fixture(t)
    skill('example')
    const local = join(root, '.agents/skills/example')
    mkdirSync(local, { recursive: true })
    writeFileSync(join(local, 'SKILL.md'), 'User content')
    const result = run('--hook')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Refusing to replace existing entry/)
    assert.equal(readFileSync(join(local, 'SKILL.md'), 'utf8'), 'User content')
    assert.equal(readFileSync(join(root, 'SKILLS.md'), 'utf8'), initial)
})

test('reports dangling links without deleting them', (t) => {
    const { root, run } = fixture(t)
    mkdirSync(join(root, '.agents/skills'), { recursive: true })
    symlinkSync(
        '../../.claude/skills/removed',
        join(root, '.agents/skills/removed'),
    )
    const result = run('--check')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Broken skill link/)
    assert.equal(
        readlinkSync(join(root, '.agents/skills/removed')),
        '../../.claude/skills/removed',
    )
})

test('missing catalog markers fail before any links or prose are changed', (t) => {
    const { root, skill, run } = fixture(t)
    skill('example')
    writeFileSync(join(root, 'SKILLS.md'), 'Handwritten catalog')
    assert.equal(run('--hook').status, 1)
    assert.equal(
        readFileSync(join(root, 'SKILLS.md'), 'utf8'),
        'Handwritten catalog',
    )
    assert.equal(existsSync(join(root, '.agents/skills')), false)
})

test('both agent configurations register the same updater for edits and turn completion', () => {
    const root = dirname(dirname(script))
    const configs = ['.claude/settings.json', '.codex/hooks.json'].map((file) =>
        JSON.parse(readFileSync(join(root, file), 'utf8')),
    )
    const commands = []
    for (const config of configs) {
        for (const event of ['PostToolUse', 'Stop']) {
            const matches = config.hooks[event]
                .flatMap((group) => group.hooks)
                .filter((hook) =>
                    hook.command.includes('sync-agent-skills.mjs'),
                )
            assert.equal(matches.length, 1)
            assert.equal(matches[0].type, 'command')
            commands.push(matches[0].command)
        }
    }
    assert.equal(new Set(commands).size, 1)
})

test('refuses to write through a symlinked .agents folder or catalog', (t) => {
    for (const planted of ['.agents', 'SKILLS.md']) {
        const { root, skill, run } = fixture(t)
        skill('alpha')
        const outside = mkdtempSync(join(tmpdir(), 'ai-tools-outside-'))
        t.after(() => rmSync(outside, { recursive: true, force: true }))
        const victim = join(outside, planted === 'SKILLS.md' ? 'catalog.md' : 'agents')
        if (planted === 'SKILLS.md') {
            writeFileSync(victim, initial)
            rmSync(join(root, 'SKILLS.md'))
        } else mkdirSync(join(victim, 'skills'), { recursive: true })
        symlinkSync(victim, join(root, planted))
        const result = run()
        assert.notEqual(result.status, 0, planted)
        assert.match(result.stderr + result.stdout, /is a symlink/, planted)
        if (planted === 'SKILLS.md')
            assert.equal(readFileSync(victim, 'utf8'), initial)
        else assert.equal(existsSync(join(victim, 'skills/alpha')), false)
    }
})

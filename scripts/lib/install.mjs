/**
 * Install ai-tools' tools into another repository.
 *
 * Each tool is a set of files copied to the SAME relative paths they have in
 * this repository, hook entries merged into the target's agent settings, and
 * an optional setup step. Installing twice changes nothing; a target file that
 * differs from the shipped one is kept unless `force` is set; uninstalling
 * removes only what is still identical to what was shipped.
 */
import { spawnSync } from 'node:child_process'
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const syncHook = (matcher) => ({
    matcher,
    hooks: [
        {
            type: 'command',
            command:
                'node "$(git rev-parse --show-toplevel)/scripts/sync-agent-skills.mjs" --hook',
            timeout: 10,
        },
    ],
})

const syncStop = {
    hooks: [
        {
            type: 'command',
            command:
                'node "$(git rev-parse --show-toplevel)/scripts/sync-agent-skills.mjs" --hook',
            timeout: 10,
        },
    ],
}

export const TOOLS = {
    'test-queue': {
        summary:
            'One test run per machine: a FIFO lock shared by every worktree, a Claude Code guard hook, and the wait-for-tests skill',
        files: [
            'scripts/test-lock.mjs',
            'scripts/lib/test-lock.mjs',
            '.claude/hooks/test-queue-guard.mjs',
            '.claude/skills/wait-for-tests/SKILL.md',
        ],
        skills: ['wait-for-tests'],
        hooks: {
            '.claude/settings.json': {
                marker: 'test-queue-guard.mjs',
                events: {
                    PreToolUse: [
                        {
                            matcher: 'Bash',
                            hooks: [
                                {
                                    type: 'command',
                                    command:
                                        'f="$CLAUDE_PROJECT_DIR/.claude/hooks/test-queue-guard.mjs"; [ -f "$f" ] && exec node "$f"; exit 0',
                                    timeout: 15,
                                },
                            ],
                        },
                    ],
                },
            },
        },
        next: [
            'Route your root test script through the lock, e.g. "test": "node scripts/test-lock.mjs run -- vitest run".',
            'Run tests in a pre-push hook the same way: node scripts/test-lock.mjs run -- npm test',
            'Optional: .claude/test-queue.json with { "selfQueuing", "escapes", "protect" } (see README).',
            'Restart Claude Code (or review /hooks) so the guard hook loads.',
        ],
    },
    'skill-sync': {
        summary:
            'Write a skill once, use it in Claude Code and Codex: .agents/skills links and a SKILLS.md catalog kept current by hooks',
        files: ['scripts/sync-agent-skills.mjs'],
        skills: [],
        hooks: {
            '.claude/settings.json': {
                marker: 'sync-agent-skills.mjs',
                events: {
                    PostToolUse: [syncHook('Write|Edit|Bash')],
                    Stop: [syncStop],
                },
            },
            '.codex/hooks.json': {
                marker: 'sync-agent-skills.mjs',
                events: {
                    PostToolUse: [syncHook('Write|Edit|apply_patch|Bash')],
                    Stop: [syncStop],
                },
            },
        },
        setup(target, { dryRun, log }) {
            const skills = join(target, '.claude/skills')
            if (!existsSync(skills)) {
                log(`create  .claude/skills/`)
                if (!dryRun) mkdirSync(skills, { recursive: true })
            }
            const catalog = join(target, 'SKILLS.md')
            const markers =
                '<!-- shared-skills:start -->\n<!-- shared-skills:end -->\n'
            if (!existsSync(catalog)) {
                log('create  SKILLS.md')
                if (!dryRun)
                    writeFileSync(catalog, `# Shared skill catalog\n\n${markers}`)
            } else if (!readFileSync(catalog, 'utf8').includes('shared-skills:start')) {
                log('update  SKILLS.md (catalog markers)')
                if (!dryRun)
                    writeFileSync(
                        catalog,
                        `${readFileSync(catalog, 'utf8').trimEnd()}\n\n${markers}`,
                    )
            }
            if (dryRun) return
            const sync = spawnSync(
                process.execPath,
                [join(target, 'scripts/sync-agent-skills.mjs')],
                { cwd: target, encoding: 'utf8' },
            )
            log(
                sync.status === 0
                    ? 'ran     scripts/sync-agent-skills.mjs'
                    : `warn    sync-agent-skills.mjs failed: ${(sync.stderr || sync.stdout).trim()}`,
            )
        },
        next: [
            'Keep shared skills in .claude/skills/<name>/SKILL.md; commit the source, its .agents/skills link and SKILLS.md together.',
            'Review and trust the new hooks in Claude Code and Codex.',
        ],
    },
}

/** The repository root containing `dir`, or null. */
export function gitRoot(dir) {
    const env = { ...process.env }
    for (const key of Object.keys(env))
        if (key.startsWith('GIT_')) delete env[key]
    const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: dir,
        encoding: 'utf8',
        env,
    })
    return git.status === 0 ? git.stdout.trim() : null
}

function readJson(path) {
    if (!existsSync(path)) return {}
    const text = readFileSync(path, 'utf8')
    if (!text.trim()) return {}
    try {
        return JSON.parse(text)
    } catch {
        throw new Error(`${path} is not valid JSON; fix it before installing`)
    }
}

const writeJson = (path, value) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`)
}

const hasMarker = (entry, marker) =>
    (entry.hooks ?? []).some((h) => String(h.command ?? '').includes(marker))

/** Add the tool's hook entries to one settings object; true when it changed. */
export function mergeHooks(settings, { marker, events }) {
    let changed = false
    settings.hooks ??= {}
    for (const [event, entries] of Object.entries(events)) {
        const list = (settings.hooks[event] ??= [])
        if (list.some((entry) => hasMarker(entry, marker))) continue
        list.push(...structuredClone(entries))
        changed = true
    }
    return changed
}

/** Remove the tool's hook commands from one settings object; true when it changed. */
export function removeHooks(settings, { marker }) {
    let changed = false
    for (const [event, list] of Object.entries(settings.hooks ?? {})) {
        const kept = []
        for (const entry of list) {
            const hooks = (entry.hooks ?? []).filter(
                (h) => !String(h.command ?? '').includes(marker),
            )
            if (hooks.length !== (entry.hooks ?? []).length) changed = true
            if (hooks.length) kept.push({ ...entry, hooks })
        }
        if (kept.length) settings.hooks[event] = kept
        else delete settings.hooks[event]
    }
    if (settings.hooks && !Object.keys(settings.hooks).length)
        delete settings.hooks
    return changed
}

const same = (a, b) => readFileSync(a).equals(readFileSync(b))

export function install(name, target, { force = false, dryRun = false, log = console.log } = {}) {
    const tool = TOOLS[name]
    if (!tool) throw new Error(`unknown tool "${name}"; try: ${Object.keys(TOOLS).join(', ')}`)
    if (resolve(target) === SOURCE)
        throw new Error('the target is ai-tools itself; pass --target <repo>')
    let kept = 0
    for (const file of tool.files) {
        const from = join(SOURCE, file)
        const to = join(target, file)
        if (existsSync(to)) {
            if (same(from, to)) {
                log(`ok      ${file}`)
                continue
            }
            if (!force) {
                log(`keep    ${file} (yours differs; --force replaces it)`)
                kept++
                continue
            }
        }
        log(`${existsSync(to) ? 'replace' : 'add    '} ${file}`)
        if (dryRun) continue
        mkdirSync(dirname(to), { recursive: true })
        writeFileSync(to, readFileSync(from))
        chmodSync(to, statSync(from).mode & 0o777)
    }
    for (const [path, spec] of Object.entries(tool.hooks)) {
        const file = join(target, path)
        const settings = readJson(file)
        if (!mergeHooks(settings, spec)) {
            log(`ok      ${path} hooks`)
            continue
        }
        log(`update  ${path} hooks`)
        if (!dryRun) writeJson(file, settings)
    }
    // Codex discovers skills through .agents/skills; link ours when the
    // target uses that folder.
    const agents = join(target, '.agents/skills')
    if (existsSync(agents))
        for (const skill of tool.skills) {
            const link = join(agents, skill)
            if (existsSync(link) || isLink(link)) continue
            log(`link    .agents/skills/${skill}`)
            if (!dryRun)
                symlinkSync(
                    relative(agents, join(target, '.claude/skills', skill)),
                    link,
                )
        }
    tool.setup?.(target, { dryRun, log })
    return { kept, next: tool.next }
}

function isLink(path) {
    try {
        return lstatSync(path).isSymbolicLink()
    } catch {
        return false
    }
}

export function uninstall(name, target, { force = false, dryRun = false, log = console.log } = {}) {
    const tool = TOOLS[name]
    if (!tool) throw new Error(`unknown tool "${name}"; try: ${Object.keys(TOOLS).join(', ')}`)
    if (resolve(target) === SOURCE)
        throw new Error('the target is ai-tools itself; pass --target <repo>')
    for (const [path, spec] of Object.entries(tool.hooks)) {
        const file = join(target, path)
        if (!existsSync(file)) continue
        const settings = readJson(file)
        if (!removeHooks(settings, spec)) continue
        log(`update  ${path} hooks`)
        if (!dryRun) writeJson(file, settings)
    }
    for (const skill of tool.skills) {
        const link = join(target, '.agents/skills', skill)
        if (!isLink(link)) continue
        log(`unlink  .agents/skills/${skill}`)
        if (!dryRun) rmSync(link)
    }
    for (const file of tool.files) {
        const to = join(target, file)
        if (!existsSync(to)) continue
        if (!force && !same(join(SOURCE, file), to)) {
            log(`keep    ${file} (changed since install; --force removes it)`)
            continue
        }
        log(`remove  ${file}`)
        if (dryRun) continue
        rmSync(to)
        // Drop directories the tool created, never ones with other files.
        for (
            let dir = dirname(to);
            dir.startsWith(target) && dir !== target;
            dir = dirname(dir)
        ) {
            if (readdirSync(dir).length) break
            rmdirSync(dir)
        }
    }
}

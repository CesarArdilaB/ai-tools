import assert from 'node:assert/strict'
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, '.claude/skills')
const destination = join(root, '.agents/skills')
// Never write through a planted link: the catalog and the folders that hold
// the links must be real paths inside this repository.
for (const path of ['.agents', '.agents/skills', 'SKILLS.md'])
    assert(
        !lstatSync(join(root, path), { throwIfNoEntry: false })?.isSymbolicLink(),
        `${path} is a symlink; refusing to write through it`,
    )
const check = process.argv.includes('--check')
const hook = process.argv.includes('--hook')
assert(
    process.argv.slice(2).every((arg) => ['--check', '--hook'].includes(arg)),
    'Usage: node scripts/sync-agent-skills.mjs [--check] [--hook]',
)

const names = readdirSync(source)
    .filter((name) => existsSync(join(source, name, 'SKILL.md')))
    .sort()
const errors = []
const catalogPath = join(root, 'SKILLS.md')
const catalog = readFileSync(catalogPath, 'utf8')
const start = '<!-- shared-skills:start -->'
const end = '<!-- shared-skills:end -->'
assert(
    catalog.split(start).length === 2 &&
        catalog.split(end).length === 2 &&
        catalog.indexOf(start) < catalog.indexOf(end),
    'SKILLS.md must contain exactly one ordered shared-skills marker pair',
)
const rows = names.map((name) => {
    const label = name
        .replaceAll('|', '\\|')
        .replaceAll('[', '\\[')
        .replaceAll(']', '\\]')
    const path = encodeURIComponent(name)
    return `| ${label} | [Source](.claude/skills/${path}/SKILL.md) | [Codex link](.agents/skills/${path}/SKILL.md) |`
})
const section = [
    start,
    '',
    '<!-- Updated by scripts/sync-agent-skills.mjs. Edit skill sources, not this table. -->',
    '',
    '| Skill | Shared source (Claude) | Codex |',
    '| --- | --- | --- |',
    ...rows,
    '',
    end,
].join('\n')
const updatedCatalog =
    catalog.slice(0, catalog.indexOf(start)) +
    section +
    catalog.slice(catalog.indexOf(end) + end.length)
const catalogChanged = updatedCatalog !== catalog
if (check && catalogChanged)
    errors.push('SKILLS.md shared skill index is stale')
if (!check) mkdirSync(destination, { recursive: true })
for (const name of names) {
    const target = join(source, name)
    const link = join(destination, name)
    const expected = relative(destination, target)
    const entry = lstatSync(link, { throwIfNoEntry: false })
    if (!entry && !check) {
        try {
            symlinkSync(expected, link, 'dir')
        } catch (error) {
            // Two agents can register the same newly-created skill concurrently.
            if (error.code !== 'EEXIST') throw error
            if (
                !lstatSync(link).isSymbolicLink() ||
                readlinkSync(link) !== expected
            ) {
                errors.push(`Conflicting skill entry: ${relative(root, link)}`)
            }
        }
    } else if (!entry)
        errors.push(`Missing shared skill link: ${relative(root, link)}`)
    else if (!entry.isSymbolicLink() || readlinkSync(link) !== expected) {
        errors.push(
            `Refusing to replace existing entry: ${relative(root, link)} (expected symlink to ${expected})`,
        )
    }
    if (existsSync(link) && realpathSync(link) !== realpathSync(target)) {
        errors.push(`Shared skill resolves to the wrong directory: ${name}`)
    }
}
if (existsSync(destination)) {
    for (const name of readdirSync(destination)) {
        const path = join(destination, name)
        if (
            lstatSync(path).isSymbolicLink() &&
            !existsSync(join(path, 'SKILL.md'))
        ) {
            errors.push(`Broken skill link: ${relative(root, path)}`)
        }
    }
}
if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
} else {
    if (!check && catalogChanged) writeFileSync(catalogPath, updatedCatalog)
    const message = `${check ? 'Verified' : 'Linked'} ${names.length} shared skills and their catalog entries; no conflicting or broken links.`
    // Stop requires JSON; the same response also works for PostToolUse in both agents.
    console.log(
        hook
            ? JSON.stringify(catalogChanged ? { systemMessage: message } : {})
            : message,
    )
}

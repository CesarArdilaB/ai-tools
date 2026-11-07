#!/usr/bin/env node
/**
 *   ai-tools list
 *   ai-tools install <tool…> [--target <repo>] [--force] [--dry-run]
 *   ai-tools uninstall <tool…> [--target <repo>] [--force] [--dry-run]
 *
 * Without a clone: npx -y github:CesarArdilaB/ai-tools install test-queue
 * The target defaults to the git repository of the current directory.
 */
import { resolve } from 'node:path'
import { gitRoot, install, TOOLS, uninstall } from '../scripts/lib/install.mjs'

const USAGE = `usage:
  ai-tools list
  ai-tools install <tool…|all> [--target <repo>] [--force] [--dry-run]
  ai-tools uninstall <tool…|all> [--target <repo>] [--force] [--dry-run]`

const args = process.argv.slice(2)
const flag = (name) => {
    const i = args.indexOf(name)
    if (i === -1) return false
    args.splice(i, 1)
    return true
}
const option = (name) => {
    const i = args.indexOf(name)
    if (i === -1) return null
    const [, value] = args.splice(i, 2)
    if (!value) fail(`${name} needs a value`)
    return value
}

function fail(message) {
    console.error(`ai-tools: ${message}\n\n${USAGE}`)
    process.exit(2)
}

const force = flag('--force')
const dryRun = flag('--dry-run')
const help = flag('--help') || flag('-h')
const targetArg = option('--target')
const [command, ...names] = args

if (help || !command) {
    console.log(USAGE)
    process.exit(help ? 0 : 2)
}

if (command === 'list') {
    for (const [name, tool] of Object.entries(TOOLS))
        console.log(`${name.padEnd(12)} ${tool.summary}`)
    process.exit(0)
}

if (!['install', 'uninstall'].includes(command)) fail(`unknown command "${command}"`)
const tools = names.includes('all') ? Object.keys(TOOLS) : names
if (!tools.length) fail(`name a tool: ${Object.keys(TOOLS).join(', ')}, or all`)
for (const name of tools)
    if (!TOOLS[name]) fail(`unknown tool "${name}"; try: ${Object.keys(TOOLS).join(', ')}`)

const target = gitRoot(resolve(targetArg ?? process.cwd()))
if (!target)
    fail(`${resolve(targetArg ?? process.cwd())} is not inside a git repository`)

try {
    for (const name of tools) {
        console.log(`\n${command} ${name} → ${target}${dryRun ? ' (dry run)' : ''}`)
        if (command === 'uninstall') {
            uninstall(name, target, { force, dryRun })
            continue
        }
        const { kept, next } = install(name, target, { force, dryRun })
        if (kept)
            console.log(`\n${kept} file(s) kept as they are; compare them with the shipped copy or re-run with --force.`)
        console.log('\nNext:')
        for (const line of next) console.log(`  - ${line}`)
    }
} catch (error) {
    console.error(`ai-tools: ${error.message}`)
    process.exit(1)
}

# ai-tools

Write a skill once. Use it in Claude Code and Codex.

A small, dependency-free starter for sharing repository skills between agents. Relative directory symlinks expose the same files to both agents, and hooks automatically register new skills in a Markdown catalog.

## How it works

```text
.claude/skills/explain-change/   # the maintained skill
.agents/skills/explain-change   # symlink to the maintained skill
SKILLS.md                      # automatically updated index
```

Claude reads `.claude/skills/`. Codex discovers the linked folders in `.agents/skills/`. Both agents call the same updater after file edits and shell commands, and again at the end of a turn.

The updater only changes its marked catalog section and creates missing links. It preserves other prose, refuses conflicting entries, and reports dangling links without deleting them. Repeated runs leave an up-to-date catalog untouched.

## Try it

Requires Git and Node.js 22+. No dependency installation is needed.

```sh
git clone https://github.com/CesarArdilaB/ai-tools.git
cd ai-tools
npm run skills:sync
npm test
npm run skills:check
```

Open this repository in Claude Code or Codex. Review the hook commands before enabling them. Codex requires explicit trust of new or changed hook definitions; repository trust alone is not enough. Restart your agent if its configuration or skill list has not refreshed.

Two original example skills are included: `explain-change` and `document-command`. See [SKILLS.md](SKILLS.md).

## Add a skill

Create `.claude/skills/my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: Describe the specific task this skill helps with and when to use it.
---

Write the instructions here.
```

The next matching hook creates `.agents/skills/my-skill` and adds the catalog row. When editing outside an agent, or when hooks are not enabled, run `npm run skills:sync`. Commit the source, link, and catalog together.

Use portable instructions for shared skills. Agent-specific tools and metadata may need separate guidance; a symlink shares files, it does not translate their behavior.

## Adopt in an existing repository

1. Copy `scripts/sync-agent-skills.mjs` into your repository's `scripts/` directory.
2. Maintain shared skills in `.claude/skills/`. Create that directory if needed.
3. Add the following markers to your root `SKILLS.md` (create the file if needed):

   ```markdown
   <!-- shared-skills:start -->
   <!-- shared-skills:end -->
   ```

4. Merge the hook entries from [Claude settings](.claude/settings.json) and [Codex hooks](.codex/hooks.json) into your existing configuration. Preserve existing hooks; do not replace whole configuration files.
5. Run `node scripts/sync-agent-skills.mjs`, then `node scripts/sync-agent-skills.mjs --check`.
6. Review and trust the new hooks in your agents.

The script resolves its repository root from its own location, so keep it under `scripts/`. Hook commands use Git to locate that root when a session works in a nested directory. Agent-specific skills can stay in their own discovery folders as long as they do not conflict with shared names. Remove obsolete copies from other installed plugins deliberately; this tool does not modify personal installations.

## Commands

| Command | Purpose |
| --- | --- |
| `node scripts/sync-agent-skills.mjs` | Create missing links and refresh the catalog |
| `node scripts/sync-agent-skills.mjs --check` | Validate without writing; exit nonzero for drift or conflicts |
| `node scripts/sync-agent-skills.mjs --hook` | Update with JSON output suitable for agent hooks |
| `npm test` | Run isolated filesystem tests |

If a skill is deleted or renamed, remove its obsolete link yourself after verifying the target. The updater reports it instead of deleting it automatically. To uninstall the automation, remove only its hook entries and links; keep your original skills.

## Compatibility

Designed for macOS and Linux. Windows users should use WSL; native Windows shells and symlink permissions are not covered by this starter. Git must preserve symlinks when cloning. Git worktrees work because the links are relative.

Files are shared immediately on disk. Agent discovery refresh and hook execution depend on the installed agent version and trust settings. The tests exercise hook commands and filesystem behavior; they do not certify every agent release.

- [Claude Code skill discovery](https://code.claude.com/docs/en/skills#choose-where-skills-load)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [Codex hooks and trust](https://learn.chatgpt.com/docs/hooks)

## Contributing

Small improvements and reproducible bug reports are welcome. Include your OS, Node version, agent version, and a minimal reproduction without secrets. Run `npm test`, `npm run skills:check`, and `git diff --check` before opening a pull request.

## License

MIT. The example skills are original to this starter; no third-party skill bundles are included.

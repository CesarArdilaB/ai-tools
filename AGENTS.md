# Working on ai-tools

Use Node.js 22 or newer. This repository has no runtime dependencies.

Shared skills live in `.claude/skills/<name>/SKILL.md`. Edit those originals; `.agents/skills/<name>` contains relative symlinks for Codex. Keep agent-specific configuration in the corresponding agent directory.

After adding a skill, run `npm run skills:sync` if hooks have not already registered it. Do not hand-edit the marked table in `SKILLS.md`.

Before committing, run `npm test`, `npm run skills:check`, and `git diff --check`. Preserve existing user files; never overwrite a conflicting skill directory to repair a link.

---
name: document-command
description: Write or update usage documentation for a repository command or script when the user asks for setup steps, examples, or a command reference.
---

# Document a command

Read the implementation or its help output to establish supported arguments, defaults, prerequisites, and side effects. Avoid running a command with external effects merely to discover its behavior.

Document the simplest useful invocation first, followed by the options that materially change the result. Explain where to run the command, what success looks like, and how to recover from the common errors supported by the implementation.

Use placeholders for secrets and machine-specific paths. Update the existing documentation when possible. Verify examples against the actual interface and state which examples were executed.

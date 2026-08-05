---
title: Integrations
description: Supported agents, and manual MCP setup.
---

The interactive installer auto-detects and configures each supported agent — wiring the HomeGraph MCP server into each. For the agents that use an instructions file, it also writes a short marker-fenced HomeGraph section (`CLAUDE.md`, `AGENTS.md`, or `GEMINI.md`) so subagents and non-MCP harnesses learn the `homegraph explore` command; `homegraph uninstall` removes it.

## Supported agents

- **Claude Code**
- **Cursor**
- **Codex CLI**
- **opencode**
- **Hermes Agent**
- **Gemini CLI**
- **Antigravity IDE**
- **Kiro**

Run `npx @colbymchenry/homegraph` and pick your agent(s); see [Installation](/homegraph/getting-started/installation/) for the non-interactive flags.

## Manual setup

If you'd rather wire it up yourself, install globally:

```bash
npm install -g @colbymchenry/homegraph
```

Add the MCP server to `~/.claude.json`:

```json
{
  "mcpServers": {
    "homegraph": {
      "type": "stdio",
      "command": "homegraph",
      "args": ["serve", "mcp"]
    }
  }
}
```

Optionally auto-allow HomeGraph's tools in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__homegraph__*"
    ]
  }
}
```

One wildcard auto-approves every HomeGraph tool. The server lists the full tool surface by default; trim it with the `HOMEGRAPH_MCP_TOOLS` environment variable if needed.

:::tip
Cursor launches MCP subprocesses with the wrong working directory. The installer handles this for you by injecting a `--path` argument; if you wire Cursor up by hand, pass the project path explicitly.
:::

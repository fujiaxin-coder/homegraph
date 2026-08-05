---
title: CLI
description: Every HomeGraph command and the flags it accepts.
---

```bash
homegraph                         # Run interactive installer
homegraph install                 # Run installer (explicit)
homegraph uninstall               # Remove HomeGraph from your agents (inverse of install)
homegraph init [path]             # Initialize a project + build its graph (one step)
homegraph uninit [path]           # Remove HomeGraph from a project (--force to skip prompt)
homegraph index [path]            # Full re-index from scratch (--force, --quiet, --verbose)
homegraph sync [path]             # Incremental update (--quiet)
homegraph status [path]           # Show statistics (--json)
homegraph unlock [path]           # Remove a stale lock file that's blocking indexing
homegraph query <search>          # Search symbols (--kind, --limit, --json)
homegraph explore <query>         # Relevant symbols' source + call paths in one shot (same output as the homegraph_explore MCP tool)
homegraph node <symbol|file>      # One symbol's source + callers, or read a file with line numbers (same output as homegraph_node)
homegraph files [path]            # Show file structure (--format, --filter, --pattern, --max-depth, --json)
homegraph callers <symbol>        # Find what calls a function/method (--limit, --json)
homegraph callees <symbol>        # Find what a function/method calls (--limit, --json)
homegraph impact <symbol>         # Analyze what code is affected by changing a symbol (--depth, --json)
homegraph affected [files...]     # Find test files affected by changes (see below)
homegraph daemon                  # Manage background daemons — pick one to stop (alias: daemons)
homegraph telemetry [on|off]      # Show or change anonymous usage telemetry
homegraph upgrade [version]       # Update to the latest release (--check, --force)
homegraph version                 # Print the installed version (also -v, --version)
homegraph help [command]          # Show help, optionally for one command
```

The MCP server (`homegraph serve mcp`) is launched automatically by your agent — you don't run it by hand. See [MCP Server](/homegraph/reference/mcp-server/).

## init, index, and sync

`homegraph init` creates the local `.homegraph/` directory **and** builds the full graph in one step. (The old `-i`/`--index` flag is now a no-op, accepted only so existing scripts don't break.) After that the file watcher keeps the graph current automatically — `index` (a full rebuild from scratch) and `sync` (an incremental update) are only needed when the watcher is disabled or you're scripting against the index outside an agent session.

## Query commands

`query`, `callers`, `callees`, and `impact` all accept `--json` for machine-readable output.

```bash
homegraph query UserService --kind class --limit 10
homegraph callers handleRequest --json
homegraph impact AuthMiddleware --depth 3
```

`explore` and `node` are the CLI faces of the `homegraph_explore` and `homegraph_node` MCP tools — same output — so subagents and non-MCP harnesses can reach the graph from a shell.

## affected

Traces import dependencies transitively to find which test files are affected by changed source files. See [Affected Tests in CI](/homegraph/guides/affected-tests/) for options and a CI example.

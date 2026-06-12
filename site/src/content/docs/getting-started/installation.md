---
title: Installation
description: Install HomeGraph and configure your AI coding agents.
---

## 1. Run the installer

```bash
npx @colbymchenry/homegraph
```

The installer will:

- Ask which agent(s) to configure — auto-detecting installed ones from **Claude Code**, **Cursor**, **Codex CLI**, **opencode**, **Hermes Agent**, **Gemini CLI**, **Antigravity IDE**, and **Kiro**.
- Prompt to install `homegraph` on your `PATH` (so agents can launch the MCP server).
- Ask whether configs apply to all your projects or just this one.
- Write each chosen agent's MCP server config, plus a small marker-fenced HomeGraph section in the agent's instructions file (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`). Cursor and Kiro get the MCP config only. Removed cleanly by `homegraph uninstall`.
- Set up auto-allow permissions when Claude Code is one of the targets.

The installer **wires up your agents only — it does not index your code.** After it finishes, build each project's graph yourself with `homegraph init` (step 3 below).

## Non-interactive (scripting / CI)

```bash
homegraph install --yes                              # auto-detect agents, install global
homegraph install --target=cursor,claude --yes       # explicit target list
homegraph install --target=auto --location=local     # detected agents, project-local
homegraph install --print-config codex               # print snippet, no file writes
```

| Flag | Values | Default |
|---|---|---|
| `--target` | `auto`, `all`, `none`, or csv (`claude,cursor,…`) | prompt |
| `--location` | `global`, `local` | prompt |
| `--yes` | (boolean) | prompt every step |
| `--no-permissions` | (boolean) skip Claude auto-allow list | permissions on |
| `--print-config <id>` | dump snippet for one agent and exit | — |

## 2. Restart your agent

Restart your agent (Claude Code / Cursor / Codex CLI / opencode / Hermes Agent / Gemini CLI / Antigravity IDE / Kiro) for the MCP server to load.

## 3. Initialize projects

```bash
cd your-project
homegraph init
```

`homegraph init` creates the local `.homegraph/` directory and builds the full graph in the same step — one command. A single global `homegraph install` covers every project; you run `homegraph init` once per project.

## Supported platforms

Every release ships a self-contained build (bundled Node runtime — nothing to compile) for all three desktop OSes, on both x64 and arm64:

| Platform | Architectures | Install |
|---|---|---|
| Windows | x64, arm64 | PowerShell installer or npm |
| macOS | x64, arm64 | shell installer or npm |
| Linux | x64, arm64 | shell installer or npm |

## Uninstall

Changed your mind? One command removes HomeGraph from every agent it configured:

```bash
homegraph uninstall
```

This reverses the installer — stripping HomeGraph's MCP server config, instructions, and permissions from each configured agent. Your project indexes (`.homegraph/`) are left untouched; remove those per-project with `homegraph uninit`. Use `--target` to remove from specific agents, or `--yes` to run non-interactively.

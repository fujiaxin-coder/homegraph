---
title: Get Started
description: Get up and running with HomeGraph in seconds.
---

Get up and running with HomeGraph in seconds.

## 1. Install the CLI

No Node.js required — one command grabs the right build for your OS:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/homegraph/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/colbymchenry/homegraph/main/install.ps1 | iex
```

Already have Node? `npm i -g @colbymchenry/homegraph` works on any version. HomeGraph bundles its own runtime — nothing to compile, no native build, works the same everywhere. The installer puts `homegraph` on your `PATH` but doesn't change your current shell — open a new terminal before the next step.

## 2. Wire up your agent(s)

```bash
homegraph install
```

Auto-detects and configures Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE, and Kiro — wiring the HomeGraph MCP server into each. This step connects your agents only; it does **not** index any code. (Shortcut: `npx @colbymchenry/homegraph` downloads and runs the installer in one go.)

## 3. Initialize each project

```bash
cd your-project
homegraph init
```

`homegraph init` creates the local `.homegraph/` directory and builds the full graph in the same step — one command, done. Your agent will use HomeGraph tools automatically when a `.homegraph/` directory exists.

Next: build [Your First Graph](/homegraph/getting-started/your-first-graph/), or see the full [Installation](/homegraph/getting-started/installation/) options.

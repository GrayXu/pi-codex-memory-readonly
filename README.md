# pi-codex-memory-readonly

A read-only memory bridge for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). It lets pi read the local memory that [OpenAI Codex CLI](https://github.com/openai/codex) builds and consolidates under `~/.codex/memories` — without ever writing back.

Codex consolidates its memory in the background (two-phase pipeline, per-session extraction → global consolidation). This extension turns that store into shared background knowledge for pi sessions.

## What it does

- Injects a bounded `memory_summary.md` plus navigation instructions into pi's system prompt (`<codex_memory>` section). Content is stable within a session, so the prompt cache prefix stays valid.
- Adds read-only tools:

| Tool | Purpose |
|---|---|
| `codex_memory_summary` | compact consolidated summary + inventory + last consolidation commit |
| `codex_memory_outline` | markdown heading outline with line numbers (default `MEMORY.md`) |
| `codex_memory_read` | line-range read, sandboxed to the memory root |
| `codex_memory_search` | literal/regex search across `MEMORY.md`, `raw_memories.md`, `rollout_summaries/`, skysight activity summaries |

- `/codex-memory` command and a footer status line showing the last Codex consolidation.

## No-write-back guard

Read-only is enforced, not just advised:

- the extension performs no filesystem writes;
- `write`/`edit` calls targeting the memory root or its sibling `memories_*.sqlite` are blocked;
- `bash`/`powershell` commands referencing those paths are rejected (reads included — use the bridge tools).

Path-splitting tricks in shell commands are not covered; this is a practical boundary, not an OS sandbox.

## Install

```sh
pi install git:https://github.com/GrayXu/pi-codex-memory-readonly
```

or copy `extensions/codex-memory-readonly.ts` directly into `~/.pi/agent/extensions/`.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `CODEX_MEMORIES_DIR` | `~/.codex/memories` | Codex memory root |
| `CODEX_MEM_INJECT_BUDGET` | `6000` | max chars injected into the system prompt; `0` disables injection |
| `CODEX_MEM_DISABLE` | unset | `1` / `true` / `yes` disables the extension |

## Notes

- The bridge reads only Codex's on-disk markdown layout; it does not touch the internal SQLite pipeline state, so internal schema changes do not break it.
- pi sessions are never consolidated into Codex memory — there is no write path, by design.
- Memory content may be stale; the injected instructions tell the model to verify time-sensitive facts.

## License

MIT

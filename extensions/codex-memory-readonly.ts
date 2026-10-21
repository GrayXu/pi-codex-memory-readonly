/**
 * codex-memory-readonly — a read-only bridge from pi to OpenAI Codex's local memory system.
 *
 * Codex maintains and consolidates its memory under ~/.codex/memories (two-phase pipeline,
 * background consolidation). This extension never writes there. It only:
 *   1. Injects a bounded memory summary + navigation instructions into the system prompt
 *      (stable per session, so the prompt cache prefix stays valid).
 *   2. Registers read-only tools to navigate/search the memory layout:
 *      - codex_memory_outline: heading outline (with line numbers) of a memory file
 *      - codex_memory_read:    sandboxed line-range read of a memory file
 *      - codex_memory_search:  case-insensitive literal/regex search across memory files
 *      - codex_memory_summary: the compact consolidated summary + inventory
 *   3. Registers /codex-memory to inspect bridge status.
 *
 * Configuration (environment variables):
 *   CODEX_MEMORIES_DIR     memory root (default ~/.codex/memories)
 *   CODEX_MEM_INJECT_BUDGET  max chars of memory_summary.md injected into the system
 *                            prompt (default 6000; 0 disables injection)
 *   CODEX_MEM_DISABLE       truthy ("1"/"true"/"yes") disables the whole extension
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_INJECT_BUDGET = 6000;
const SUMMARY_TOOL_CHAR_CAP = 30000;
const READ_CHAR_CAP = 60000;
const OUTLINE_TITLE_CAP = 160;
const SEARCH_LINE_CAP = 240;
const MAX_WALK_FILES = 2000;

const envFlag = (value: string | undefined): boolean =>
	value === "1" || value === "true" || value === "yes";

const config = {
	disabled: envFlag(process.env.CODEX_MEM_DISABLE),
	root: process.env.CODEX_MEMORIES_DIR
		? resolve(process.env.CODEX_MEMORIES_DIR.replace(/^~(?=\/|$)/, homedir()))
		: join(homedir(), ".codex", "memories"),
	injectBudget: (() => {
		const raw = Number.parseInt(process.env.CODEX_MEM_INJECT_BUDGET ?? "", 10);
		return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_INJECT_BUDGET;
	})(),
};

// ---------------------------------------------------------------------------
// Codex memory layout helpers
// ---------------------------------------------------------------------------

interface MemoryFile {
	rel: string;
	size: number;
}

/** Last commit of the memories git repo, or null when unavailable. */
function lastGitCommit(root: string): { date: string; subject: string } | null {
	try {
		const res = spawnSync("git", ["-C", root, "log", "-1", "--format=%cs%x09%s"], {
			encoding: "utf8",
			timeout: 5000,
		});
		const line = (res.stdout ?? "").trim();
		if (res.status === 0 && line) {
			const [date, ...rest] = line.split("\t");
			return { date, subject: rest.join("\t").slice(0, 120) };
		}
	} catch {
		// git may be absent or the directory may not be a repo
	}
	return null;
}

/** Recursive file walk under root, skipping .git. Bounded by MAX_WALK_FILES. */
function walkFiles(root: string, dir = root): string[] {
	const out: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (out.length >= MAX_WALK_FILES) break;
		if (entry.name === ".git") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkFiles(root, full));
		} else if (entry.isFile()) {
			out.push(relative(root, full));
		}
	}
	return out;
}

/** Tiny glob: `**` crosses separators, `*` stays within one segment. */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const src = escaped
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\u0000/g, ".*");
	return new RegExp(`^${src}$`);
}

const DEFAULT_SEARCH_FILES = [
	"MEMORY.md",
	"raw_memories.md",
	"memory_summary.md",
	"rollout_summaries/**/*.md",
	"extensions/skysight/resources/*.md",
];

function resolveSearchFiles(root: string, patterns: string[]): { rels: string[]; missing: string[] } {
	const files = walkFiles(root);
	const set = new Set<string>();
	const missing: string[] = [];
	for (const pattern of patterns) {
		const trimmed = pattern.trim();
		if (!trimmed) continue;
		const re = globToRegExp(trimmed);
		const matched = files.filter((rel) => re.test(rel));
		if (matched.length === 0) missing.push(trimmed);
		for (const rel of matched) set.add(rel);
	}
	return { rels: [...set].sort(), missing };
}

/** Read a file inside the memory root, enforcing path containment. */
function readMemoryFile(root: string, relPath: string): { lines: string[]; rel: string } {
	const target = resolve(root, relPath);
	const rootReal = realpathSync(root);
	let targetReal: string;
	try {
		targetReal = realpathSync(target);
	} catch {
		throw new Error(`File not found inside the memory root: ${relPath}`);
	}
	if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
		throw new Error(`Path escapes the memory root: ${relPath}`);
	}
	const rel = relative(rootReal, targetReal);
	const text = readFileSync(targetReal, "utf8");
	return { lines: text.split("\n"), rel };
}

// ---------------------------------------------------------------------------
// No-write-back guard
// ---------------------------------------------------------------------------

/**
 * True when a filesystem path targets the Codex memory system: the memory root
 * subtree or the sibling memories_*.sqlite databases of its pipeline.
 * Works without the target existing, so it also blocks creating files there.
 */
function isMemorySystemTarget(path: string): boolean {
	const resolved = resolve(path.replace(/^~(?=\/|$)/, homedir()));
	const root = resolve(config.root);
	if (resolved === root || resolved.startsWith(root + sep)) return true;
	return resolved.startsWith(join(dirname(root), "memories_"));
}

/**
 * True when a shell command references the Codex memory system by path.
 * Catches ~/.codex/memories..., $HOME/.codex/memories..., absolute forms, and
 * bare memories_*.sqlite references. Read needs are served by the bridge tools.
 */
function commandTouchesMemorySystem(command: string): boolean {
	if (command.includes(".codex/memories")) return true;
	return /(^|[\s\"'`$=(;:])memories_[a-z0-9]*\.sqlite/i.test(command);
}

// ---------------------------------------------------------------------------
// Extension state (recomputed per session; contains only plain data)
// ---------------------------------------------------------------------------

interface BridgeState {
	available: boolean;
	unavailableReason?: string;
	section?: string;
	summaryChars: number;
	fileCount: number;
	lastCommit: { date: string; subject: string } | null;
}

function truncateAtLineBoundary(text: string, budget: number): string {
	if (text.length <= budget) return text;
	const cut = text.slice(0, budget);
	const lastNewline = cut.lastIndexOf("\n");
	const head = lastNewline > budget * 0.5 ? cut.slice(0, lastNewline) : cut;
	return `${head}\n[… truncated: ${text.length} chars total, first ~${head.length} shown. Read the rest with codex_memory_summary …]`;
}

function computeState(): BridgeState {
	if (!existsSync(config.root)) {
		return {
			available: false,
			unavailableReason: `memory root not found: ${config.root}`,
			summaryChars: 0,
			fileCount: 0,
			lastCommit: null,
		};
	}
	const hasMemory = existsSync(join(config.root, "MEMORY.md"));
	const hasSummary = existsSync(join(config.root, "memory_summary.md"));
	if (!hasMemory && !hasSummary) {
		return {
			available: false,
			unavailableReason: `no MEMORY.md/memory_summary.md under ${config.root}`,
			summaryChars: 0,
			fileCount: 0,
			lastCommit: null,
		};
	}
	const commit = lastGitCommit(config.root);
	const fileCount = walkFiles(config.root).length;

	let section: string | undefined;
	let summaryChars = 0;
	if (config.injectBudget > 0 && hasSummary) {
		const raw = readFileSync(join(config.root, "memory_summary.md"), "utf8");
		const bounded = truncateAtLineBoundary(raw, config.injectBudget);
		summaryChars = bounded.length;
		const commitLine = commit ? `${commit.date} — ${commit.subject}` : "unknown (no git history)";
		section = [
			"Read-only bridge to OpenAI Codex's local agent memory. Codex consolidates this memory in the background; pi never writes to it.",
			"",
			`Root: ${config.root}`,
			`Last consolidation (git): ${commitLine}`,
			"",
			"Layout:",
			"- MEMORY.md — consolidated long-term memory, organized as `### <cwd>` → `#### <date>` → task groups with keywords and rollout references. Large: navigate with codex_memory_outline, then read the relevant line range with codex_memory_read.",
			"- memory_summary.md — compact consolidated summary (injected below, possibly truncated).",
			"- raw_memories.md — per-session raw extractions.",
			"- rollout_summaries/ — per-session summaries.",
			"- extensions/skysight/resources/ — periodic 10-minute/6-hour activity summaries.",
			"",
			"Tools (read-only): codex_memory_outline, codex_memory_read, codex_memory_search, codex_memory_summary.",
			"",
			"Guidance:",
			"- Treat the memories as background knowledge about the user, projects, and past investigations; they may be stale. Verify time-sensitive or runtime facts before relying on them.",
			"- For project/task context prefer codex_memory_outline + codex_memory_read on MEMORY.md; for specific identifiers, errors, or decisions use codex_memory_search across all files.",
			"- This bridge is strictly read-only: writes into the Codex memory system (memory root or memories_*.sqlite) are blocked at the tool level, and shell commands referencing those paths are rejected. Use the codex_memory_* tools for all memory access. pi sessions are never consolidated into Codex memory.",
			"",
			"<codex_memory_summary>",
			bounded,
			"</codex_memory_summary>",
		].join("\n");
	}

	return { available: true, section, summaryChars, fileCount, lastCommit: commit };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function codexMemoryReadonly(pi: ExtensionAPI) {
	if (config.disabled) return;

	let state: BridgeState = {
		available: false,
		unavailableReason: "not initialized",
		summaryChars: 0,
		fileCount: 0,
		lastCommit: null,
	};

	const textResult = (text: string, details: unknown = undefined) => ({
		content: [{ type: "text" as const, text }],
		details,
	});

	const errorResult = (message: string) => ({
		content: [{ type: "text" as const, text: message }],
		details: undefined,
		isError: true,
	});

	const rootExists = () => existsSync(config.root);

	pi.on("session_start", (_event, ctx) => {
		state = computeState();
		if (ctx.hasUI) {
			if (state.available) {
				const when = state.lastCommit?.date ?? "unknown";
				ctx.ui.setStatus("codex-mem", `codex-mem: ${state.fileCount} files, ${when}`);
			} else {
				ctx.ui.setStatus("codex-mem", undefined);
			}
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("codex-mem", undefined);
	});

	// Inject (or refresh) the memory section on every user-started run. The content is
	// stable within a session, so the transcript only records the initial prompt delta.
	pi.on("before_agent_start", (event) => {
		if (event.messageType !== "user" || !state.available || !state.section) return;
		event.systemPromptOptions.sections.codex_memory = state.section;
	});

	// Hard no-write-back guard: block any tool call that could mutate the Codex memory
	// system, regardless of model instructions. Reads are served by the bridge tools.
	pi.on("tool_call", async (event, ctx) => {
		const block = (reason: string) => {
			if (ctx.hasUI) ctx.ui.notify(`codex-memory-readonly: blocked — ${reason}`, "warning");
			return { block: true, reason };
		};

		if (event.toolName === "write" || event.toolName === "edit") {
			const path = (event.input as { path?: unknown }).path;
			if (typeof path === "string" && isMemorySystemTarget(path)) {
				return block(`writing to the Codex memory system is forbidden (read-only bridge): ${path}`);
			}
			return undefined;
		}

		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = (event.input as { command?: unknown }).command;
			if (typeof command === "string" && commandTouchesMemorySystem(command)) {
				return block(
					"shell commands may not reference the Codex memory system (read-only bridge); use the codex_memory_* tools instead",
				);
			}
		}

		return undefined;
	});

	// -- Tools --------------------------------------------------------------

	pi.registerTool({
		name: "codex_memory_summary",
		label: "Codex memory summary",
		description:
			"Read the compact consolidated summary of OpenAI Codex's local memory (memory_summary.md), plus an inventory of the memory root. Read-only.",
		promptSnippet: "Read-only access to OpenAI Codex's local memory summary and files.",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!rootExists()) return errorResult(`Codex memory root not found: ${config.root}`);
			const summaryPath = join(config.root, "memory_summary.md");
			if (!existsSync(summaryPath)) {
				return errorResult("memory_summary.md not found; use codex_memory_outline on MEMORY.md instead");
			}
			const raw = readFileSync(summaryPath, "utf8");
			const commit = state.lastCommit ?? lastGitCommit(config.root);
			const inventory = [
				`Root: ${config.root}`,
				`Files: ${state.fileCount || walkFiles(config.root).length}`,
				`Last consolidation (git): ${commit ? `${commit.date} — ${commit.subject}` : "unknown"}`,
			].join("\n");
			const bounded = truncateAtLineBoundary(raw, SUMMARY_TOOL_CHAR_CAP);
			return textResult(`${inventory}\n\n${bounded}`, { root: config.root, chars: bounded.length });
		},
	});

	pi.registerTool({
		name: "codex_memory_outline",
		label: "Codex memory outline",
		description:
			"List markdown headings of a Codex memory file with line numbers, to pick a codex_memory_read range. Defaults to MEMORY.md (organized by cwd → date → task group). Read-only.",
		promptSnippet: "Outline headings of a Codex memory file (default MEMORY.md) with line numbers.",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		parameters: Type.Object({
			file: Type.Optional(
				Type.String({ description: "File path relative to the memory root (default MEMORY.md)" }),
			),
			maxEntries: Type.Optional(
				Type.Number({ description: "Maximum headings to return (default 600)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!rootExists()) return errorResult(`Codex memory root not found: ${config.root}`);
			const file = params.file?.trim() || "MEMORY.md";
			let lines: string[];
			try {
				({ lines } = readMemoryFile(config.root, file));
			} catch (error) {
				return errorResult(String(error instanceof Error ? error.message : error));
			}
			const maxEntries = Math.min(Math.max(Math.trunc(params.maxEntries ?? 600) || 600, 1), 2000);
			const out: string[] = [];
			let total = 0;
			for (let i = 0; i < lines.length; i++) {
				const match = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
				if (!match) continue;
				total++;
				if (out.length < maxEntries) {
					const indent = "  ".repeat(Math.min(match[1].length, 4) - 1);
					const title = match[2].slice(0, OUTLINE_TITLE_CAP);
					out.push(`${i + 1}:\t${indent}${title}`);
				}
			}
			if (total === 0) {
				return textResult(`No markdown headings found in ${file} (${lines.length} lines).`);
			}
			const note =
				out.length < total ? `\n[… ${total - out.length} more headings hidden; raise maxEntries …]` : "";
			return textResult(`${file}: ${total} headings, ${lines.length} lines\n\n${out.join("\n")}${note}`, {
				file,
				headings: total,
			});
		},
	});

	pi.registerTool({
		name: "codex_memory_read",
		label: "Codex memory read",
		description:
			"Read a line range of a Codex memory file, sandboxed to the memory root. Use codex_memory_outline first to pick a range. Read-only.",
		promptSnippet: "Read a line range of a Codex memory file (sandboxed to the memory root).",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		parameters: Type.Object({
			path: Type.String({ description: "File path relative to the memory root, e.g. MEMORY.md" }),
			offset: Type.Optional(Type.Number({ description: "1-based first line (default 1)" })),
			limit: Type.Optional(Type.Number({ description: "Line count (default 400, max 2000)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!rootExists()) return errorResult(`Codex memory root not found: ${config.root}`);
			let lines: string[];
			let rel: string;
			try {
				({ lines, rel } = readMemoryFile(config.root, params.path));
			} catch (error) {
				return errorResult(String(error instanceof Error ? error.message : error));
			}
			const offset = Math.max(Math.trunc(params.offset ?? 1) || 1, 1);
			const limit = Math.min(Math.max(Math.trunc(params.limit ?? 400) || 400, 1), 2000);
			const slice = lines.slice(offset - 1, offset - 1 + limit);
			let text = slice.join("\n");
			if (text.length > READ_CHAR_CAP) {
				const cut = text.slice(0, READ_CHAR_CAP);
				const lastNewline = cut.lastIndexOf("\n");
				text = `${lastNewline > READ_CHAR_CAP * 0.5 ? cut.slice(0, lastNewline) : cut}\n[… truncated at ${READ_CHAR_CAP} chars; continue with a larger offset …]`;
			}
			const header = `# ${rel} (total ${lines.length} lines; showing ${offset}..${Math.min(offset - 1 + slice.length, lines.length)})`;
			return textResult(`${header}\n${text}`, { path: rel, offset, limit, totalLines: lines.length });
		},
	});

	pi.registerTool({
		name: "codex_memory_search",
		label: "Codex memory search",
		description:
			"Search across Codex memory files for a literal substring (default, case-insensitive) or a regex. Returns file:line: text matches. Read-only.",
		promptSnippet: "Search across Codex memory files (MEMORY.md, raw memories, rollout summaries, skysight).",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		parameters: Type.Object({
			pattern: Type.String({ description: "Search text (literal by default, regex when regex=true)" }),
			regex: Type.Optional(Type.Boolean({ description: "Treat pattern as a regular expression (default false)" })),
			caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive matching (default false)" })),
			files: Type.Optional(
				Type.Array(Type.String(), {
					description: "Files or glob patterns relative to the memory root (defaults to the standard memory layout)",
				}),
			),
			maxResults: Type.Optional(Type.Number({ description: "Maximum matches to return (default 50)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!rootExists()) return errorResult(`Codex memory root not found: ${config.root}`);
			const patterns = params.files && params.files.length > 0 ? params.files : DEFAULT_SEARCH_FILES;
			const { rels, missing } = resolveSearchFiles(config.root, patterns);
			if (rels.length === 0) {
				return errorResult(
					`No memory files matched ${JSON.stringify(patterns)}${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`,
				);
			}

			let matcher: (line: string) => boolean;
			if (params.regex) {
				let re: RegExp;
				try {
					re = new RegExp(params.pattern, params.caseSensitive ? "" : "i");
				} catch (error) {
					return errorResult(`Invalid regex: ${String(error instanceof Error ? error.message : error)}`);
				}
				matcher = (line) => re.test(line);
			} else {
				const needle = params.caseSensitive ? params.pattern : params.pattern.toLowerCase();
				matcher = (line) => (params.caseSensitive ? line : line.toLowerCase()).includes(needle);
			}

			const maxResults = Math.min(Math.max(Math.trunc(params.maxResults ?? 50) || 50, 1), 500);
			const out: string[] = [];
			let total = 0;
			const perFile: Record<string, number> = {};
			for (const rel of rels) {
				let content: string;
				try {
					content = readFileSync(join(config.root, rel), "utf8");
				} catch {
					continue;
				}
				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (!matcher(lines[i])) continue;
					total++;
					perFile[rel] = (perFile[rel] ?? 0) + 1;
					if (out.length < maxResults) {
						const text = lines[i].trim().slice(0, SEARCH_LINE_CAP);
						out.push(`${rel}:${i + 1}: ${text}`);
					}
				}
			}
			if (total === 0) {
				return textResult(
					`No matches for ${JSON.stringify(params.pattern)} across ${rels.length} files.\nFiles searched:\n${rels.join("\n")}`,
					{ total: 0, files: rels.length },
				);
			}
			const note = out.length < total ? `\n[… ${total - out.length} more matches hidden; raise maxResults or narrow files …]` : "";
			return textResult(
				`${total} matches across ${rels.length} files (showing ${out.length})\n\n${out.join("\n")}${note}`,
				{ total, shown: out.length, perFile },
			);
		},
	});

	// -- Command ------------------------------------------------------------

	pi.registerCommand("codex-memory", {
		description: "Show the read-only Codex memory bridge status",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			lines.push(`Root: ${config.root}`);
			if (state.available) {
				lines.push(`Available: yes (${state.fileCount} files)`);
				lines.push(
					`Last consolidation: ${state.lastCommit ? `${state.lastCommit.date} — ${state.lastCommit.subject}` : "unknown"}`,
				);
				lines.push(
					`System-prompt injection: ${state.section ? `on (${state.summaryChars} chars)` : "off (budget 0 or summary missing)"}`,
				);
				const keyFiles = ["MEMORY.md", "memory_summary.md", "raw_memories.md"];
				for (const name of keyFiles) {
					const full = join(config.root, name);
					if (existsSync(full)) {
						const st = statSync(full);
						lines.push(`${name}: ${st.size} bytes, modified ${st.mtime.toISOString().slice(0, 16).replace("T", " ")}`);
					}
				}
			} else {
				lines.push(`Available: no — ${state.unavailableReason ?? "unknown reason"}`);
			}
			lines.push(`Tools: codex_memory_summary, codex_memory_outline, codex_memory_read, codex_memory_search`);
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), state.available ? "info" : "warning");
		},
	});
}

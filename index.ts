/**
 * Tail Prompt Extension
 *
 * Injects the configured tail prompts immediately before the latest user
 * message of the provider payload for every LLM call, mirroring the hermes
 * system-prompt plugin: the reminder stays visible in every continuation
 * request of the turn (the anchored user message persists in all of them),
 * never polluting the persisted session history.
 *
 * Placement anchor: the payload's last message is NOT always a user message —
 * after tool execution the array ends with role:"tool" messages that must stay
 * adjacent to the assistant tool_calls message they answer. Inserting at the
 * raw end would break that adjacency (provider 400: "insufficient tool messages
 * following tool_calls message"), so the insert point is the latest user message.
 *
 * Implementation note: the `context` hook's returned messages are NOT used for
 * the final provider payload (verified 2026-08-03 — payload contained only
 * system + user). The `before_provider_request` hook operates on the final
 * payload and its return value replaces it, so injection there is guaranteed to
 * reach the provider. Two provider payload shapes are supported, both anchored
 * to the latest user turn so the reminder stays in the tail-attention window:
 *  - OpenAI-compatible (payload.messages array, no top-level `system`): inject
 *    {role, content} immediately BEFORE the latest user message.
 *  - Anthropic Messages API (top-level `system` + `max_tokens`): inject a
 *    {role:"system"} mid-conversation message immediately AFTER the latest user
 *    turn (Anthropic requires system to follow a user turn, not lead the
 *    array). Claude Sonnet 5 lacks mid-conversation support, so it is skipped.
 * Other provider shapes are skipped untouched.
 *
 * Subagent exclusion: pi-subagents spawns child pi processes that auto-discover
 * this global extension (no --no-extensions by default) and set
 * PI_SUBAGENT_CHILD=1 (pi-args.ts:338). In child processes this extension:
 *  1) skips tail injection (before_provider_request guard), and
 *  2) strips the SYSTEM.md Behavior Contract from the system prompt
 *     (before_agent_start) — SYSTEM.md is loaded unconditionally by pi
 *     core (resource-loader discoverSystemPromptFile) with no CLI switch
 *     to disable it, and its orchestrator identity contradicts the subagent's
 *     to disable it, and its orchestrator identity contradicts the subagent's
 *     implementer role. Both layers stay paired: the main session gets them,
 *     subagents get neither.
 *
 * Configuration: ~/.pi/agent/tail-prompt.yaml
 *   role: system | user        # injected message role (default: system)
 *   imports:                   # name -> relative path (resolved under ~/.pi/agent)
 *     name: system-prompts/xxx.txt
 *   applyment:                 # ordered list of imported names to inject
 *     - name
 *
 * The injected content is assembled once per config change (mtime check). The
 * selfref/role-anchor blocks declare that this text is a reminder, not an
 * override: authority stays in the system prompt (SYSTEM.md).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_DIR = path.join(process.env.HOME || "", ".pi", "agent");
const CONFIG_PATH = path.join(CONFIG_DIR, "tail-prompt.yaml");
const SYSTEM_PATH = path.join(CONFIG_DIR, "SYSTEM.md");

interface TailConfig {
	role: "system" | "user";
	prompts: string[]; // ordered, assembled content blocks
}

/** Minimal YAML-subset parser for the fixed config shape. */
function parseConfig(raw: string): {
	role: "system" | "user";
	imports: Record<string, string>;
	applyment: string[];
} {
	const role: "system" | "user" =
		raw.match(/^role:\s*(\S+)/m)?.[1] === "user" ? "user" : "system";
	const imports: Record<string, string> = {};
	const applyment: string[] = [];
	let section: "imports" | "applyment" | null = null;
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		if (t === "imports:") {
			section = "imports";
			continue;
		}
		if (t === "applyment:") {
			section = "applyment";
			continue;
		}
		if (/^[a-zA-Z0-9_-]+:\s*$/.test(t)) {
			section = null;
			continue;
		}
		if (section === "imports") {
			const m = t.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
			if (m) imports[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
		} else if (section === "applyment") {
			const m = t.match(/^-\s*(.+)$/);
			if (m) applyment.push(m[1].trim());
		}
	}
	return { role, imports, applyment };
}

function loadConfig(): TailConfig | null {
	try {
		if (!fs.existsSync(CONFIG_PATH)) return null;
		const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
		const { role, imports, applyment } = parseConfig(raw);
		const prompts: string[] = [];
		for (const name of applyment) {
			const rel = imports[name];
			if (!rel) continue;
			const p = path.join(CONFIG_DIR, rel);
			if (!fs.existsSync(p)) continue;
			prompts.push(fs.readFileSync(p, "utf-8").trim());
		}
		if (prompts.length === 0) return null;
		return { role, prompts };
	} catch (error) {
		console.warn(`tail-prompt: config load failed: ${error}`);
		return null;
	}
}

/**
 * Insert the tail prompt immediately before the latest user message.
 *
 * Mutates the given payload messages array in place (matching the hook's
 * handling). Returns the array, or null when no user message exists — the
 * caller then leaves the payload untouched.
 */
/**
 * Index of the latest user-role message, or -1 when none exists. Guarded
 * against null/undefined array elements.
 */
function findLatestUserIndex(messages: Array<Record<string, unknown>>): number {
	return messages.findLastIndex((m) => m?.role === "user");
}

/**
 * Insert the tail prompt immediately before the latest user message.
 *
 * Mutates the given payload messages array in place (matching the hook's
 * handling). Returns the array, or null when no user message exists — the
 * caller then leaves the payload untouched. No idempotence guard: a leading
 * system message (the standard OpenAI layout) is legitimate and must not be
 * mistaken for an already-injected reminder; the hook runs once per fresh
 * payload, so double-injection cannot self-occur.
 */
export function injectTailPrompt(
	messages: Array<Record<string, unknown>>,
	content: string,
	role: "system" | "user",
): Array<Record<string, unknown>> | null {
	const lastUserIndex = findLatestUserIndex(messages);
	if (lastUserIndex === -1) return null;
	messages.splice(lastUserIndex, 0, { role, content });
	return messages;
}

/**
 * Detect an Anthropic Messages API payload: it carries a top-level `system`
 * field (OpenAI Chat never does) alongside `max_tokens` and a `messages` array.
 */
export function isAnthropicPayload(payload: Record<string, unknown>): boolean {
	return (
		payload.max_tokens !== undefined &&
		payload.system !== undefined &&
		Array.isArray(payload.messages)
	);
}

/**
 * Claude Sonnet 5 does not support mid-conversation system messages; the
 * extension skips injection for it. Matches ids like "claude-sonnet-5" or
 * "claude-sonnet-5-20260101", never "claude-sonnet-4-5".
 */
export function isSonnet5(model: string): boolean {
	return /sonnet-?5(?:$|[^0-9])/i.test(model);
}

/**
 * Insert the tail prompt as a mid-conversation system message immediately
 * AFTER the latest user turn — Anthropic's placement rule requires a system
 * message to follow a user turn (including one carrying tool_result blocks)
 * and precede an assistant turn or end the array. A system message cannot be
 * the first entry in `messages`; inserting after the first user message yields
 * [user, system], which is allowed. Returns the array, or null when no user
 * message exists.
 */
export function injectAnthropicTail(
	messages: Array<Record<string, unknown>>,
	content: string,
): Array<Record<string, unknown>> | null {
	const lastUserIndex = findLatestUserIndex(messages);
	if (lastUserIndex === -1) return null;
	if (messages[lastUserIndex + 1]?.role === "system") return null; // idempotence
	messages.splice(lastUserIndex + 1, 0, { role: "system", content });
	return messages;
}

/**
 * Route a provider payload through the correct tail-injection adapter.
 *
 * Pure and hook-independent so the full routing (Anthropic dispatch, Sonnet 5
 * skip, OpenAI fallback) is unit-testable without a live event emitter.
 * Returns the (mutated) payload, or undefined when nothing should be sent
 * back as a replacement (the handler then leaves the payload untouched).
 */
export function applyTailToPayload(
	payload: Record<string, unknown>,
	content: string,
	role: "system" | "user",
): Record<string, unknown> | undefined {
	const messages = payload.messages;
	if (!Array.isArray(messages)) return undefined;
	const arr = messages as Array<Record<string, unknown>>;
	if (isAnthropicPayload(payload)) {
		// Claude Sonnet 5 does not support mid-conversation system messages; skip.
		if (isSonnet5(String(payload.model ?? ""))) return undefined;
		if (!injectAnthropicTail(arr, content)) return undefined;
	} else {
		if (!injectTailPrompt(arr, content, role)) return undefined;
	}
	return payload;
}
export default function (pi: ExtensionAPI) {
	let cache: { config: TailConfig | null; key: string } | null = null;

	const getConfig = (): TailConfig | null => {
		let mtimeMs = 0;
		let size = -1;
		try {
			const st = fs.statSync(CONFIG_PATH);
			mtimeMs = st.mtimeMs;
			size = st.size;
		} catch {
			/* no config file yet */
		}
		const key = `${mtimeMs}:${size}`;
		if (!cache || cache.key !== key) {
			cache = { config: loadConfig(), key };
		}
		return cache.config;
	};

	pi.on("before_agent_start", (event) => {
		if (!process.env.PI_SUBAGENT_CHILD) return; // main session: keep Behavior Contract
		let appendContent: string;
		try {
			appendContent = fs.readFileSync(SYSTEM_PATH, "utf-8").trim();
		} catch {
			return; // no SYSTEM.md to strip
		}
		if (!appendContent || !event.systemPrompt.includes(appendContent)) return; // fail-safe: no match, leave as-is
		return {
			systemPrompt: event.systemPrompt.replace(appendContent, ""),
		};
	});

	pi.on("before_provider_request", (event) => {
		if (process.env.PI_SUBAGENT_CHILD) return; // subagent processes: no tail injection
		const config = getConfig();
		if (!config) return;
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload) return;
		return applyTailToPayload(
			payload,
			config.prompts.join("\n\n"),
			config.role,
		);
	});
}

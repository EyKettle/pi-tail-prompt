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
 * reach the provider. Three provider payload shapes are supported, all anchored
 * to the latest user turn so the reminder stays in the tail-attention window:
 *  - OpenAI-compatible Chat (payload.messages array, no top-level `system`):
 *    inject {role, content} immediately BEFORE the latest user message.
 *  - OpenAI Responses (payload.input array when messages is absent): same
 *    latest-user-before-insert rule as Chat.
 *  - Anthropic Messages API (top-level `system` + `max_tokens`): inject a
 *    {role:"system"} mid-conversation message immediately AFTER the latest user
 *    turn (Anthropic requires system to follow a user turn, not lead the
 *    array). Claude Sonnet 5 lacks mid-conversation support, so it is skipped.
 * Other provider shapes are skipped untouched.
 *
 * Child sessions (PI_SUBAGENT_CHILD): before_agent_start splices the
 * SYSTEM.md Role chapter. Role: heading + following --- + next heading must
 * be # Namespace Registry. Replace-mode inserts the entire spliced contract.
 * Locator failure or leftover parent identity sentences abort the child
 * start. Tail injection uses profiles.subagent.applyment; a missing subagent
 * profile injects nothing.
 *
 * Configuration: ~/.pi/agent/tail-prompt.yaml
 *   role: system | user
 *   imports: name -> relative path (resolved under ~/.pi/agent)
 *   applyment: parent session class list
 *   profiles.subagent.applyment: child session class list
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
const CHILD_ROLE_PATH = path.join(
	CONFIG_DIR,
	"system-prompts",
	"child-role.md",
);
const ROLE_HEADING = "## Role and Capability";
const ROLE_FENCE = "---";
const AFTER_ROLE_HEADING = "# Namespace Registry";
const PARENT_IDENTITY_SENTENCES = [
	"I am an orchestrator, not an implementer.",
	"This agent is an orchestrator, not an implementer.",
] as const;
const CHILD_BOUNDARY_PREFIX = "You are a child subagent";

interface TailConfig {
	role: "system" | "user";
	prompts: string[];
}

export type SessionClass = "main" | "subagent";

export type ParsedTailYaml = {
	role: "system" | "user";
	imports: Record<string, string>;
	applyment: string[];
	subagentApplyment: string[] | undefined;
};

export type RoleSpan = { start: number; end: number };

export function sessionClass(
	env: NodeJS.ProcessEnv = process.env,
): SessionClass {
	return env.PI_SUBAGENT_CHILD ? "subagent" : "main";
}

/** Minimal YAML-subset parser for role, imports, applyment, and profiles.subagent.applyment. */
export function parseConfig(raw: string): ParsedTailYaml {
	const role: "system" | "user" =
		raw.match(/^role:\s*(\S+)/m)?.[1] === "user" ? "user" : "system";
	const imports: Record<string, string> = {};
	const applyment: string[] = [];
	let subagentApplyment: string[] | undefined;
	let section: "imports" | "applyment" | "subagent-applyment" | null = null;
	let inProfiles = false;
	let inSubagent = false;
	for (const line of raw.split("\n")) {
		const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		if (indent === 0) {
			inProfiles = false;
			inSubagent = false;
			if (t === "imports:") {
				section = "imports";
				continue;
			}
			if (t === "applyment:") {
				section = "applyment";
				continue;
			}
			if (t === "profiles:") {
				section = null;
				inProfiles = true;
				continue;
			}
			section = null;
			continue;
		}
		if (
			inProfiles &&
			indent > 0 &&
			t !== "applyment:" &&
			/^[a-zA-Z0-9_-]+:\s*$/.test(t)
		) {
			inSubagent = t === "subagent:";
			section = null;
			continue;
		}
		if (inSubagent && t === "applyment:") {
			section = "subagent-applyment";
			subagentApplyment = [];
			continue;
		}
		if (section === "imports") {
			const m = t.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
			if (m) imports[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
		} else if (section === "applyment") {
			const m = t.match(/^-\s*(.+)$/);
			if (m) applyment.push(m[1].trim());
		} else if (section === "subagent-applyment") {
			const m = t.match(/^-\s*(.+)$/);
			if (m) subagentApplyment?.push(m[1].trim());
		}
	}
	return { role, imports, applyment, subagentApplyment };
}

/** Null means no injection for that session class (fail closed for missing child profile). */
export function applymentForSession(
	parsed: ParsedTailYaml,
	session: SessionClass,
): string[] | null {
	if (session === "subagent") {
		if (parsed.subagentApplyment === undefined) return null;
		return parsed.subagentApplyment.length > 0 ? parsed.subagentApplyment : null;
	}
	return parsed.applyment.length > 0 ? parsed.applyment : null;
}

export function resolveImportPath(
	rel: string,
	configDir: string,
): string | null {
	if (!rel) return null;
	const root = path.resolve(configDir);
	const resolved = path.resolve(root, rel);
	const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
	if (resolved !== root && !resolved.startsWith(prefix)) return null;
	return resolved;
}

export function loadPrompts(
	names: string[],
	imports: Record<string, string>,
	configDir: string = CONFIG_DIR,
): string[] | null {
	const prompts: string[] = [];
	for (const name of names) {
		const rel = imports[name];
		if (!rel) return null;
		const p = resolveImportPath(rel, configDir);
		if (!p || !fs.existsSync(p)) return null;
		prompts.push(fs.readFileSync(p, "utf-8").trim());
	}
	return prompts;
}
function lineStartOffset(text: string, lineIndex: number): number {
	if (lineIndex === 0) return 0;
	let seen = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") {
			seen++;
			if (seen === lineIndex) return i + 1;
		}
	}
	return text.length;
}

/**
 * Role chapter is heading through the following `---` line only when the next
 * ATX heading is `# Namespace Registry`.
 */
export function locateRoleChapter(text: string): RoleSpan | null {
	const lines = text.split("\n");
	const startLine = lines.indexOf(ROLE_HEADING);
	if (startLine === -1) return null;
	let fenceLine = -1;
	for (let i = startLine + 1; i < lines.length; i++) {
		if (lines[i] === ROLE_FENCE) {
			fenceLine = i;
			break;
		}
	}
	if (fenceLine === -1) return null;
	let nextHeading = "";
	for (let i = fenceLine + 1; i < lines.length; i++) {
		if (lines[i].startsWith("#")) {
			nextHeading = lines[i];
			break;
		}
	}
	if (nextHeading !== AFTER_ROLE_HEADING) return null;
	const start = lineStartOffset(text, startLine);
	let end = lineStartOffset(text, fenceLine) + lines[fenceLine].length;
	if (text[end] === "\n") end += 1;
	return { start, end };
}

function replaceSpan(
	text: string,
	span: RoleSpan,
	replacement: string,
): string {
	const body = replacement.endsWith("\n") ? replacement : `${replacement}\n`;
	return `${text.slice(0, span.start)}${body}${text.slice(span.end)}`;
}

function assertNoParentIdentity(text: string): void {
	for (const sentence of PARENT_IDENTITY_SENTENCES) {
		if (text.includes(sentence)) {
			throw new Error(
				`tail-prompt: child SOUL still contains parent identity: ${sentence}`,
			);
		}
	}
}

function spliceFoundIdentity(text: string, childRole: string): string {
	const roleSpan = locateRoleChapter(text);
	let result = text;
	if (roleSpan) {
		result = replaceSpan(result, roleSpan, childRole);
	}
	assertNoParentIdentity(result);
	return result;
}

function spliceDiskIdentity(systemMd: string, childRole: string): string {
	if (!locateRoleChapter(systemMd)) {
		throw new Error(
			"tail-prompt: Role chapter locator failed in SYSTEM.md (need ## Role and Capability, ---, then # Namespace Registry)",
		);
	}
	return spliceFoundIdentity(systemMd, childRole);
}

export function insertAfterChildBoundary(
	prompt: string,
	contract: string,
): string {
	const block = contract.trimEnd();
	if (!prompt.startsWith(CHILD_BOUNDARY_PREFIX)) {
		return prompt.length === 0 ? `${block}\n` : `${block}\n\n${prompt}`;
	}
	const sep = prompt.indexOf("\n\n");
	if (sep === -1) return `${prompt}\n\n${block}\n`;
	return `${prompt.slice(0, sep)}\n\n${block}\n\n${prompt.slice(sep + 2)}`;
}

/**
 * Child system-prompt splice. Throws if the SYSTEM.md Role locator fails, or
 * if parent identity sentences remain after splice.
 * Append path: Role chapter present with valid locator → replace the Role
 * span on the prompt. Replace path: no locatable Role chapter → insert
 * entire spliced SYSTEM.md.
 */
export function applyChildSystemPrompt(
	prompt: string,
	systemMd: string,
	childRole: string,
): string {
	const splicedContract = spliceDiskIdentity(systemMd, childRole);
	const promptRole = locateRoleChapter(prompt);
	if (promptRole || prompt.includes(childRole.trim())) {
		return spliceFoundIdentity(prompt, childRole);
	}
	const inserted = insertAfterChildBoundary(prompt, splicedContract);
	assertNoParentIdentity(inserted);
	return inserted;
}

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
 * skip, Chat messages, Responses input) is unit-testable without a live event
 * emitter. Returns the (mutated) payload, or undefined when nothing should be
 * sent back as a replacement (the handler then leaves the payload untouched).
 */
export function applyTailToPayload(
	payload: Record<string, unknown>,
	content: string,
	role: "system" | "user",
): Record<string, unknown> | undefined {
	const messages = payload.messages;
	if (Array.isArray(messages)) {
		const arr = messages as Array<Record<string, unknown>>;
		if (isAnthropicPayload(payload)) {
			// Claude Sonnet 5 does not support mid-conversation system messages; skip.
			if (isSonnet5(String(payload.model ?? ""))) return undefined;
			if (!injectAnthropicTail(arr, content)) return undefined;
		} else if (!injectTailPrompt(arr, content, role)) return undefined;
		return payload;
	}
	const input = payload.input;
	if (Array.isArray(input)) {
		const arr = input as Array<Record<string, unknown>>;
		if (!injectTailPrompt(arr, content, role)) return undefined;
		return payload;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let cache: { parsed: ParsedTailYaml | null; key: string } | null = null;

	const getParsed = (): ParsedTailYaml | null => {
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
			let parsed: ParsedTailYaml | null = null;
			try {
				if (fs.existsSync(CONFIG_PATH)) {
					parsed = parseConfig(fs.readFileSync(CONFIG_PATH, "utf-8"));
				}
			} catch (error) {
				console.warn(`tail-prompt: config load failed: ${error}`);
			}
			cache = { parsed, key };
		}
		return cache.parsed;
	};

	const getConfig = (): TailConfig | null => {
		const parsed = getParsed();
		if (!parsed) return null;
		const names = applymentForSession(parsed, sessionClass());
		if (!names) return null;
		const prompts = loadPrompts(names, parsed.imports);
		if (!prompts) return null;
		return { role: parsed.role, prompts };
	};

	pi.on("before_agent_start", (event) => {
		if (sessionClass() !== "subagent") return;
		let systemMd: string;
		let childRole: string;
		try {
			systemMd = fs.readFileSync(SYSTEM_PATH, "utf-8");
			childRole = fs.readFileSync(CHILD_ROLE_PATH, "utf-8");
		} catch (error) {
			throw new Error(
				`tail-prompt: child identity splice requires SYSTEM.md and child-role.md: ${error}`,
			);
		}
		const next = applyChildSystemPrompt(event.systemPrompt, systemMd, childRole);
		if (next === event.systemPrompt) return;
		return { systemPrompt: next };
	});

	pi.on("before_provider_request", (event) => {
		const config = getConfig();
		if (!config) return;
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload) return;
		return applyTailToPayload(payload, config.prompts.join("\n\n"), config.role);
	});
}

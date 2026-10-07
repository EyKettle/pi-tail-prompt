/**
 * Tail-prompt configuration — a minimal parser for the `tail-prompt.yaml`
 * subset the extension uses: `role`, `imports`, `applyment`, and
 * `profiles.subagent.applyment`.
 *
 * Parsing fails closed: an unknown `role` value is rejected rather than
 * silently defaulted to `system`. Session selection (which applyment list
 * applies to which session) lives in session.ts, its own change driver.
 */

import * as fs from "node:fs";

export type ParsedTailYaml = {
	role: "system" | "user";
	imports: Record<string, string>;
	applyment: string[];
	subagentApplyment: string[] | undefined;
};

/** Remove a trailing `#` comment; a `#` at line start or after whitespace starts one. */
function stripComment(line: string): string {
	const hash = line.indexOf("#");
	if (hash === -1) return line;
	if (hash === 0 || /\s/.test(line[hash - 1] ?? "")) return line.slice(0, hash);
	return line;
}

/** The declared `role`, or the default `system`; any other value is rejected. */
function parseRole(lines: readonly string[]): "system" | "user" {
	for (const line of lines) {
		const value = line.match(/^role:\s*(\S+)/)?.[1];
		if (value === undefined) continue;
		if (value === "user" || value === "system") return value;
		throw new Error(`unknown role '${value}': expected 'system' or 'user'`);
	}
	return "system";
}

function parseImportsEntry(line: string): [string, string] | null {
	const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
	if (!m) return null;
	return [m[1], m[2].trim().replace(/^['"]|['"]$/g, "")];
}

function parseListItem(line: string): string | null {
	const m = line.match(/^-\s*(.+)$/);
	return m ? m[1].trim() : null;
}

/** Minimal parser for role, imports, applyment, and profiles.subagent.applyment. */
export function parseConfig(raw: string): ParsedTailYaml {
	const lines = raw.split("\n").map(stripComment);
	const imports: Record<string, string> = {};
	const applyment: string[] = [];
	let subagentList: string[] | null = null;
	let inImports = false;
	// The list a `- item` line appends to; cleared by any key line so a sibling
	// profile's items never leak into the previous profile's list.
	let listTarget: string[] | null = null;
	let inProfiles = false;
	let inSubagent = false;

	for (const source of lines) {
		const line = source.trim();
		if (!line) continue;
		const indent = source.length - source.trimStart().length;

		if (indent === 0) {
			inProfiles = line === "profiles:";
			inSubagent = false;
			inImports = !inProfiles && line === "imports:";
			listTarget = !inProfiles && !inImports && line === "applyment:" ? applyment : null;
			continue;
		}

		if (inProfiles && line !== "applyment:") {
			const profile = line.match(/^([a-zA-Z0-9_-]+):\s*$/);
			if (profile) {
				inSubagent = profile[1] === "subagent";
				listTarget = null;
				continue;
			}
		}

		if (inSubagent && line === "applyment:") {
			subagentList = [];
			listTarget = subagentList;
			continue;
		}

		if (inImports) {
			const entry = parseImportsEntry(line);
			if (entry) imports[entry[0]] = entry[1];
		} else if (listTarget) {
			const item = parseListItem(line);
			if (item) listTarget.push(item);
		}
	}

	return {
		role: parseRole(lines),
		imports,
		applyment,
		subagentApplyment: subagentList ?? undefined,
	};
}

let cache: { key: string; parsed: ParsedTailYaml | null } | null = null;

/** Read and parse the config file, re-parsing only when its path, mtime, or size changes. */
export function readConfig(configPath: string): ParsedTailYaml | null {
	let mtimeMs = 0;
	let size = -1;
	try {
		const st = fs.statSync(configPath);
		mtimeMs = st.mtimeMs;
		size = st.size;
	} catch {
		/* no config file yet */
	}
	const key = `${configPath}:${mtimeMs}:${size}`;
	if (cache && cache.key === key) return cache.parsed;
	let parsed: ParsedTailYaml | null = null;
	try {
		if (fs.existsSync(configPath)) {
			parsed = parseConfig(fs.readFileSync(configPath, "utf-8"));
		}
	} catch (error) {
		console.error(`tail-prompt: config load failed: ${error}`);
	}
	cache = { key, parsed };
	return parsed;
}

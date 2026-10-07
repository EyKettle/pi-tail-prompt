/**
 * Tail-prompt configuration — a minimal parser for the `tail-prompt.yaml`
 * subset the extension uses: `role`, `imports`, `applyment`, and
 * `profiles.subagent.applyment`.
 *
 * Parsing fails closed: an unknown `role` value is rejected rather than
 * silently defaulted to `system`. Reading the file and caching the parse live
 * in config-file.ts, its own change driver.
 */

export type ParsedTailYaml = {
	role: "system" | "user";
	imports: Record<string, string>;
	applyment: string[];
	subagentApplyment: string[] | undefined;
};

/** The only profile name the schema recognizes. */
const SUBAGENT_PROFILE = "subagent";

/** Remove a trailing `#` comment; a `#` at line start or after whitespace starts one. */
function stripComment(line: string): string {
	const hash = line.indexOf("#");
	if (hash === -1) return line;
	if (hash === 0 || /\s/.test(line[hash - 1] ?? "")) return line.slice(0, hash);
	return line;
}

/** The declared `role`, read only at the top level; any other value is rejected. */
function parseRole(lines: readonly string[]): "system" | "user" {
	for (const line of lines) {
		if (!line.startsWith("role:")) continue;
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
				// Only `subagent` is a recognized profile name; any other key line
				// resets the state so its contents are ignored.
				inSubagent = profile[1] === SUBAGENT_PROFILE;
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

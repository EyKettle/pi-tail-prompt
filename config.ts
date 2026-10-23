/**
 * Tail-prompt configuration — a minimal parser for the `tail-prompt.yaml`
 * subset the extension uses: `role`, `roleRules`, `imports`, `applyment`, and
 * `profiles.subagent.applyment`.
 *
 * Reading the file and caching the parse live in config-file.ts, its own
 * change driver.
 */

export type Role = "system" | "user";

export type RoleRule = {
	pattern: RegExp;
	role: Role;
};

export type ParsedTailYaml = {
	role: Role;
	roleRules: RoleRule[];
	warnings: string[];
	imports: Record<string, string>;
	applyment: string[];
	subagentApplyment: string[] | undefined;
};

/** The only profile name the schema recognizes. */
const SUBAGENT_PROFILE = "subagent";

const DEFAULT_ROLE: Role = "user";

/** Remove a trailing `#` comment; a `#` at line start or after whitespace starts one. */
function stripComment(line: string): string {
	const hash = line.indexOf("#");
	if (hash === -1) return line;
	if (hash === 0 || /\s/.test(line[hash - 1] ?? "")) return line.slice(0, hash);
	return line;
}

function isRole(value: string): value is Role {
	return value === "system" || value === "user";
}

/** The declared `role`, read only at the top level; any other value is rejected. */
function parseRole(lines: readonly string[]): Role {
	for (const line of lines) {
		if (!line.startsWith("role:")) continue;
		const value = line.match(/^role:\s*(\S+)/)?.[1];
		if (value === undefined) continue;
		if (isRole(value)) return value;
		throw new Error(`unknown role '${value}': expected 'system' or 'user'`);
	}
	return DEFAULT_ROLE;
}

function splitRoleRule(line: string): [string, string] | null {
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (quote !== null) {
			if (char === "\\") {
				i += 1;
				continue;
			}
			if (char === quote) quote = null;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (char === ":" && /\s/.test(line[i + 1] ?? "")) {
			return [line.slice(0, i), line.slice(i + 1)];
		}
	}
	return null;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

type RoleRuleOutcome = { rule: RoleRule } | { warning: string };

function skipRoleRule(position: number, reason: string): RoleRuleOutcome {
	return { warning: `roleRules[${position}] skipped: ${reason}` };
}

function parseRoleRule(line: string, position: number): RoleRuleOutcome {
	const pair = splitRoleRule(line);
	if (!pair) return skipRoleRule(position, 'expected "pattern": role');
	const pattern = unquote(pair[0]);
	if (pattern === "") return skipRoleRule(position, "empty pattern");
	const value = pair[1].trim();
	if (!isRole(value)) return skipRoleRule(position, `unknown role '${value}'`);
	try {
		return { rule: { pattern: new RegExp(pattern), role: value } };
	} catch {
		return skipRoleRule(
			position,
			`invalid regular expression '${pattern}'`,
		);
	}
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

/** Minimal parser for role, roleRules, imports, applyment, and profiles.subagent.applyment. */
export function parseConfig(raw: string): ParsedTailYaml {
	const lines = raw.split("\n").map(stripComment);
	const imports: Record<string, string> = {};
	const applyment: string[] = [];
	const roleRules: RoleRule[] = [];
	const warnings: string[] = [];
	let subagentList: string[] | null = null;
	let inImports = false;
	let inRoleRules = false;
	let roleRulePosition = 0;
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
			inRoleRules = !inProfiles && !inImports && line === "roleRules:";
			listTarget =
				!inProfiles && !inImports && !inRoleRules && line === "applyment:"
					? applyment
					: null;
			continue;
		}

		if (inRoleRules) {
			roleRulePosition += 1;
			const outcome = parseRoleRule(line, roleRulePosition);
			if ("rule" in outcome) roleRules.push(outcome.rule);
			else warnings.push(outcome.warning);
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
		roleRules,
		warnings,
		imports,
		applyment,
		subagentApplyment: subagentList ?? undefined,
	};
}

export function resolveRole(
	config: Pick<ParsedTailYaml, "role" | "roleRules">,
	modelId: string | undefined,
): Role {
	if (modelId !== undefined) {
		for (const rule of config.roleRules) {
			if (rule.pattern.test(modelId)) return rule.role;
		}
	}
	return config.role;
}

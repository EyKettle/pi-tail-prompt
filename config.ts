/**
 * Tail-prompt configuration — a minimal YAML-subset parser for `role`,
 * `imports`, `applyment`, and `profiles.subagent.applyment`, plus the
 * session-class view that selects which applyment list applies.
 */

export type SessionClass = "main" | "subagent";

export type ParsedTailYaml = {
	role: "system" | "user";
	imports: Record<string, string>;
	applyment: string[];
	subagentApplyment: string[] | undefined;
};

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

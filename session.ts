/**
 * Session view — which session class the current process is, and which
 * applyment list that class selects. Kept apart from config.ts so a change to
 * the session trigger or the selection policy does not touch the parser.
 */

import type { ParsedTailYaml } from "./config.ts";

export type SessionClass = "main" | "subagent";

export function sessionClass(
	env: NodeJS.ProcessEnv = process.env,
): SessionClass {
	return env.PI_SUBAGENT_CHILD ? "subagent" : "main";
}

/** Null means no injection for that session class (fail closed for a missing child profile). */
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

/**
 * Prompt loading — resolves applyment names to files under the agent config
 * directory and reads them. Fails closed: an unknown name, an escaping path,
 * or a missing file returns null rather than a partial list.
 */

import * as fs from "node:fs";
import * as path from "node:path";

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
	configDir: string,
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

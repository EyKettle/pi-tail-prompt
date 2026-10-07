/**
 * Prompt loading — resolves applyment names to files under the agent config
 * directory and reads them.
 *
 * Containment is decided on canonical paths: both the root and the target (or
 * its nearest existing ancestor) are `realpath`ed, so a symlink inside the
 * config directory that points outside it is rejected, not merely a lexical
 * `..` escape. Fails closed: an unknown name, an escaping path, or an
 * unreadable file returns null rather than a partial list.
 */

import * as fs from "node:fs";
import * as path from "node:path";

function isNotFound(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Canonicalize `target`, walking up to the nearest existing ancestor when
 * parts of it do not exist yet. Every existing tail component is `lstat`ed: a
 * symlink that `realpath` could not follow (a dangling link) is rejected
 * rather than re-appended unresolved, since following it could escape.
 */
function nearestExistingReal(target: string): string | null {
	let node = target;
	const tail: string[] = [];
	for (;;) {
		let real: string;
		try {
			real = fs.realpathSync(node);
		} catch (error) {
			if (!isNotFound(error)) return null;
			const parent = path.dirname(node);
			if (parent === node) return null;
			tail.push(path.basename(node));
			node = parent;
			continue;
		}
		const ordered = tail.toReversed();
		let probe = node;
		for (const name of ordered) {
			probe = path.join(probe, name);
			try {
				if (fs.lstatSync(probe).isSymbolicLink()) return null;
			} catch (error) {
				if (!isNotFound(error)) return null;
			}
		}
		return ordered.length === 0 ? real : path.join(real, ...ordered);
	}
}

/** Resolve `rel` under `configDir` to a canonical path, or null when it escapes. */
export function resolveImportPath(
	rel: string,
	configDir: string,
): string | null {
	if (!rel || path.isAbsolute(rel)) return null;
	let root: string;
	try {
		root = fs.realpathSync(configDir);
	} catch {
		return null;
	}
	const resolved = nearestExistingReal(path.join(root, rel));
	if (resolved === null) return null;
	if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
	return resolved;
}

/** Resolve every name to its canonical path in order, or null on any failure. */
export function resolvePromptPaths(
	names: string[],
	imports: Record<string, string>,
	configDir: string,
): string[] | null {
	const paths: string[] = [];
	for (const name of names) {
		const rel = imports[name];
		if (!rel) return null;
		const resolved = resolveImportPath(rel, configDir);
		if (!resolved) return null;
		paths.push(resolved);
	}
	return paths;
}

/** Read every already-resolved path in order. Any read failure returns null (fail closed). */
export function loadPrompts(paths: string[]): string[] | null {
	const prompts: string[] = [];
	for (const resolved of paths) {
		let content: string;
		try {
			content = fs.readFileSync(resolved, "utf-8");
		} catch {
			return null;
		}
		prompts.push(content.trim());
	}
	return prompts;
}

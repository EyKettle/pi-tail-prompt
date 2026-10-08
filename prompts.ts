/**
 * Prompt loading — resolves applyment names to files and reads them.
 *
 * A path may be absolute or relative, may leave the config directory, and may
 * be a symlink: like the contract's `path` source, none of that is a privilege
 * boundary, and prompts are legitimately kept elsewhere and linked or named
 * into the agent directory. Reading fails closed per attempt: the first
 * unreadable prompt reports its own path and no partial list is returned.
 */

import * as path from "node:path";
import { materialize } from "./source.ts";

export type PromptFailure =
	| { kind: "unmapped-import"; name: string }
	| { kind: "unreadable-prompt"; path: string };

export type PromptOutcome =
	| { value: string[]; failure?: undefined }
	| { value?: undefined; failure: PromptFailure };

/** Resolve `rel` against `configDir`; an absolute `rel` is taken as it is. */
export function resolveImportPath(rel: string, configDir: string): string {
	return path.isAbsolute(rel) ? rel : path.resolve(configDir, rel);
}

/** Resolve every name in order; an unmapped name reports itself. */
export function resolvePromptPaths(
	names: string[],
	imports: Record<string, string>,
	configDir: string,
): PromptOutcome {
	const paths: string[] = [];
	for (const name of names) {
		const rel = imports[name];
		if (!rel) return { failure: { kind: "unmapped-import", name } };
		paths.push(resolveImportPath(rel, configDir));
	}
	return { value: paths };
}

/** Read every resolved path in order; the first unreadable one reports itself. */
export function loadPrompts(paths: string[]): PromptOutcome {
	const prompts: string[] = [];
	for (const resolved of paths) {
		const text = materialize({ kind: "path", path: resolved });
		if (text === null) {
			return { failure: { kind: "unreadable-prompt", path: resolved } };
		}
		prompts.push(text);
	}
	return { value: prompts };
}

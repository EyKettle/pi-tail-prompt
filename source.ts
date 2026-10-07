/**
 * Segment sources — a source is either an absolute `path`, re-read whenever the
 * block is assembled, or a `text` value supplied by its contributor.
 *
 * The reader lives here so the contract's two source kinds have exactly one
 * implementation, shared by the configured prompts and every `path` segment.
 */

import * as fs from "node:fs";

export type Source =
	| { kind: "path"; path: string }
	| { kind: "text"; text: string };

/** Materialize a source: read an absolute path, or return the text. Null when unavailable. */
export function materialize(source: Source): string | null {
	if (source.kind === "text") return source.text;
	try {
		return fs.readFileSync(source.path, "utf-8").trim();
	} catch {
		return null;
	}
}

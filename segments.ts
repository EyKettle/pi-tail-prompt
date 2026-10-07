/**
 * Segment registry — the tail block is assembled from ordered segments.
 *
 * A segment is `{ id, position, source }`; `source` is either a `path` (an
 * absolute path re-read on every assembly) or a `text` value. Segments are
 * ordered by `position` descending, then `id` ascending, and their materialized
 * texts are joined by a blank line. A segment whose source cannot be read this
 * time is dropped alone; the rest still deliver.
 *
 * The published contract lives in `docs_zh-CN/api.md`; validation here is its
 * fail-closed implementation.
 */

import * as path from "node:path";
import { materialize, type Source } from "./source.ts";

/** The identifier tail-prompt reserves for its own configured prompts. */
export const RESERVED_SEGMENT_ID = "tail-prompt";

export type Segment = {
	id: string;
	position: number;
	source: Source;
};

/**
 * Validate an inbound registration against the published contract. Returns the
 * normalized segment, or null when any clause fails.
 */
export function validateSegment(raw: unknown): Segment | null {
	if (typeof raw !== "object" || raw === null) return null;
	const candidate = raw as Record<string, unknown>;
	if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
	if (candidate.id === RESERVED_SEGMENT_ID) return null;
	if (
		typeof candidate.position !== "number" ||
		!Number.isInteger(candidate.position)
	) {
		return null;
	}
	const source = candidate.source;
	if (typeof source !== "object" || source === null) return null;
	const { kind } = source as Record<string, unknown>;
	if (kind === "text") {
		const { text } = source as Record<string, unknown>;
		if (typeof text !== "string") return null;
		return {
			id: candidate.id,
			position: candidate.position,
			source: { kind: "text", text },
		};
	}
	if (kind === "path") {
		const { path: filePath } = source as Record<string, unknown>;
		if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return null;
		return {
			id: candidate.id,
			position: candidate.position,
			source: { kind: "path", path: filePath },
		};
	}
	return null;
}

/** A stable identity for a raw registration, so a rejection is reported once. */
export function fingerprint(raw: unknown): string {
	try {
		return JSON.stringify(raw);
	} catch {
		return String(raw);
	}
}

function compare(a: Segment, b: Segment): number {
	if (a.position !== b.position) return b.position - a.position;
	if (a.id < b.id) return -1;
	if (a.id > b.id) return 1;
	return 0;
}

export class SegmentRegistry {
	private readonly segments = new Map<string, Segment>();

	/** Register or replace a segment by identifier. */
	register(segment: Segment): void {
		this.segments.set(segment.id, segment);
	}

	/**
	 * Assemble the block from every registered segment plus `extra`, ordered by
	 * position descending then id ascending. A segment with no materializable
	 * text is dropped alone. Returns null when nothing contributes.
	 */
	assemble(extra: readonly Segment[] = []): string | null {
		const ordered = [...this.segments.values(), ...extra].sort(compare);
		const parts: string[] = [];
		for (const segment of ordered) {
			const text = materialize(segment.source);
			if (text === null || text === "") continue;
			parts.push(text);
		}
		return parts.length > 0 ? parts.join("\n\n") : null;
	}
}

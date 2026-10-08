/**
 * Configuration failures — why a present configuration produced no block.
 *
 * Only failures that a user can act on are represented; a configuration file
 * that does not exist is not a failure. Each cause carries the material the
 * message needs, and a stable key so it is reported once.
 */

export type BlockFailure =
	| { kind: "parse"; detail: string }
	| { kind: "empty-applyment" }
	| { kind: "unmapped-import"; name: string }
	| { kind: "unreadable-prompt"; path: string };

/** The user-facing message for a failure. */
export function failureMessage(failure: BlockFailure): string {
	switch (failure.kind) {
		case "parse":
			return `tail-prompt: tail-prompt.yaml could not be parsed (${failure.detail})`;
		case "empty-applyment":
			return "tail-prompt: no prompts apply to this session";
		case "unmapped-import":
			return `tail-prompt: import '${failure.name}' has no path`;
		case "unreadable-prompt":
			return `tail-prompt: prompt '${failure.path}' could not be read`;
	}
}

/** A stable identity for a failure, so it is reported once. */
export function failureKey(failure: BlockFailure): string {
	return failure.kind === "parse"
		? `parse:${failure.detail}`
		: JSON.stringify(failure);
}

/**
 * Child identity splice — replaces the SYSTEM.md Role chapter in a child
 * system prompt. The Role chapter is `## Role and Capability` through the
 * following `---` line, valid only when the next ATX heading is
 * `# Namespace Registry`. A locator failure, or a parent identity sentence
 * remaining after the splice, aborts the child start.
 */

const ROLE_HEADING = "## Role and Capability";
const ROLE_FENCE = "---";
const AFTER_ROLE_HEADING = "# Namespace Registry";
const PARENT_IDENTITY_SENTENCES = [
	"I am an orchestrator, not an implementer.",
	"This agent is an orchestrator, not an implementer.",
] as const;
const CHILD_BOUNDARY_PREFIX = "You are a child subagent";

export type RoleSpan = { start: number; end: number };

function lineStartOffset(text: string, lineIndex: number): number {
	if (lineIndex === 0) return 0;
	let seen = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") {
			seen++;
			if (seen === lineIndex) return i + 1;
		}
	}
	return text.length;
}

/**
 * Role chapter is heading through the following `---` line only when the next
 * ATX heading is `# Namespace Registry`.
 */
export function locateRoleChapter(text: string): RoleSpan | null {
	const lines = text.split("\n");
	const startLine = lines.indexOf(ROLE_HEADING);
	if (startLine === -1) return null;
	let fenceLine = -1;
	for (let i = startLine + 1; i < lines.length; i++) {
		if (lines[i] === ROLE_FENCE) {
			fenceLine = i;
			break;
		}
	}
	if (fenceLine === -1) return null;
	let nextHeading = "";
	for (let i = fenceLine + 1; i < lines.length; i++) {
		if (lines[i].startsWith("#")) {
			nextHeading = lines[i];
			break;
		}
	}
	if (nextHeading !== AFTER_ROLE_HEADING) return null;
	const start = lineStartOffset(text, startLine);
	let end = lineStartOffset(text, fenceLine) + lines[fenceLine].length;
	if (text[end] === "\n") end += 1;
	return { start, end };
}

function replaceSpan(
	text: string,
	span: RoleSpan,
	replacement: string,
): string {
	const body = replacement.endsWith("\n") ? replacement : `${replacement}\n`;
	return `${text.slice(0, span.start)}${body}${text.slice(span.end)}`;
}

function assertNoParentIdentity(text: string): void {
	for (const sentence of PARENT_IDENTITY_SENTENCES) {
		if (text.includes(sentence)) {
			throw new Error(
				`tail-prompt: child SOUL still contains parent identity: ${sentence}`,
			);
		}
	}
}

function spliceFoundIdentity(text: string, childRole: string): string {
	const roleSpan = locateRoleChapter(text);
	let result = text;
	if (roleSpan) {
		result = replaceSpan(result, roleSpan, childRole);
	}
	assertNoParentIdentity(result);
	return result;
}

function spliceDiskIdentity(systemMd: string, childRole: string): string {
	if (!locateRoleChapter(systemMd)) {
		throw new Error(
			"tail-prompt: Role chapter locator failed in SYSTEM.md (need ## Role and Capability, ---, then # Namespace Registry)",
		);
	}
	return spliceFoundIdentity(systemMd, childRole);
}

export function insertAfterChildBoundary(
	prompt: string,
	contract: string,
): string {
	const block = contract.trimEnd();
	if (!prompt.startsWith(CHILD_BOUNDARY_PREFIX)) {
		return prompt.length === 0 ? `${block}\n` : `${block}\n\n${prompt}`;
	}
	const sep = prompt.indexOf("\n\n");
	if (sep === -1) return `${prompt}\n\n${block}\n`;
	return `${prompt.slice(0, sep)}\n\n${block}\n\n${prompt.slice(sep + 2)}`;
}

/**
 * Child system-prompt splice. Throws if the SYSTEM.md Role locator fails, or
 * if parent identity sentences remain after splice.
 * Append path: Role chapter present with valid locator → replace the Role
 * span on the prompt. Replace path: no locatable Role chapter → insert
 * entire spliced SYSTEM.md.
 */
export function applyChildSystemPrompt(
	prompt: string,
	systemMd: string,
	childRole: string,
): string {
	const splicedContract = spliceDiskIdentity(systemMd, childRole);
	const promptRole = locateRoleChapter(prompt);
	if (promptRole || prompt.includes(childRole.trim())) {
		return spliceFoundIdentity(prompt, childRole);
	}
	const inserted = insertAfterChildBoundary(prompt, splicedContract);
	assertNoParentIdentity(inserted);
	return inserted;
}

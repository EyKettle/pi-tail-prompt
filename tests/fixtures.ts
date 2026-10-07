/** Shared config fixtures, so the profile YAML is written once. */

export const PROFILE_YAML = [
	"role: system",
	"imports:",
	"  decompose: system-prompts/decompose-thinking.txt",
	"  contract: system-prompts/working-contract.txt",
	"  child-contract: system-prompts/child-working-contract.txt",
	"applyment:",
	"  - decompose",
	"  - contract",
	"profiles:",
	"  subagent:",
	"    applyment:",
	"      - decompose",
	"      - child-contract",
	"",
].join("\n");

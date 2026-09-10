/**
 * Tail Prompt Extension — entry assembly.
 *
 * Injects the configured tail prompts immediately before the latest user
 * message of the provider payload for every LLM call, mirroring the hermes
 * system-prompt plugin: the reminder stays visible in every continuation
 * request of the turn (the anchored user message persists in all of them),
 * never polluting the persisted session history.
 *
 * The `context` hook's returned messages are NOT used for the final provider
 * payload (verified 2026-08-03 — payload contained only system + user). The
 * `before_provider_request` hook operates on the final payload and its return
 * value replaces it, so injection there is guaranteed to reach the provider.
 * Provider routing lives in payload.ts.
 *
 * Child sessions (PI_SUBAGENT_CHILD): before_agent_start splices the SYSTEM.md
 * Role chapter (identity.ts). Tail injection uses profiles.subagent.applyment;
 * a missing subagent profile injects nothing.
 *
 * Configuration: ~/.pi/agent/tail-prompt.yaml (parsed in config.ts; prompts
 * loaded in prompts.ts). The injected content is assembled once per config
 * change (mtime check). Authority stays in the system prompt (SYSTEM.md).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applymentForSession,
	parseConfig,
	sessionClass,
	type ParsedTailYaml,
} from "./config.ts";
import { applyChildSystemPrompt } from "./identity.ts";
import { applyTailToPayload } from "./payload.ts";
import { loadPrompts } from "./prompts.ts";

const AGENT_DIR = path.join(process.env.HOME || "", ".pi", "agent");
const CONFIG_PATH = path.join(AGENT_DIR, "tail-prompt.yaml");
const SYSTEM_PATH = path.join(AGENT_DIR, "SYSTEM.md");
const CHILD_ROLE_PATH = path.join(
	AGENT_DIR,
	"system-prompts",
	"child-role.md",
);

interface TailConfig {
	role: "system" | "user";
	prompts: string[];
}

export default function (pi: ExtensionAPI) {
	let cache: { parsed: ParsedTailYaml | null; key: string } | null = null;

	const getParsed = (): ParsedTailYaml | null => {
		let mtimeMs = 0;
		let size = -1;
		try {
			const st = fs.statSync(CONFIG_PATH);
			mtimeMs = st.mtimeMs;
			size = st.size;
		} catch {
			/* no config file yet */
		}
		const key = `${mtimeMs}:${size}`;
		if (!cache || cache.key !== key) {
			let parsed: ParsedTailYaml | null = null;
			try {
				if (fs.existsSync(CONFIG_PATH)) {
					parsed = parseConfig(fs.readFileSync(CONFIG_PATH, "utf-8"));
				}
			} catch (error) {
				console.warn(`tail-prompt: config load failed: ${error}`);
			}
			cache = { parsed, key };
		}
		return cache.parsed;
	};

	const getConfig = (): TailConfig | null => {
		const parsed = getParsed();
		if (!parsed) return null;
		const names = applymentForSession(parsed, sessionClass());
		if (!names) return null;
		const prompts = loadPrompts(names, parsed.imports, AGENT_DIR);
		if (!prompts) return null;
		return { role: parsed.role, prompts };
	};

	pi.on("before_agent_start", (event) => {
		if (sessionClass() !== "subagent") return;
		let systemMd: string;
		let childRole: string;
		try {
			systemMd = fs.readFileSync(SYSTEM_PATH, "utf-8");
			childRole = fs.readFileSync(CHILD_ROLE_PATH, "utf-8");
		} catch (error) {
			throw new Error(
				`tail-prompt: child identity splice requires SYSTEM.md and child-role.md: ${error}`,
			);
		}
		const next = applyChildSystemPrompt(event.systemPrompt, systemMd, childRole);
		if (next === event.systemPrompt) return;
		return { systemPrompt: next };
	});

	pi.on("before_provider_request", (event) => {
		const config = getConfig();
		if (!config) return;
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload) return;
		return applyTailToPayload(payload, config.prompts.join("\n\n"), config.role);
	});
}

/**
 * Tail Prompt Extension — entry assembly.
 *
 * Delivers the assembled tail block on every provider request through exactly
 * one placement, chosen from the model's declared capability:
 *
 *  - The model declares mid-conversation system messages
 *    (`compat.supportsMidConvoSystemMessages`): the block is inserted into the
 *    final payload adjacent to the latest user turn.
 *  - Otherwise: the block is appended as a request-local system message and Pi
 *    folds it into the leading system prompt.
 *
 * The block is assembled from ordered segments (segments.ts): tail-prompt's own
 * configured prompts at position 0, plus every segment another extension
 * registers through the published contract (docs_zh-CN/api.md) on `pi.events`.
 * The block never enters the persisted session history. Configuration lives at
 * `<agent dir>/tail-prompt.yaml`, where the agent directory comes from Pi's own
 * `getAgentDir()`; the assembled block is cached by the config file's stamp and
 * every prompt file's stamp.
 */

import * as path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { ParsedTailYaml } from "./config.ts";
import {
	createConfigReader,
	fileStamp,
	type ConfigRead,
} from "./config-file.ts";
import { applyTailToPayload } from "./payload.ts";
import { loadPrompts, resolvePromptPaths } from "./prompts.ts";
import {
	RESERVED_SEGMENT_ID,
	SegmentRegistry,
	fingerprint,
	validateSegment,
	type Segment,
} from "./segments.ts";
import {
	applymentForSession,
	sessionClass,
	type SessionClass,
} from "./session.ts";

const CONFIG_POSITION = 0;
const REGISTER_CHANNEL = "tail-prompt:register";
const READY_CHANNEL = "tail-prompt:ready";
/** How many distinct rejected registrations the report-once rule remembers. */
const REJECTED_LIMIT = 64;

export interface TailConfig {
	role: "system" | "user";
	block: string;
}

interface ModelView {
	compat?: unknown;
	api?: unknown;
}

/** The pieces the block loader reads through, so it can be exercised directly. */
export interface BlockLoaderDeps {
	readConfig: () => ConfigRead;
	session: () => SessionClass;
	applyment: (parsed: ParsedTailYaml, session: SessionClass) => string[] | null;
	resolvePaths: (
		names: string[],
		imports: Record<string, string>,
		configDir: string,
	) => string[] | null;
	readPrompts: (paths: string[]) => string[] | null;
	fileStamp: (filePath: string) => string;
}

/** The cache key: the config file's stamp plus every prompt file's stamp. */
export function blockKey(
	configStamp: string,
	promptPaths: readonly string[],
	stamp: (filePath: string) => string,
): string {
	return [configStamp, ...promptPaths.map((p) => stamp(p))].join("|");
}

/** The configured prompts as the position-0 segment. */
export function configSegment(block: string): Segment {
	return {
		id: RESERVED_SEGMENT_ID,
		position: CONFIG_POSITION,
		source: { kind: "text", text: block },
	};
}

/**
 * A loader for the configured block, cached by the config and prompt files'
 * stamps. Returns null whenever any input is missing (fail closed).
 */
export function createBlockLoader(
	deps: BlockLoaderDeps,
	agentDir: string,
): () => TailConfig | null {
	let cache: { key: string; config: TailConfig | null } | null = null;
	const miss = (): null => {
		cache = null;
		return null;
	};
	return () => {
		const { parsed, stamp } = deps.readConfig();
		if (!parsed) return miss();
		const names = deps.applyment(parsed, deps.session());
		if (!names) return miss();
		const paths = deps.resolvePaths(names, parsed.imports, agentDir);
		if (!paths) return miss();
		const key = blockKey(stamp, paths, deps.fileStamp);
		if (cache && cache.key === key) return cache.config;
		const prompts = deps.readPrompts(paths);
		const config = prompts
			? { role: parsed.role, block: prompts.join("\n\n") }
			: null;
		cache = { key, config };
		return config;
	};
}

/** The delivered block and its role, or null when nothing contributes. */
export function buildBlock(
	load: () => TailConfig | null,
	registry: SegmentRegistry,
): { block: string; role: "system" | "user" } | null {
	const config = load();
	if (!config) return null;
	const block = registry.assemble([configSegment(config.block)]);
	if (block === null) return null;
	return { block, role: config.role };
}

function supportsMidConvoSystemMessages(model: ModelView | undefined): boolean {
	const compat = model?.compat as
		| { supportsMidConvoSystemMessages?: boolean }
		| undefined;
	return compat?.supportsMidConvoSystemMessages === true;
}

function modelApi(model: ModelView | undefined): string | undefined {
	return model?.api === undefined ? undefined : String(model.api);
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const registry = new SegmentRegistry();
	const rejected = new Set<string>();

	const load = createBlockLoader(
		{
			readConfig: createConfigReader(path.join(agentDir, "tail-prompt.yaml")),
			session: sessionClass,
			applyment: applymentForSession,
			resolvePaths: resolvePromptPaths,
			readPrompts: loadPrompts,
			fileStamp,
		},
		agentDir,
	);

	pi.events.on(REGISTER_CHANNEL, (raw) => {
		const segment = validateSegment(raw);
		if (segment) {
			registry.register(segment);
			return;
		}
		const key = fingerprint(raw);
		if (rejected.has(key)) return;
		rejected.add(key);
		if (rejected.size > REJECTED_LIMIT) {
			const oldest = rejected.values().next().value;
			if (oldest !== undefined) rejected.delete(oldest);
		}
		throw new Error(`tail-prompt: rejected registration ${key}`);
	});

	// A contributor that loaded before this extension missed its own emit; the
	// ready signal asks it to re-send, so either load order takes effect.
	pi.events.emit(READY_CHANNEL, undefined);

	// Merge branch: the model cannot carry a mid-conversation system message, so
	// append one to the transcript and let Pi fold it into the leading prompt.
	pi.on("context_with_system", (event, ctx) => {
		if (supportsMidConvoSystemMessages(ctx.model)) return;
		const built = buildBlock(load, registry);
		if (!built) return;
		return {
			messages: [
				...event.messages,
				{ role: "system", content: built.block, timestamp: Date.now() },
			],
		};
	});

	// Tail branch: the model carries mid-conversation system messages, so insert
	// the block into the final payload adjacent to the latest user turn.
	pi.on("before_provider_request", (event, ctx) => {
		if (!supportsMidConvoSystemMessages(ctx.model)) return;
		const built = buildBlock(load, registry);
		if (!built) return;
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload) return;
		return applyTailToPayload(
			payload,
			built.block,
			built.role,
			modelApi(ctx.model),
		);
	});
}

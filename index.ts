/**
 * Tail Prompt Extension — entry assembly.
 *
 * Delivers the assembled tail block on every provider request through exactly
 * one placement: the payload tail when insertion is legal, the leading prompt
 * otherwise (see usesMergeBranch). A configuration that exists but yields no
 * block is reported once through Pi's UI, and a rejected registration is
 * reported the same way.
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
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ParsedTailYaml } from "./config.ts";
import {
	createConfigReader,
	fileStamp,
	type ConfigRead,
} from "./config-file.ts";
import { failureKey, failureMessage, type BlockFailure } from "./failure.ts";
import {
	applyTailToPayload,
	mergeBlockIntoLeadingSystem,
} from "./payload.ts";
import {
	loadPrompts,
	resolvePromptPaths,
	type PromptOutcome,
} from "./prompts.ts";
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
/** How many distinct reports the report-once rule remembers. */
const REPORTED_LIMIT = 64;

export interface TailConfig {
	role: "system" | "user";
	block: string;
}

export type LoadResult = {
	config: TailConfig | null;
	/** The cause when a present config yields no block; null when there is nothing to inject. */
	failure: BlockFailure | null;
};

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
	) => PromptOutcome;
	readPrompts: (paths: string[]) => PromptOutcome;
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
 * stamps. A missing config file is not a failure; a config that exists and
 * yields no block carries its cause.
 */
export function createBlockLoader(
	deps: BlockLoaderDeps,
	agentDir: string,
): () => LoadResult {
	let cache: { key: string; result: LoadResult } | null = null;
	return () => {
		const { parsed, stamp, error } = deps.readConfig();
		const configKey = `cfg:${stamp}`;
		const remember = (key: string, failure: BlockFailure | null): LoadResult => {
			const result: LoadResult = { config: null, failure };
			cache = { key, result };
			return result;
		};
		// Only a config-file-level failure short-circuits: a prompt-level one
		// must re-evaluate when the prompt file changes.
		if (cache && cache.key === configKey) return cache.result;
		if (!parsed) {
			return remember(
				configKey,
				error === null ? null : { kind: "parse", detail: error },
			);
		}
		const names = deps.applyment(parsed, deps.session());
		if (!names) return remember(configKey, { kind: "empty-applyment" });
		const resolved = deps.resolvePaths(names, parsed.imports, agentDir);
		if (resolved.failure) {
			return remember(
				`${configKey}:${JSON.stringify(resolved.failure)}`,
				resolved.failure,
			);
		}
		const paths = resolved.value;
		const key = blockKey(stamp, paths, deps.fileStamp);
		if (cache && cache.key === key) return cache.result;
		const read = deps.readPrompts(paths);
		const result: LoadResult = read.failure
			? { config: null, failure: read.failure }
			: {
					config: { role: parsed.role, block: read.value.join("\n\n") },
					failure: null,
				};
		cache = { key, result };
		return result;
	};
}

/** The delivered block and its role, or null when nothing contributes. */
export function buildBlock(
	result: LoadResult,
	registry: SegmentRegistry,
): { block: string; role: "system" | "user" } | null {
	if (!result.config) return null;
	const block = registry.assemble([configSegment(result.config.block)]);
	if (block === null) return null;
	return { block, role: result.config.role };
}

/**
 * Merge only when tail insertion would be illegal: the model lacks
 * mid-conversation system support, and the payload cannot carry the configured
 * role — either because the role is `system`, or because the Anthropic branch
 * fixes the inserted role to `system`.
 */
export function usesMergeBranch(
	supportsMidConvoSystemMessages: boolean,
	role: "system" | "user",
	api: string | undefined,
): boolean {
	return (
		!supportsMidConvoSystemMessages &&
		(role === "system" || api === "anthropic-messages")
	);
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

/** Bound a diagnostic so a hostile payload cannot flood the notice. */
function truncate(text: string, limit = 120): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const registry = new SegmentRegistry();
	const reported = new Set<string>();
	const pending = new Map<string, string>();

	/** Remember a report once, and keep it until a hook can surface it. */
	const note = (key: string, message: string): void => {
		if (reported.has(key)) return;
		reported.add(key);
		if (reported.size > REPORTED_LIMIT) {
			const oldest = reported.values().next().value;
			if (oldest !== undefined) reported.delete(oldest);
		}
		pending.set(key, message);
	};

	/** Surface whatever has accumulated, once, through Pi's UI. */
	const flush = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || pending.size === 0) return;
		for (const message of pending.values()) ctx.ui.notify(message, "warning");
		pending.clear();
	};

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
		note(
			`registration:${key}`,
			"tail-prompt: rejected a registration — it needs a non-empty id " +
				"other than 'tail-prompt', an integer position, and a source " +
				`of kind 'path' (absolute) or 'text'; got ${truncate(key)}`,
		);
	});

	// A contributor that loaded before this extension missed its own emit; the
	// ready signal asks it to re-send, so either load order takes effect.
	pi.events.emit(READY_CHANNEL, undefined);

	/** Load, surface any failure, and hand the result to the caller. */
	const deliver = (ctx: ExtensionContext): LoadResult => {
		const result = load();
		if (result.failure) {
			note(failureKey(result.failure), failureMessage(result.failure));
		}
		flush(ctx);
		return result;
	};

	// A broken configuration is worth surfacing before the first request.
	pi.on("session_start", (_event, ctx) => {
		deliver(ctx);
	});

	// Merge branch: tail insertion is illegal, so append a request-local system
	// message and let Pi fold it into the leading prompt.
	pi.on("context_with_system", (event, ctx) => {
		const built = buildBlock(deliver(ctx), registry);
		if (!built) return;
		if (
			!usesMergeBranch(
				supportsMidConvoSystemMessages(ctx.model),
				built.role,
				modelApi(ctx.model),
			)
		) {
			return;
		}
		return {
			messages: [
				...event.messages,
				{ role: "system", content: built.block, timestamp: Date.now() },
			],
		};
	});

	// Tail branch: tail insertion is legal, so insert the block into the final
	// payload adjacent to the latest user turn.
	pi.on("before_provider_request", (event, ctx) => {
		const built = buildBlock(deliver(ctx), registry);
		if (!built) return;
		const api = modelApi(ctx.model);
		const merge = usesMergeBranch(
			supportsMidConvoSystemMessages(ctx.model),
			built.role,
			api,
		);
		const payload = event.payload as Record<string, unknown> | undefined;
		// The merge configuration delivered the block through the transcript;
		// this hook must leave the payload untouched then.
		if (!payload || merge) return;
		const placed = applyTailToPayload(
			payload,
			built.block,
			built.role,
			api,
		);
		if (placed) return placed;
		const merged = mergeBlockIntoLeadingSystem(payload, built.block);
		if (merged) return merged;
		note(
			"placement:no-leading-system",
			"tail-prompt: this request has no leading system content to " +
				"carry the block",
		);
		flush(ctx);
	});
}

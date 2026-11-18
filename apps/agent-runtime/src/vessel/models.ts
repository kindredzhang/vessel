/**
 * Vessel's model catalog.
 *
 * Vessel talks to one OpenAI-compatible endpoint — a "Custom Provider" — whose
 * base URL and API key come from the environment (`VESSEL_BASE_URL`,
 * `VESSEL_API_KEY`). Every model that endpoint lists in `GET /models` is
 * registered as-is: no owner filter, and nothing is read from ~/.pi/agent.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Provider id used inside Pi; the display name is "Custom Provider". */
export const PROVIDER_ID = "custom-provider";
export const PROVIDER_NAME = "Custom Provider";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type VesselThinkingLevel = (typeof THINKING_LEVELS)[number];

/** One chat model offered by the Custom Provider endpoint. */
export interface VesselModel {
	id: string;
	name: string;
	api: "openai-completions";
	input: ("text" | "image")[];
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	contextWindow: number;
	maxTokens: number;
	cost: typeof ZERO_COST;
}

export interface ProviderSettings {
	baseUrl: string;
	apiKey: string;
}

export interface ModelCatalog {
	models: VesselModel[];
	baseUrl: string;
}

/** Read the endpoint settings from the environment, or explain what is missing. */
export function providerSettings(env: Record<string, string | undefined> = process.env): ProviderSettings {
	const baseUrl = env.VESSEL_BASE_URL?.trim();
	const apiKey = env.VESSEL_API_KEY?.trim();
	const missing = [
		baseUrl ? undefined : "VESSEL_BASE_URL",
		apiKey ? undefined : "VESSEL_API_KEY",
	].filter((name): name is string => name !== undefined);
	if (missing.length > 0) {
		throw new Error(`missing ${missing.join(" and ")} — copy .env.example to .env and fill them in`);
	}
	return { baseUrl: baseUrl!.replace(/\/+$/u, ""), apiKey: apiKey! };
}

/** Shape of one entry of the endpoint's OpenAI-compatible GET /models. */
interface ListedModel {
	id: string;
	display_name?: string;
	name?: string;
	context_window?: number;
	context_length?: number;
	max_output_tokens?: number;
	reasoning?: boolean;
	reasoning_levels?: string[];
	modalities?: { input?: ("text" | "image")[] };
}

function thinkingLevelMap(levels: string[] | undefined): Record<string, string | null> | undefined {
	if (!levels?.length) return undefined;
	const supported = new Set(levels);
	const map: Record<string, string | null> = {};
	for (const level of THINKING_LEVELS) map[level] = supported.has(level) ? level : null;
	// Some providers spell "no thinking" as "none".
	if (supported.has("none")) map.off = "none";
	return map;
}

function toVesselModel(model: ListedModel): VesselModel {
	return {
		id: model.id,
		name: model.display_name ?? model.name ?? model.id,
		api: "openai-completions",
		input: model.modalities?.input ?? ["text"],
		reasoning: model.reasoning === true,
		thinkingLevelMap: thinkingLevelMap(model.reasoning_levels),
		contextWindow: model.context_window ?? model.context_length ?? 256_000,
		maxTokens: model.max_output_tokens ?? 32_000,
		cost: ZERO_COST,
	};
}

export interface LoadCatalogOptions {
	settings?: ProviderSettings;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

/** Ask the endpoint for its model list and keep every model it reports. */
export async function loadModelCatalog(options: LoadCatalogOptions = {}): Promise<ModelCatalog> {
	const settings = options.settings ?? providerSettings();
	const doFetch = options.fetchImpl ?? fetch;
	const response = await doFetch(`${settings.baseUrl}/models`, {
		headers: { authorization: `Bearer ${settings.apiKey}` },
		signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
	});
	if (!response.ok) throw new Error(`${settings.baseUrl}/models answered ${response.status}`);
	const body = (await response.json()) as { data?: ListedModel[] };
	const models = (body.data ?? []).filter((model) => typeof model.id === "string" && model.id.length > 0).map(toVesselModel);
	if (models.length === 0) throw new Error(`${settings.baseUrl}/models listed no models`);
	return { models, baseUrl: settings.baseUrl };
}

/** A ModelRuntime that knows only this endpoint and its models. */
export async function createProviderRuntime(
	catalog: ModelCatalog,
	settings: ProviderSettings,
): Promise<ModelRuntime> {
	// `modelsPath: null` keeps the user's global models.json out of Vessel.
	const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
	runtime.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: settings.baseUrl,
		apiKey: settings.apiKey,
		api: "openai-completions",
		models: catalog.models,
	});
	return runtime;
}

/**
 * Resolve a model id from the endpoint's list. Accepts the exact id, an id with
 * the `provider/` prefix, a bare suffix, or a display name (`deepseek-v4.1-flash`,
 * `GLM-5.3-Flash`). Anything unmatched falls back to the first listed model.
 */
export function pickModel(
	runtime: ModelRuntime,
	wanted?: string,
): ReturnType<ModelRuntime["getModels"]>[number] | undefined {
	const catalog = runtime.getModels(PROVIDER_ID);
	if (!wanted) return catalog[0];
	const needle = wanted.trim().toLowerCase();
	return (
		runtime.getModel(PROVIDER_ID, wanted) ??
		catalog.find((model) => model.id.toLowerCase() === needle) ??
		catalog.find((model) => model.name.toLowerCase() === needle) ??
		catalog.find((model) => model.id.toLowerCase().endsWith(`/${needle}`)) ??
		catalog.find((model) => model.name.toLowerCase().startsWith(needle)) ??
		catalog[0]
	);
}

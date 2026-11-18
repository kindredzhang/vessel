import { describe, expect, test } from "bun:test";
import {
	createProviderRuntime,
	loadModelCatalog,
	pickModel,
	PROVIDER_ID,
	PROVIDER_NAME,
	providerSettings,
} from "./models.ts";

const settings = { baseUrl: "https://models.example.com/v1", apiKey: "sk-test" };

const listedModels = {
	data: [
		{
			id: "vendor/glm",
			display_name: "GLM-5.3-Flash",
			owned_by: "qingtian",
			context_window: 256_000,
			max_output_tokens: 32_000,
			reasoning: true,
			reasoning_levels: ["low", "high"],
			modalities: { input: ["text", "image"] },
		},
		{
			id: "vendor/deepseek",
			display_name: "DeepSeek",
			owned_by: "someone-else",
			reasoning: true,
			reasoning_levels: ["none", "xhigh"],
		},
		{ id: "group/smart-split", display_name: "routing group", owned_by: "codex" },
	],
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
}

describe("providerSettings", () => {
	test("reads the base URL and API key from the environment", () => {
		expect(
			providerSettings({ VESSEL_BASE_URL: "https://host/v1/", VESSEL_API_KEY: "sk-1" }),
		).toEqual({ baseUrl: "https://host/v1", apiKey: "sk-1" });
	});

	test("names the missing variables", () => {
		expect(() => providerSettings({})).toThrow(/VESSEL_BASE_URL and VESSEL_API_KEY/);
		expect(() => providerSettings({ VESSEL_BASE_URL: "https://host/v1" })).toThrow(/VESSEL_API_KEY/);
	});
});

describe("loadModelCatalog", () => {
	test("keeps every listed model, whatever its owner", async () => {
		const catalog = await loadModelCatalog({ settings, fetchImpl: fakeFetch(listedModels) });
		expect(catalog.baseUrl).toBe(settings.baseUrl);
		expect(catalog.models.map((model) => model.id)).toEqual([
			"vendor/glm",
			"vendor/deepseek",
			"group/smart-split",
		]);
		expect(catalog.models[0]?.name).toBe("GLM-5.3-Flash");
		expect(catalog.models[0]?.input).toEqual(["text", "image"]);
		expect(catalog.models[1]?.input).toEqual(["text"]);
		expect(catalog.models[2]?.reasoning).toBe(false);
	});

	test("requests <baseUrl>/models with the API key", async () => {
		let url: string | undefined;
		let authorization: string | undefined;
		const capture = (async (input: string, init?: RequestInit) => {
			url = String(input);
			authorization = new Headers(init?.headers).get("authorization") ?? undefined;
			return new Response(JSON.stringify(listedModels), { status: 200 });
		}) as unknown as typeof fetch;

		await loadModelCatalog({ settings, fetchImpl: capture });
		expect(url).toBe("https://models.example.com/v1/models");
		expect(authorization).toBe("Bearer sk-test");
	});

	test("maps reasoning levels to a thinking level map", async () => {
		const catalog = await loadModelCatalog({ settings, fetchImpl: fakeFetch(listedModels) });
		expect(catalog.models[0]?.thinkingLevelMap).toMatchObject({ low: "low", high: "high", medium: null, off: null });
		expect(catalog.models[1]?.thinkingLevelMap).toMatchObject({ off: "none", xhigh: "xhigh", low: null });
	});

	test("surfaces a failing endpoint instead of guessing a catalog", async () => {
		const down = (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as unknown as typeof fetch;
		expect(loadModelCatalog({ settings, fetchImpl: down })).rejects.toThrow(/ECONNREFUSED/);
		expect(loadModelCatalog({ settings, fetchImpl: fakeFetch({}, 500) })).rejects.toThrow(/answered 500/);
		expect(loadModelCatalog({ settings, fetchImpl: fakeFetch({ data: [] }) })).rejects.toThrow(/listed no models/);
	});
});

describe("createProviderRuntime", () => {
	test("registers every model under the Custom Provider", async () => {
		const catalog = await loadModelCatalog({ settings, fetchImpl: fakeFetch(listedModels) });
		const runtime = await createProviderRuntime(catalog, settings);
		expect(runtime.getProviders().map((provider) => provider.id)).toContain(PROVIDER_ID);
		expect(runtime.getProvider(PROVIDER_ID)?.name).toBe(PROVIDER_NAME);
		expect(runtime.getModels(PROVIDER_ID).map((model) => model.id)).toEqual([
			"vendor/glm",
			"vendor/deepseek",
			"group/smart-split",
		]);
	});

	test("pickModel accepts full ids, bare suffixes, display names, and falls back to the first model", async () => {
		const catalog = await loadModelCatalog({ settings, fetchImpl: fakeFetch(listedModels) });
		const runtime = await createProviderRuntime(catalog, settings);
		expect(pickModel(runtime, "vendor/deepseek")?.id).toBe("vendor/deepseek");
		expect(pickModel(runtime, "deepseek")?.id).toBe("vendor/deepseek");
		expect(pickModel(runtime, "glm-5.3-flash")?.id).toBe("vendor/glm");
		expect(pickModel(runtime, `${PROVIDER_ID}/vendor/glm`)?.id).toBe("vendor/glm");
		expect(pickModel(runtime, "missing")?.id).toBe("vendor/glm");
		expect(pickModel(runtime)?.id).toBe("vendor/glm");
	});
});

import { describe, expect, test } from "bun:test";
import type { ApprovalRequest } from "../access/gate.ts";
import type { AccessMode } from "../access/modes.ts";
import type { AgentEvent, CreateAgent, ServerAgent } from "./agent.ts";
import { createVesselService, type VesselService } from "./service.ts";

type Script = (agent: FakeAgent, text: string) => Promise<void>;

class FakeAgent implements ServerAgent {
	readonly modelId = "fake/model";
	readonly modelName = "Fake Model";
	accessMode: AccessMode;
	disposed = false;
	aborted = false;
	private readonly listeners = new Set<(event: AgentEvent) => void>();

	constructor(
		mode: AccessMode,
		readonly ask: (request: ApprovalRequest) => Promise<unknown>,
		private readonly script: Script,
	) {
		this.accessMode = mode;
	}

	subscribe(listener: (event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: AgentEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	async prompt(text: string): Promise<void> {
		await this.script(this, text);
	}

	setAccessMode(mode: AccessMode): void {
		this.accessMode = mode;
	}

	abort(): void {
		this.aborted = true;
	}

	dispose(): void {
		this.disposed = true;
	}
}

function harness(script: Script = async (agent, text) => agent.emit({ type: "text", delta: `echo:${text}` }), options: { token?: string } = {}) {
	const agents: FakeAgent[] = [];
	const createAgent: CreateAgent = async ({ accessMode, ask }) => {
		const agent = new FakeAgent(accessMode, ask as (request: ApprovalRequest) => Promise<unknown>, script);
		agents.push(agent);
		return agent;
	};
	const service = createVesselService({ createAgent, ...options });
	return { service, agent: () => agents[0] as FakeAgent };
}

function request(service: VesselService, path: string, init: RequestInit = {}): Promise<Response> {
	return service.fetch(new Request(`http://vessel.test${path}`, init));
}

async function create(service: VesselService, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
	const response = await request(service, "/v1/sessions", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	return response;
}

/** Minimal SSE reader: yields frames as they complete. */
class SseReader {
	private buffer = "";
	private readonly decoder = new TextDecoder();
	private readonly reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> };

	constructor(response: Response) {
		const body = response.body;
		if (!body) throw new Error("response has no body");
		this.reader = body.getReader();
	}

	async next(): Promise<{ event: string; data: Record<string, unknown> } | undefined> {
		for (;;) {
			const frame = this.take();
			if (frame) return frame;
			const chunk = await this.reader.read();
			if (chunk.done) return undefined;
			this.buffer += this.decoder.decode(chunk.value, { stream: true });
		}
	}

	private take(): { event: string; data: Record<string, unknown> } | undefined {
		const index = this.buffer.indexOf("\n\n");
		if (index < 0) return undefined;
		const raw = this.buffer.slice(0, index);
		this.buffer = this.buffer.slice(index + 2);
		let event = "message";
		let data = "";
		for (const line of raw.split("\n")) {
			if (line.startsWith("event: ")) event = line.slice(7);
			else if (line.startsWith("data: ")) data += line.slice(6);
		}
		return { event, data: data ? (JSON.parse(data) as Record<string, unknown>) : {} };
	}
}

function turn(service: VesselService, id: string, prompt: string, headers: Record<string, string> = {}) {
	return request(service, `/v1/sessions/${id}/turns`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ prompt }),
	});
}

describe("vessel service", () => {
	test("healthz is open and reports sessions", async () => {
		const { service } = harness();
		const response = await request(service, "/healthz");
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(body.sessions).toBe(0);
	});

	test("a token protects every /v1 route", async () => {
		const { service } = harness(undefined, { token: "secret" });
		expect((await create(service)).status).toBe(401);

		const bearer = await create(service, {}, { authorization: "Bearer secret" });
		expect(bearer.status).toBe(201);

		const header = await request(service, "/v1/sessions", { headers: { "x-vessel-token": "secret" } });
		expect(header.status).toBe(200);
	});

	test("POST /v1/sessions defaults to ask mode and returns a view", async () => {
		const { service } = harness();
		const response = await create(service);
		expect(response.status).toBe(201);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.accessMode).toBe("ask");
		expect(body.busy).toBe(false);
		expect((body.model as Record<string, unknown>).id).toBe("fake/model");
		expect(typeof body.id).toBe("string");
	});

	test("a bad mode is rejected", async () => {
		const { service } = harness();
		const response = await create(service, { accessMode: "yolo" });
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("invalid_mode");
	});

	test("a turn streams text, tool events and done", async () => {
		const { service } = harness(async (agent, text) => {
			agent.emit({ type: "text", delta: "thinking about " });
			agent.emit({ type: "text", delta: text });
			agent.emit({ type: "tool", phase: "start", name: "read", summary: "README.md" });
			agent.emit({ type: "tool", phase: "end", name: "read", isError: false });
		});
		const id = ((await (await create(service)).json()) as { id: string }).id;

		const response = await turn(service, id, "hello");
		expect(response.headers.get("content-type")).toContain("text/event-stream");

		const reader = new SseReader(response);
		const events: string[] = [];
		const text: string[] = [];
		for (;;) {
			const frame = await reader.next();
			if (!frame) break;
			events.push(frame.event);
			if (frame.event === "text") text.push(String(frame.data.delta));
		}
		expect(events[0]).toBe("start");
		expect(events).toContain("tool");
		expect(events.at(-1)).toBe("done");
		expect(text.join("")).toBe("thinking about hello");

		const view = (await (await request(service, `/v1/sessions/${id}`)).json()) as {
			messages: { role: string; text: string }[];
			busy: boolean;
		};
		expect(view.busy).toBe(false);
		expect(view.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	test("a turn that produces nothing is flagged as silent", async () => {
		const { service } = harness(async () => {});
		const id = ((await (await create(service)).json()) as { id: string }).id;

		const reader = new SseReader(await turn(service, id, "hi"));
		let done: { silent?: boolean; messages?: unknown[] } = {};
		for (;;) {
			const frame = await reader.next();
			if (!frame) break;
			if (frame.event === "done") done = frame.data as typeof done;
		}
		expect(done.silent).toBe(true);
		expect(done.messages).toHaveLength(1);
	});

	test("an approval travels out and the decision travels back", async () => {
		const { service } = harness(async (agent) => {
			const decision = (await agent.ask({
				call: { toolName: "bash", input: { command: "rm -rf build" }, cwd: "/tmp" },
				verdict: { decision: "ask", risk: "destructive", reason: "rm -rf", scopeKey: "destructive" },
				description: "bash: rm -rf build",
				mode: "ask",
				attempt: 1,
			})) as { type: string; scope?: string };
			agent.emit({ type: "text", delta: `decision:${decision.type}${decision.scope ?? ""}` });
		});
		const id = ((await (await create(service)).json()) as { id: string }).id;

		const reader = new SseReader(await turn(service, id, "clean up"));
		const first = await reader.next();
		expect(first?.event).toBe("start");

		const approval = await reader.next();
		expect(approval?.event).toBe("approval");
		expect(approval?.data.risk).toBe("destructive");
		expect(approval?.data.toolName).toBe("bash");
		const requestId = String(approval?.data.requestId);

		const decided = await request(service, `/v1/sessions/${id}/approvals`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId, decision: "always" }),
		});
		expect(decided.status).toBe(200);

		const text = await reader.next();
		expect(text?.data.delta).toBe("decision:allowsession");
		expect((await reader.next())?.event).toBe("done");
	});

	test("a second turn while one is running is a 409", async () => {
		let release: () => void = () => {};
		const { service } = harness(async (agent, text) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			agent.emit({ type: "text", delta: text });
		});
		const id = ((await (await create(service)).json()) as { id: string }).id;

		const reader = new SseReader(await turn(service, id, "slow"));
		await reader.next();
		expect((await turn(service, id, "second")).status).toBe(409);
		release();
		for (;;) {
			const frame = await reader.next();
			if (!frame || frame.event === "done") break;
		}
	});

	test("mode and delete round-trip", async () => {
		const { service, agent } = harness();
		const id = ((await (await create(service)).json()) as { id: string }).id;

		const changed = await request(service, `/v1/sessions/${id}/mode`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "plan" }),
		});
		expect(((await changed.json()) as { accessMode: string }).accessMode).toBe("plan");

		const removed = await request(service, `/v1/sessions/${id}`, { method: "DELETE" });
		expect(removed.status).toBe(200);
		expect(agent().disposed).toBe(true);
		expect((await request(service, `/v1/sessions/${id}`)).status).toBe(404);
	});

	test("preflight and unknown routes answer like an API", async () => {
		const { service } = harness();
		const preflight = await request(service, "/v1/sessions", { method: "OPTIONS" });
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

		const missing = await request(service, "/v1/nope");
		expect(missing.status).toBe(404);
		expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not_found");
	});
});

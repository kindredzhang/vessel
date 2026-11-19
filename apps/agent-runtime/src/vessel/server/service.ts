import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalRequest } from "../access/gate.ts";
import { isAccessMode, parseAccessMode, type AccessMode } from "../access/modes.ts";
import type { CreateAgent, ServerAgent } from "./agent.ts";

export interface TranscriptMessage {
	role: "user" | "assistant";
	text: string;
	at: string;
}

interface PendingApproval {
	resolve(decision: ApprovalDecision): void;
}

interface SessionRecord {
	id: string;
	agent: ServerAgent;
	createdAt: string;
	messages: TranscriptMessage[];
	busy: boolean;
	pending: Map<string, PendingApproval>;
	/** Set while a turn is streaming; approvals are delivered through it. */
	send?: (event: string, data: unknown) => void;
}

export interface VesselServiceOptions {
	createAgent: CreateAgent;
	/** Bearer token. Omitted means open, which is fine for a localhost sidecar. */
	token?: string;
	/** Allowed origins; defaults to any (a webview may send `null`). */
	corsOrigins?: string[];
	/** How long a paused tool call waits for a decision (default 5 minutes). */
	approvalTimeoutMs?: number;
}

export interface VesselService {
	fetch(request: Request): Promise<Response>;
	close(): void;
	sessionCount(): number;
}

class HttpError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

const encoder = new TextEncoder();

function now(): string {
	return new Date().toISOString();
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
	const text = await request.text();
	if (!text.trim()) return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new HttpError(400, "invalid_json", "request body must be JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new HttpError(400, "invalid_json", "request body must be a JSON object");
	}
	return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseMode(value: unknown): AccessMode {
	if (typeof value !== "string" || !isAccessMode(value)) {
		throw new HttpError(400, "invalid_mode", "mode must be plan, ask, auto or full");
	}
	return value;
}

function toDecision(value: unknown): ApprovalDecision {
	switch (value) {
		case "allow":
			return { type: "allow", scope: "once" };
		case "always":
			return { type: "allow", scope: "session" };
		case "deny":
			return { type: "deny", reason: "denied by the client" };
		case "auto":
			return { type: "switch", mode: "auto" };
		case "full":
			return { type: "switch", mode: "full" };
		default:
			throw new HttpError(400, "invalid_decision", "decision must be allow, always, deny, auto or full");
	}
}

/**
 * The HTTP surface of the agent runtime. One JSON request in, JSON out, except
 * `POST /v1/sessions/:id/turns`, which answers with an event stream.
 */
export function createVesselService(options: VesselServiceOptions): VesselService {
	const sessions = new Map<string, SessionRecord>();
	const approvalTimeout = options.approvalTimeoutMs ?? 5 * 60_000;

	const allowedOrigin = (request: Request): string => {
		const origin = request.headers.get("origin");
		const allowed = options.corsOrigins;
		if (!allowed || allowed.includes("*")) return origin ?? "*";
		return origin && allowed.includes(origin) ? origin : "none";
	};

	const headersFor = (request: Request, extra: Record<string, string> = {}): Record<string, string> => ({
		"access-control-allow-origin": allowedOrigin(request),
		"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
		"access-control-allow-headers": "authorization, content-type, x-vessel-token",
		"access-control-max-age": "600",
		vary: "origin",
		...extra,
	});

	const json = (request: Request, status: number, payload: unknown): Response =>
		new Response(JSON.stringify(payload), {
			status,
			headers: headersFor(request, { "content-type": "application/json; charset=utf-8" }),
		});

	const authorized = (request: Request): boolean => {
		if (!options.token) return true;
		const header = request.headers.get("authorization") ?? "";
		const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
		return bearer === options.token || (request.headers.get("x-vessel-token") ?? "") === options.token;
	};

	const current = (id: string): SessionRecord => {
		const session = sessions.get(id);
		if (!session) throw new HttpError(404, "not_found", `no session ${id}`);
		return session;
	};

	const view = (session: SessionRecord) => ({
		id: session.id,
		createdAt: session.createdAt,
		busy: session.busy,
		accessMode: session.agent.accessMode,
		model: { id: session.agent.modelId, name: session.agent.modelName },
		messages: session.messages,
	});

	const createSession = async (request: Request): Promise<Response> => {
		const body = await readJson(request);
		const accessMode =
			body.accessMode === undefined
				? (parseAccessMode(process.env.VESSEL_ACCESS_MODE) ?? "ask")
				: parseMode(body.accessMode);

		const id = randomUUID();
		const session = {
			id,
			createdAt: now(),
			messages: [] as TranscriptMessage[],
			busy: false,
			pending: new Map<string, PendingApproval>(),
		} as Omit<SessionRecord, "agent"> & { agent?: ServerAgent };

		// The gate calls this while a tool is about to run; the decision comes
		// back from the client over POST /approvals.
		const ask = (request_: ApprovalRequest): Promise<ApprovalDecision> =>
			new Promise<ApprovalDecision>((resolve) => {
				if (!session.send) {
					resolve({ type: "deny", reason: "nothing is listening for approvals" });
					return;
				}
				const requestId = randomUUID();
				const settle = (decision: ApprovalDecision): void => {
					clearTimeout(timer);
					session.pending.delete(requestId);
					resolve(decision);
				};
				const timer = setTimeout(() => settle({ type: "deny", reason: "approval timed out" }), approvalTimeout);
				session.pending.set(requestId, { resolve: settle });
				session.send?.("approval", {
					requestId,
					mode: request_.mode,
					toolName: request_.call.toolName,
					description: request_.description,
					risk: request_.verdict.risk,
					args: request_.call.input ?? {},
					attempt: request_.attempt,
				});
			});

		const agent = await options.createAgent({ accessMode, ask, model: optionalString(body.model) });
		const record = session as SessionRecord;
		record.agent = agent;
		sessions.set(id, record);
		return json(request, 201, view(record));
	};

	const runTurn = (request: Request, session: SessionRecord, prompt: string): Response => {
		let closed = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const send = (event: string, data: unknown): void => {
					if (closed) return;
					try {
						controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
					} catch {
						closed = true;
					}
				};

				session.busy = true;
				session.send = send;
				// Bun closes idle connections after 10s by default; a comment frame
				// keeps a slow model's turn alive without confusing the client.
				const heartbeat = setInterval(() => {
					if (closed) return;
					try {
						controller.enqueue(encoder.encode(": ping\n\n"));
					} catch {
						closed = true;
					}
				}, 15_000);
				session.messages.push({ role: "user", text: prompt, at: now() });
				send("start", { turnId: randomUUID() });

				let assistant = "";
				let toolCalls = 0;
				const unsubscribe = session.agent.subscribe((event) => {
					if (event.type === "text") {
						assistant += event.delta;
						send("text", { delta: event.delta });
						return;
					}
					if (event.type === "thinking") {
						send("thinking", { delta: event.delta });
						return;
					}
					if (event.phase === "start") toolCalls += 1;
					send("tool", { phase: event.phase, name: event.name, summary: event.summary, isError: event.isError });
				});

				const settle = (): void => {
					clearInterval(heartbeat);
					unsubscribe();
					session.send = undefined;
					session.busy = false;
					for (const pending of session.pending.values()) {
						pending.resolve({ type: "deny", reason: "turn ended" });
					}
					session.pending.clear();
					if (closed) return;
					closed = true;
					try {
						controller.close();
					} catch {
						// already closed by the client
					}
				};

				void (async () => {
					try {
						await session.agent.prompt(prompt);
						if (assistant.trim()) session.messages.push({ role: "assistant", text: assistant, at: now() });
						send("done", {
							accessMode: session.agent.accessMode,
							messages: session.messages,
							// Some gateways stream reasoning and then stop. Say so instead of
							// letting a client render an empty assistant turn.
							silent: !assistant.trim() && toolCalls === 0,
						});
					} catch (error) {
						if (assistant.trim()) session.messages.push({ role: "assistant", text: assistant, at: now() });
						send("error", { message: error instanceof Error ? error.message : String(error) });
					} finally {
						settle();
					}
				})();
			},
			cancel() {
				closed = true;
				session.agent.abort();
			},
		});

		return new Response(stream, {
			status: 200,
			headers: headersFor(request, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			}),
		});
	};

	const route = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const parts = url.pathname.split("/").filter(Boolean);

		if (parts[0] === "healthz") {
			const sessions_ = [...sessions.values()];
			return json(request, 200, {
				status: "ok",
				time: now(),
				sessions: sessions_.length,
				busy: sessions_.filter((session) => session.busy).length,
			});
		}
		if (parts[0] !== "v1") throw new HttpError(404, "not_found", `no route for ${url.pathname}`);
		if (!authorized(request)) throw new HttpError(401, "unauthorized", "missing or wrong bearer token");

		if (parts.length === 2 && parts[1] === "sessions") {
			if (request.method === "POST") return createSession(request);
			if (request.method === "GET") {
				return json(request, 200, { sessions: [...sessions.values()].map(view) });
			}
			throw new HttpError(405, "method_not_allowed", `${request.method} is not allowed here`);
		}

		if (parts.length >= 4 && parts[1] === "sessions") {
			const session = current(parts[2] as string);
			const action = parts[3];

			if (parts.length === 4 && action === "turns" && request.method === "POST") {
				if (session.busy) throw new HttpError(409, "busy", "this session is already running a turn");
				const body = await readJson(request);
				const prompt = optionalString(body.prompt);
				if (!prompt) throw new HttpError(400, "invalid_prompt", "prompt is required");
				return runTurn(request, session, prompt);
			}

			if (parts.length === 4 && action === "approvals" && request.method === "POST") {
				const body = await readJson(request);
				const requestId = optionalString(body.requestId);
				if (!requestId) throw new HttpError(400, "invalid_request_id", "requestId is required");
				const pending = session.pending.get(requestId);
				if (!pending) throw new HttpError(404, "not_found", `no pending approval ${requestId}`);
				pending.resolve(toDecision(body.decision));
				return json(request, 200, { ok: true });
			}

			if (parts.length === 4 && action === "mode" && request.method === "POST") {
				const body = await readJson(request);
				session.agent.setAccessMode(parseMode(body.mode));
				return json(request, 200, view(session));
			}

			if (parts.length === 4 && action === "abort" && request.method === "POST") {
				session.agent.abort();
				return json(request, 200, { ok: true });
			}

			if (parts.length === 4 && action === "messages" && request.method === "GET") {
				return json(request, 200, { messages: session.messages });
			}
		}

		if (parts.length === 3 && parts[1] === "sessions") {
			const session = current(parts[2] as string);
			if (request.method === "GET") return json(request, 200, view(session));
			if (request.method === "DELETE") {
				if (session.busy) session.agent.abort();
				session.agent.dispose();
				sessions.delete(session.id);
				return json(request, 200, { ok: true });
			}
			throw new HttpError(405, "method_not_allowed", `${request.method} is not allowed here`);
		}

		throw new HttpError(404, "not_found", `no route for ${url.pathname}`);
	};

	return {
		async fetch(request: Request): Promise<Response> {
			try {
				if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headersFor(request) });
				return await route(request);
			} catch (error) {
				if (error instanceof HttpError) return json(request, error.status, { error: { code: error.code, message: error.message } });
				const message = error instanceof Error ? error.message : String(error);
				return json(request, 500, { error: { code: "internal", message } });
			}
		},

		close(): void {
			for (const session of sessions.values()) {
				session.agent.abort();
				session.agent.dispose();
			}
			sessions.clear();
		},

		sessionCount(): number {
			return sessions.size;
		},
	};
}

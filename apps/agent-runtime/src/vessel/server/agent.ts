import type { ApprovalDecision, ApprovalRequest } from "../access/gate.ts";
import type { AccessMode } from "../access/modes.ts";
import type { VesselAgent } from "../agent.ts";

/** Events the HTTP layer understands, independent of the SDK's event shape. */
export type AgentEvent =
	| { type: "text"; delta: string }
	| { type: "thinking"; delta: string }
	| { type: "tool"; phase: "start" | "end"; name: string; summary?: string; isError?: boolean };

/**
 * The part of an agent a transport needs. Keeping the HTTP layer behind this
 * interface is what lets the server tests run without a model.
 */
export interface ServerAgent {
	readonly modelId: string;
	readonly modelName: string;
	readonly accessMode: AccessMode;
	setAccessMode(mode: AccessMode): void;
	prompt(text: string): Promise<void>;
	abort(): void;
	dispose(): void;
	subscribe(listener: (event: AgentEvent) => void): () => void;
}

export interface CreateAgentOptions {
	accessMode: AccessMode;
	ask(request: ApprovalRequest): Promise<ApprovalDecision>;
	model?: string;
}

export type CreateAgent = (options: CreateAgentOptions) => Promise<ServerAgent>;

/** One-line summary of a tool call for the UI; mirrors the CLI's renderer. */
export function summarizeToolArgs(args: unknown): string {
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		const key = ["path", "file_path", "command", "pattern", "query"].find((name) => typeof record[name] === "string");
		if (key) return String(record[key]).slice(0, 160);
	}
	const json = JSON.stringify(args ?? {});
	return json.length > 160 ? `${json.slice(0, 157)}...` : json;
}

/** Adapt a real vessel agent to the transport-facing interface. */
export function adaptAgent(agent: VesselAgent): ServerAgent {
	return {
		modelId: agent.model.id,
		modelName: agent.model.name ?? agent.model.id,
		get accessMode() {
			return agent.accessMode;
		},
		setAccessMode: (mode) => agent.setAccessMode(mode),
		prompt: (text) => agent.session.prompt(text),
		abort: () => agent.session.abort(),
		dispose: () => agent.dispose(),
		subscribe(listener) {
			return agent.session.subscribe((event) => {
				if (event.type === "message_update") {
					const update = event.assistantMessageEvent;
					if (update.type === "text_delta") listener({ type: "text", delta: update.delta });
					else if (update.type === "thinking_delta") listener({ type: "thinking", delta: update.delta });
					return;
				}
				if (event.type === "tool_execution_start") {
					listener({ type: "tool", phase: "start", name: event.toolName, summary: summarizeToolArgs(event.args) });
					return;
				}
				if (event.type === "tool_execution_end") {
					listener({ type: "tool", phase: "end", name: event.toolName, isError: event.isError === true });
				}
			});
		},
	};
}

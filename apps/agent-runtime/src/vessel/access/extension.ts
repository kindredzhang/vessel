import type { ExtensionAPI, ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { Gate } from "./gate.ts";
import { modePrompt, type AccessMode } from "./modes.ts";

/**
 * The single place where a tool call can be stopped.
 *
 * `tool_call` fires for built-in tools and for calls issued by another tool
 * (codemode scripts carry `parentToolCallId`), which is why the gate lives here
 * rather than in a tool wrapper.
 */
export function createAccessExtension(gate: Gate, getMode: () => AccessMode, cwd: string): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.on("before_agent_start", (event) => {
			const addendum = modePrompt(getMode());
			const current = event.systemPromptOptions.appendSystemPrompt;
			event.systemPromptOptions.appendSystemPrompt = current ? `${current}\n\n${addendum}` : addendum;
		});

		// Denial counters and prompt numbering are per turn.
		pi.on("turn_start", () => {
			gate.resetTurn();
		});

		pi.on("tool_call", async (event: ToolCallEvent) => {
			return gate.handle({
				toolName: event.toolName,
				input: event.input as unknown as Record<string, unknown>,
				cwd,
			});
		});
	};
}

import {
	AssistantRuntimeProvider,
	type ChatModelAdapter,
	type ThreadAssistantMessagePart,
	type ThreadMessageLike,
	useLocalRuntime,
} from "@assistant-ui/react";
import { useMemo } from "react";

import type { Message } from "../api";
import { lastUserText, messageOf, type TurnChannel } from "./channel";

/**
 * Route A — assistant-ui's own runtime, driven by a `ChatModelAdapter`.
 *
 * We keep the wire format we already have (server-sent events from the vessel
 * runtime) and translate it into assistant-ui parts: text, reasoning, tool
 * calls. assistant-ui owns message state, branching, editing and the composer.
 */
export function LocalChatProvider(props: {
	channel: TurnChannel;
	history: Message[];
	children: React.ReactNode;
}) {
	const { channel, history } = props;

	const adapter = useMemo<ChatModelAdapter>(
		() => ({
			async *run({ messages, abortSignal }) {
				const prompt = lastUserText(messages);
				let parts: ThreadAssistantMessagePart[] = [];
				let textCursor = -1;
				let reasoningCursor = -1;
				let toolCursor: { index: number; name: string }[] = [];
				let sequence = 0;

				const snapshot = (): ThreadAssistantMessagePart[] =>
					parts.map((part) => ({ ...part }));

				yield { content: snapshot() };

				for await (const event of channel.turn(prompt, abortSignal)) {
					switch (event.type) {
						case "start":
							break;
						case "text": {
							if (textCursor < 0) {
								parts = [...parts, { type: "text", text: "" }];
								textCursor = parts.length - 1;
							}
							const current = parts[textCursor];
							if (current?.type === "text") {
								parts[textCursor] = { type: "text", text: current.text + event.delta };
							}
							yield { content: snapshot() };
							break;
						}
						case "thinking": {
							if (reasoningCursor < 0) {
								parts = [...parts, { type: "reasoning", text: "" }];
								reasoningCursor = parts.length - 1;
							}
							const current = parts[reasoningCursor];
							if (current?.type === "reasoning") {
								parts[reasoningCursor] = { type: "reasoning", text: current.text + event.delta };
							}
							yield { content: snapshot() };
							break;
						}
						case "tool": {
							if (event.phase === "start") {
								sequence += 1;
								parts = [
									...parts,
									{
										type: "tool-call",
										toolCallId: `vessel-call-${sequence}`,
										toolName: event.name,
										argsText: event.summary ?? "",
										args: { summary: event.summary ?? "" },
									},
								];
								toolCursor = [...toolCursor, { index: parts.length - 1, name: event.name }];
							} else {
								const open = toolCursor.findIndex((entry) => entry.name === event.name);
								const entry = open >= 0 ? toolCursor[open] : undefined;
								if (entry) {
									toolCursor = toolCursor.filter((_, index) => index !== open);
									const current = parts[entry.index];
									if (current?.type === "tool-call") {
										parts[entry.index] = {
											...current,
											isError: event.isError === true,
											result: { ok: event.isError !== true },
										};
									}
								}
							}
							// Text resumes in a new part once a tool call interrupted it.
							textCursor = -1;
							reasoningCursor = -1;
							yield { content: snapshot() };
							break;
						}
						case "approval": {
							channel.signals.approval(event);
							break;
						}
						case "done": {
							channel.signals.settled(event);
							break;
						}
						case "error": {
							channel.signals.failed(event.message);
							throw new Error(event.message);
						}
					}
				}

				yield { content: snapshot() };
			},
		}),
		[channel],
	);

	const runtime = useLocalRuntime(adapter, { initialMessages: toThreadMessages(history) });

	return <AssistantRuntimeProvider runtime={runtime}>{props.children}</AssistantRuntimeProvider>;
}

function toThreadMessages(history: Message[]): ThreadMessageLike[] {
	return history.map((message, index) => ({
		id: `history-${index}`,
		role: message.role,
		content: [{ type: "text", text: message.text }],
	}));
}

export { messageOf };

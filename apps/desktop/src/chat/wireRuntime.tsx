import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/ai-sdk";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { useMemo } from "react";

import type { Message } from "../api";
import { lastUserText, messageOf, type TurnChannel } from "./channel";

/**
 * Route B — the Vercel AI SDK does the talking.
 *
 * `useChatRuntime` owns the chat through `useChat`; the only glue is a
 * `ChatTransport` that turns vessel's SSE into AI SDK UI message chunks. Once
 * that translation exists, every AI SDK feature (message parts, tool parts,
 * reasoning, resumption) comes along with it.
 */
export function WireChatProvider(props: {
	channel: TurnChannel;
	history: Message[];
	children: React.ReactNode;
}) {
	const { channel, history } = props;

	const transport = useMemo(() => new VesselTransport(channel), [channel]);
	const initialMessages = useMemo(() => toUIMessages(history), [history]);
	const runtime = useChatRuntime({ transport, messages: initialMessages });

	return <AssistantRuntimeProvider runtime={runtime}>{props.children}</AssistantRuntimeProvider>;
}

class VesselTransport implements ChatTransport<UIMessage> {
	constructor(private readonly channel: TurnChannel) {}

	async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
		// vessel streams a turn once; there is nothing to resume yet.
		return null;
	}

	async sendMessages(options: {
		messages: UIMessage[];
		abortSignal?: AbortSignal;
	}): Promise<ReadableStream<UIMessageChunk>> {
		const channel = this.channel;
		const prompt = lastUserText(options.messages);

		return new ReadableStream<UIMessageChunk>({
			async start(controller) {
				let sequence = 0;
				let textId: string | null = null;
				let reasoningId: string | null = null;
				const openTools: { id: string; name: string }[] = [];

				const push = (chunk: UIMessageChunk) => {
					try {
						controller.enqueue(chunk);
					} catch {
						// the consumer went away; the loop below will end on its own
					}
				};

				push({ type: "start" });

				try {
					for await (const event of channel.turn(prompt, options.abortSignal)) {
						switch (event.type) {
							case "start":
								break;
							case "text": {
								if (!textId) {
									sequence += 1;
									textId = `vessel-text-${sequence}`;
									push({ type: "text-start", id: textId });
								}
								push({ type: "text-delta", id: textId, delta: event.delta });
								break;
							}
							case "thinking": {
								if (!reasoningId) {
									sequence += 1;
									reasoningId = `vessel-reasoning-${sequence}`;
									push({ type: "reasoning-start", id: reasoningId });
								}
								push({ type: "reasoning-delta", id: reasoningId, delta: event.delta });
								break;
							}
							case "tool": {
								if (event.phase === "start") {
									sequence += 1;
									const toolCallId = `vessel-call-${sequence}`;
									openTools.push({ id: toolCallId, name: event.name });
									push({ type: "tool-input-start", toolCallId, toolName: event.name });
									push({
										type: "tool-input-available",
										toolCallId,
										toolName: event.name,
										input: { summary: event.summary ?? "" },
									});
								} else {
									const index = openTools.findIndex((entry) => entry.name === event.name);
									const open = index >= 0 ? openTools.splice(index, 1)[0] : undefined;
									if (open) {
										push({
											type: "tool-output-available",
											toolCallId: open.id,
											output: event.isError ? { ok: false } : { ok: true },
										});
									}
								}
								break;
							}
							case "approval":
								channel.signals.approval(event);
								break;
							case "done":
								channel.signals.settled(event);
								break;
							case "error":
								channel.signals.failed(event.message);
								push({ type: "error", errorText: event.message });
								break;
						}
					}

					if (reasoningId) push({ type: "reasoning-end", id: reasoningId });
					if (textId) push({ type: "text-end", id: textId });
					push({ type: "finish" });
				} catch (error) {
					push({ type: "error", errorText: messageOf(error) });
				} finally {
					controller.close();
				}
			},
		});
	}
}

function toUIMessages(history: Message[]): UIMessage[] {
	return history.map((message, index) => ({
		id: `history-${index}`,
		role: message.role,
		parts: [{ type: "text", text: message.text }],
	}));
}

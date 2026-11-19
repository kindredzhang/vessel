import type { RuntimeClient, SessionView, TurnEvent } from "../api";

export type ApprovalRequest = Extract<TurnEvent, { type: "approval" }>;
export type TurnSummary = Extract<TurnEvent, { type: "done" }>;

/** The things the transport cannot know: they belong to the app shell. */
export interface ChatSignals {
	approval(request: ApprovalRequest): void;
	settled(summary: TurnSummary): void;
	failed(message: string): void;
	sessionStarted(session: SessionView): void;
}

/**
 * Owns the thread's server session. A session is created on the first turn so
 * the user can type before the runtime knows about them; both runtimes go
 * through here instead of inventing their own session lifecycle.
 */
export class TurnChannel {
	private sessionId: string | null = null;
	private pending: Promise<string> | null = null;

	constructor(
		private readonly client: RuntimeClient,
		readonly signals: ChatSignals,
		private readonly currentMode: () => "plan" | "ask" | "auto" | "full",
	) {}

	get id(): string | null {
		return this.sessionId;
	}

	attach(session: SessionView): void {
		this.sessionId = session.id;
		this.pending = null;
	}

	detach(): void {
		this.sessionId = null;
		this.pending = null;
	}

	async ensure(): Promise<string> {
		if (this.sessionId) return this.sessionId;
		if (!this.pending) {
			this.pending = this.client
				.createSession(this.currentMode())
				.then((session) => {
					this.sessionId = session.id;
					this.signals.sessionStarted(session);
					return session.id;
				})
				.catch((error: unknown) => {
					this.pending = null;
					throw error;
				});
		}
		return this.pending;
	}

	async *turn(prompt: string, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
		const id = await this.ensure();
		yield* this.client.turn(id, prompt, signal);
	}
}

/** The last thing the human typed, which is all the runtime needs to continue. */
export function lastUserText(messages: readonly { role: string; content?: unknown; parts?: unknown }[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || message.role !== "user") continue;
		const texts = textOf(message);
		if (texts) return texts;
	}
	return "";
}

function textOf(message: { content?: unknown; parts?: unknown }): string {
	if (Array.isArray(message.content)) {
		return message.content
			.map((part) => (isTextPart(part) ? part.text : ""))
			.join("")
			.trim();
	}
	if (Array.isArray(message.parts)) {
		return message.parts
			.map((part) => (isTextPart(part) ? part.text : ""))
			.join("")
			.trim();
	}
	return "";
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
	return typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part;
}

export function messageOf(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

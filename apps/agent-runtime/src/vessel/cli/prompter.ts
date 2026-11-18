import { createInterface } from "node:readline/promises";

/**
 * One readline for the whole process.
 *
 * The REPL and the approval prompts share it: a turn can only be waiting on one
 * of them at a time, and a second interface on the same stdin would swallow the
 * other's lines. Lines typed while the model is still streaming are queued
 * instead of dropped.
 */
export interface Prompter {
	/** Resolves with the line, or null when the prompter is closed or interrupted. */
	readLine(prefix: string): Promise<string | null>;
	/** Ctrl+C handler; the default is to close the prompter. */
	onInterrupt(handler: () => void): void;
	close(): void;
	get closed(): boolean;
}

export function createPrompter(): Prompter {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: process.stdin.isTTY === true,
	});
	const queue: string[] = [];
	let closed = false;
	let interruptHandler: (() => void) | undefined;
	let pending: ((value: string | null) => void) | undefined;

	rl.on("line", (line) => {
		if (pending) {
			const resolve = pending;
			pending = undefined;
			resolve(line);
			return;
		}
		queue.push(line);
	});

	rl.on("close", () => {
		closed = true;
		pending?.(null);
		pending = undefined;
	});

	rl.on("SIGINT", () => {
		interruptHandler?.();
		// Unblock whoever is waiting (approval prompt or REPL) so Ctrl+C always
		// returns control instead of leaving a dangling promise.
		pending?.(null);
		pending = undefined;
	});

	return {
		readLine(prefix) {
			process.stdout.write(prefix);
			const queued = queue.shift();
			if (queued !== undefined) return Promise.resolve(queued);
			if (closed) return Promise.resolve(null);
			return new Promise<string | null>((resolve) => {
				pending = resolve;
			});
		},
		onInterrupt(handler) {
			interruptHandler = handler;
		},
		close() {
			if (!closed) rl.close();
		},
		get closed() {
			return closed;
		},
	};
}

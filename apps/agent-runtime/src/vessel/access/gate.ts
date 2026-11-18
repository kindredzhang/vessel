import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AccessMode } from "./modes.ts";
import { decide, describeCall, type PolicyOptions, type ToolCall, type Verdict } from "./policy.ts";

export interface ApprovalRequest {
	call: ToolCall;
	verdict: Verdict;
	/** Single-line description of what the call would do. */
	description: string;
	mode: AccessMode;
	/** 1-based count of approval prompts in the current turn. */
	attempt: number;
}

export type ApprovalDecision =
	| { type: "allow"; scope: "once" | "session" }
	| { type: "deny"; reason?: string }
	| { type: "switch"; mode: AccessMode };

export interface DecisionRecord {
	ts: string;
	mode: AccessMode;
	toolName: string;
	description: string;
	risk: string;
	decision: string;
	reason: string;
}

export interface ToolCallResult {
	block?: boolean;
	reason?: string;
	terminate?: boolean;
}

export interface GateOptions {
	cwd: string;
	getMode(): AccessMode;
	ask?(request: ApprovalRequest): Promise<ApprovalDecision>;
	onModeChange?(mode: AccessMode): void;
	/** Audit sink; defaults to a no-op. */
	record?(record: DecisionRecord): void;
	policy?: PolicyOptions;
	/** Deny a turn after this many consecutive denials (default 2). */
	maxConsecutiveDenials?: number;
}

export interface Gate {
	handle(call: ToolCall): Promise<ToolCallResult | undefined>;
	resetTurn(): void;
	/** Cleared whenever the mode changes. */
	clearSessionAllows(): void;
}

export function createGate(options: GateOptions): Gate {
	const sessionAllows = new Set<string>();
	const maxDenials = options.maxConsecutiveDenials ?? 2;
	let consecutiveDenials = 0;
	let attempts = 0;

	const log = (call: ToolCall, verdict: Verdict, decision: string, reason: string, mode: AccessMode): void => {
		options.record?.({
			ts: new Date().toISOString(),
			mode,
			toolName: call.toolName,
			description: describeCall(call),
			risk: verdict.risk,
			decision,
			reason,
		});
	};

	const block = (reason: string, terminate = false): ToolCallResult => {
		consecutiveDenials += 1;
		const result: ToolCallResult = { block: true, reason };
		if (terminate || consecutiveDenials >= maxDenials) result.terminate = true;
		return result;
	};

	const handle = async (call: ToolCall): Promise<ToolCallResult | undefined> => {
		let mode = options.getMode();
		let verdict = decide(mode, call, options.policy);

		if (verdict.decision === "allow") {
			consecutiveDenials = 0;
			log(call, verdict, "allow", verdict.reason, mode);
			return undefined;
		}

		if (verdict.decision === "deny") {
			log(call, verdict, "deny", verdict.reason, mode);
			return block(`Blocked by Vessel (${mode}): ${verdict.reason}. Do not retry the same call.`, verdict.hard === true);
		}

		const scopeKey = verdict.scopeKey ?? call.toolName;
		if (sessionAllows.has(scopeKey)) {
			log(call, verdict, "allow", `session approval for ${scopeKey}`, mode);
			consecutiveDenials = 0;
			return undefined;
		}

		if (!options.ask) {
			const reason = `${verdict.reason}. No approval UI is attached (headless run): re-run with --yes, --mode auto, or pass an ask handler.`;
			log(call, verdict, "deny", reason, mode);
			return block(`Blocked by Vessel: ${reason}`, verdict.hard === true);
		}

		attempts += 1;
		const request: ApprovalRequest = { call, verdict, description: describeCall(call), mode, attempt: attempts };
		const decision = await options.ask(request);

		if (decision.type === "allow") {
			if (decision.scope === "session") sessionAllows.add(scopeKey);
			log(call, verdict, "allow", decision.scope === "session" ? `approved for session: ${scopeKey}` : "approved once", mode);
			consecutiveDenials = 0;
			return undefined;
		}

		if (decision.type === "switch") {
			options.onModeChange?.(decision.mode);
			mode = decision.mode;
			verdict = decide(mode, call, options.policy);
			if (verdict.decision === "allow") {
				log(call, verdict, "allow", `mode switched to ${mode}`, mode);
				consecutiveDenials = 0;
				return undefined;
			}
			log(call, verdict, "deny", `mode switched to ${mode}, call still needs approval`, mode);
			return block(`User switched Vessel to ${mode}; this call was not approved. Adjust the approach or ask what to do instead.`);
		}

		const reason = decision.reason?.trim() || "user declined";
		log(call, verdict, "deny", reason, mode);
		return block(`The user declined this call (${reason}). Do not repeat it; explain what you need or propose an alternative.`);
	};

	return {
		handle,
		resetTurn: () => {
			consecutiveDenials = 0;
			attempts = 0;
		},
		clearSessionAllows: () => sessionAllows.clear(),
	};
}

/** Append-only JSONL audit log; failures never break a turn. */
export function createAuditLogger(path: string | false): ((record: DecisionRecord) => void) | undefined {
	if (path === false) return undefined;
	let ready: Promise<unknown> | undefined;
	return (record) => {
		ready ??= mkdir(dirname(path), { recursive: true });
		ready
			.then(() => appendFile(path, `${JSON.stringify(record)}\n`, "utf8"))
			.catch(() => {
				// Audit failures are swallowed: the log is diagnostics, not a gate.
			});
	};
}

import type { AccessMode } from "./modes.ts";
import { classifyPath, classifyBash, hardBlock, type Risk } from "./risk.ts";

export type Decision = "allow" | "ask" | "deny";

export interface ToolCall {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
}

export interface Verdict {
	decision: Decision;
	risk: Risk;
	reason: string;
	/** Key used when the user grants "always allow" for this kind of call. */
	scopeKey?: string;
	/** Denied regardless of mode or approval — protected paths, hard-blocked commands. */
	hard?: boolean;
}

export interface PolicyOptions {
	/** Allow destructive commands in full mode too (they are allowed by default). */
	allowDestructiveInFull?: boolean;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

function pathOf(input: Record<string, unknown>): string | undefined {
	for (const key of ["path", "file_path", "filePath", "dir_path", "pattern_path"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function scopeKeyFor(risk: Risk, toolName: string): string {
	if (risk === "write") return "write";
	if (risk === "outside") return "outside";
	if (risk === "destructive") return "destructive";
	return toolName;
}

function gate(mode: AccessMode, risk: Risk, options: PolicyOptions): Decision {
	if (risk === "none") return "allow";
	if (mode === "plan") return "deny";
	if (mode === "ask") return "ask";
	if (mode === "auto") return risk === "write" ? "allow" : "ask";
	// full
	if (risk === "destructive" && options.allowDestructiveInFull === false) return "deny";
	return "allow";
}

function verdict(decision: Decision, risk: Risk, reason: string, scopeKey?: string, hard = false): Verdict {
	return { decision, risk, reason, scopeKey, hard };
}

/** Classify one tool call. Pure: same inputs, same verdict — easy to table-test. */
export function decide(mode: AccessMode, call: ToolCall, options: PolicyOptions = {}): Verdict {
	const { toolName, input, cwd } = call;

	if (READ_TOOLS.has(toolName)) return verdict("allow", "none", "read-only tool");

	if (toolName === "edit" || toolName === "write") {
		const path = pathOf(input);
		if (!path) return verdict("deny", "unknown", `${toolName} without a path`, undefined, true);
		const target = classifyPath(path, cwd);
		if (target.kind === "protected") return verdict("deny", "destructive", target.reason, undefined, true);
		const risk: Risk = target.kind === "outside" ? "outside" : "write";
		return verdict(gate(mode, risk, options), risk, target.reason, scopeKeyFor(risk, toolName));
	}

	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		const blocked = hardBlock(command);
		if (blocked) return verdict("deny", "destructive", blocked, undefined, true);
		const { risk, reason } = classifyBash(command, cwd);
		return verdict(gate(mode, risk, options), risk, reason, scopeKeyFor(risk, toolName));
	}

	// Unknown tools (MCP, codemode, future built-ins) cannot be classified, so
	// they are treated as capable of anything.
	const risk: Risk = "unknown";
	return verdict(gate(mode, risk, options), risk, `${toolName} is not a Vessel-known tool`, toolName);
}

/** Short, single-line description of a call for approval prompts and audit logs. */
export function describeCall(call: ToolCall): string {
	const { toolName, input } = call;
	if (toolName === "bash") return String(input.command ?? "").split("\n")[0] ?? "";
	if (toolName === "edit" || toolName === "write" || toolName === "read") return pathOf(input) ?? "";
	const first = Object.entries(input).find(([, value]) => typeof value === "string");
	if (first) return `${first[0]}=${String(first[1])}`;
	return Object.keys(input).slice(0, 3).join(", ");
}

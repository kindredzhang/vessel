/**
 * The four file-access modes Vessel exposes.
 *
 * A mode is two orthogonal things: which tools are declared to the model
 * (capability) and whether a given call needs approval before it runs
 * (approval policy). `plan` changes both; the others only change approval.
 */
export type AccessMode = "plan" | "ask" | "auto" | "full";

export const ACCESS_MODES: readonly AccessMode[] = ["plan", "ask", "auto", "full"];

export interface ModeInfo {
	/** Label as shown in the product. */
	label: string;
	/** One-line hint, matching the product copy. */
	hint: string;
	/** What the policy actually does. */
	description: string;
}

export const MODE_INFO: Record<AccessMode, ModeInfo> = {
	plan: {
		label: "计划模式",
		hint: "编辑前先出计划",
		description: "只读探索并产出计划；写工具被移除，bash 只放行只读命令",
	},
	ask: {
		label: "变更前确认",
		hint: "改文件前先问我",
		description: "读随便用；改文件、跑写类命令前逐次确认",
	},
	auto: {
		label: "自主模式",
		hint: "在有风险时询问",
		description: "工作区内自主执行；越界、破坏性或不可判定的调用才询问",
	},
	full: {
		label: "完全访问",
		hint: "减少确认次数",
		description: "不再询问；保留硬性拒绝规则与审计日志",
	},
};

export function isAccessMode(value: string): value is AccessMode {
	return (ACCESS_MODES as readonly string[]).includes(value);
}

/** Parse a mode name, accepting `plan-mode` / `AUTO` style input. */
export function parseAccessMode(value: string | undefined): AccessMode | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase().replace(/-?mode$/u, "");
	return isAccessMode(normalized) ? normalized : undefined;
}

/** Tools declared to the model in each mode. */
export function toolsFor(mode: AccessMode, allTools: readonly string[]): string[] {
	if (mode !== "plan") return [...allTools];
	// Plan keeps bash so `git diff` and `rg` work, but the gate only lets
	// read-only commands through.
	return allTools.filter((name) => name !== "edit" && name !== "write");
}

export function modePrompt(mode: AccessMode): string {
	switch (mode) {
		case "plan":
			return `## Access mode: plan (read-only)

You are in plan mode. Investigate with read/grep/find/ls and read-only bash
(git status/log/diff/show, rg, ls, cat, ...). Editing tools are unavailable and
bash writes are blocked.

Produce a plan, not changes. End your investigation with:

Plan:
1. <step>
2. <step>

Then ask the user whether to execute it. Never claim a change was made while in
plan mode.`;
		case "ask":
			return `## Access mode: ask before changes

Reading is unrestricted. Every edit, write, or command that changes files is
gated: the user sees the exact call and approves or denies it. So say in one
sentence what you are about to do *and then call the tool in the same turn* —
never stop to ask for permission in prose, the approval prompt is the question.
If approval is denied, do not retry the same call — adjust or ask what to do
instead.`;
		case "auto":
			return `## Access mode: autonomous

Work inside the workspace on your own. The user is only asked about calls that
leave the workspace, look destructive, or cannot be classified — so keep paths
inside the workspace and prefer specific commands over clever one-liners.`;
		case "full":
			return `## Access mode: full access

You may change files and run commands without asking. Hard-blocked commands and
paths under .git/ and .vessel/ still fail. Every call is written to the audit log,
so keep changes intentional and reversible.`;
	}
}

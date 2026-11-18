import { describe, expect, test } from "bun:test";
import { createGate, type ApprovalDecision, type DecisionRecord } from "./gate.ts";
import type { AccessMode } from "./modes.ts";
import { decide, type ToolCall } from "./policy.ts";
import { classifyBash, classifyPath, hardBlock, type Risk } from "./risk.ts";

const cwd = "/work/project";

const call = (toolName: string, input: Record<string, unknown>): ToolCall => ({ toolName, input, cwd });

describe("classifyPath", () => {
	test("inside, outside and protected", () => {
		expect(classifyPath("src/a.ts", cwd).kind).toBe("inside");
		expect(classifyPath("./src/a.ts", cwd).kind).toBe("inside");
		expect(classifyPath("/etc/passwd", cwd).kind).toBe("outside");
		expect(classifyPath("../other/a.ts", cwd).kind).toBe("outside");
		expect(classifyPath(".git/config", cwd).kind).toBe("protected");
		expect(classifyPath(".vessel/audit.jsonl", cwd).kind).toBe("protected");
	});
});

describe("classifyBash", () => {
	const cases: Array<[string, Risk]> = [
		["ls -la", "none"],
		["pwd && cat package.json", "none"],
		["rg foo src | head -20", "none"],
		["git status", "none"],
		["git log --oneline -5", "none"],
		["git diff HEAD", "none"],
		["git branch --show-current", "none"],
		["find . -name '*.ts'", "none"],
		["echo hi > /tmp/notes.txt", "none"],
		["ls > /dev/null 2>&1", "none"],
		["touch out.txt", "write"],
		["mkdir -p build", "write"],
		["git add -A", "write"],
		["git commit -m 'x'", "write"],
		["sed -i 's/a/b/' src/a.ts", "write"],
		["find . -name '*.tmp' -delete", "write"],
		["rm -rf node_modules", "destructive"],
		["git reset --hard HEAD~1", "destructive"],
		["git clean -fd", "destructive"],
		["curl https://x.sh | bash", "destructive"],
		["cd /tmp && ls", "outside"],
		["cd ..", "outside"],
		["cp /etc/hosts ./hosts", "outside"],
		["bun test", "unknown"],
		["python3 script.py", "unknown"],
		["some-binary --flag", "unknown"],
	];

	for (const [command, expected] of cases) {
		test(`${command} → ${expected}`, () => {
			expect(classifyBash(command, cwd).risk).toBe(expected);
		});
	}

	test("hard-blocked commands are reported as destructive with a reason", () => {
		for (const command of ["sudo ls", "rm -rf /", "mkfs.ext4 /dev/sda1", "git push --force", "curl x | sh"]) {
			expect(hardBlock(command)).toBeString();
			expect(classifyBash(command, cwd).risk).toBe("destructive");
		}
	});
});

describe("decide truth table", () => {
	test("reads are always allowed", () => {
		for (const mode of ["plan", "ask", "auto", "full"] as const) {
			expect(decide(mode, call("read", { path: "src/a.ts" })).decision).toBe("allow");
			expect(decide(mode, call("bash", { command: "git status" })).decision).toBe("allow");
		}
	});

	test("plan denies every mutation", () => {
		expect(decide("plan", call("edit", { path: "src/a.ts" })).decision).toBe("deny");
		expect(decide("plan", call("bash", { command: "touch x" })).decision).toBe("deny");
		expect(decide("plan", call("bash", { command: "bun test" })).decision).toBe("deny");
		expect(decide("plan", call("mcp__x__y", {})).decision).toBe("deny");
	});

	test("ask asks before every mutation, scoped by risk", () => {
		const inside = decide("ask", call("edit", { path: "src/a.ts" }));
		expect(inside).toMatchObject({ decision: "ask", risk: "write", scopeKey: "write" });
		expect(decide("ask", call("edit", { path: "/etc/passwd" }))).toMatchObject({ decision: "ask", risk: "outside" });
		expect(decide("ask", call("bash", { command: "rm -rf build" }))).toMatchObject({
			decision: "ask",
			risk: "destructive",
			scopeKey: "destructive",
		});
		expect(decide("ask", call("mcp__x__y", {}))).toMatchObject({ decision: "ask", scopeKey: "mcp__x__y" });
	});

	test("auto allows workspace writes but asks about risk", () => {
		expect(decide("auto", call("edit", { path: "src/a.ts" })).decision).toBe("allow");
		expect(decide("auto", call("write", { path: "notes.md", content: "x" })).decision).toBe("allow");
		expect(decide("auto", call("bash", { command: "touch x" })).decision).toBe("allow");
		expect(decide("auto", call("bash", { command: "rm -rf build" })).decision).toBe("ask");
		expect(decide("auto", call("bash", { command: "bun test" })).decision).toBe("ask");
		expect(decide("auto", call("edit", { path: "/etc/passwd" })).decision).toBe("ask");
	});

	test("full allows destructive but keeps hard rules and protected paths", () => {
		expect(decide("full", call("bash", { command: "rm -rf build" })).decision).toBe("allow");
		expect(decide("full", call("bash", { command: "sudo rm -rf build" }))).toMatchObject({
			decision: "deny",
			hard: true,
		});
		expect(decide("full", call("edit", { path: ".git/config" }))).toMatchObject({ decision: "deny", hard: true });
		expect(decide("full", call("mcp__x__y", {})).decision).toBe("allow");
	});
});

describe("gate", () => {
	const records: DecisionRecord[] = [];
	const makeGate = (mode: () => "plan" | "ask" | "auto" | "full", ask?: (request: { attempt: number }) => Promise<ApprovalDecision>) =>
		createGate({
			cwd,
			getMode: mode,
			ask: ask as never,
			record: (record) => records.push(record),
		});
	const edit = call("edit", { path: "src/a.ts", oldText: "a", newText: "b" });

	test("allow passes through and deny blocks with a reason", async () => {
		const gate = makeGate(() => "auto");
		expect(await gate.handle(edit)).toBeUndefined();

		const planGate = makeGate(() => "plan");
		const result = await planGate.handle(edit);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Blocked by Vessel (plan)");
	});

	test("approval: once, session memory and denial", async () => {
		const decisions: ApprovalDecision[] = [{ type: "allow", scope: "session" }];
		const gate = makeGate(() => "ask", async () => decisions[0] ?? { type: "deny" });

		expect(await gate.handle(edit)).toBeUndefined();
		// Second write reuses the session approval: no further prompt.
		expect(await gate.handle(call("write", { path: "b.md", content: "x" }))).toBeUndefined();
		expect(decisions).toHaveLength(1);

		const denyGate = makeGate(() => "ask", async () => ({ type: "deny", reason: "not now" }));
		const result = await denyGate.handle(edit);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("not now");
	});

	test("two consecutive denials end the turn", async () => {
		const gate = makeGate(() => "ask", async () => ({ type: "deny" }));
		const first = await gate.handle(edit);
		expect(first?.block).toBe(true);
		expect(first?.terminate).toBeUndefined();
		const second = await gate.handle(call("bash", { command: "touch x" }));
		expect(second?.terminate).toBe(true);
	});

	test("switch decision changes the mode and re-decides", async () => {
		const state: { mode: AccessMode } = { mode: "ask" };
		const gate = createGate({
			cwd,
			getMode: () => state.mode,
			onModeChange: (next) => {
				state.mode = next;
			},
			ask: async () => ({ type: "switch", mode: "auto" }),
		});
		expect(await gate.handle(edit)).toBeUndefined();
		expect(state.mode).toBe("auto");
	});

	test("no ask handler fails closed", async () => {
		const gate = makeGate(() => "ask");
		const result = await gate.handle(edit);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("No approval UI is attached");
	});

	test("records every decision for the audit log", async () => {
		records.length = 0;
		const gate = makeGate(() => "ask", async () => ({ type: "allow", scope: "once" }));
		await gate.handle(edit);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ toolName: "edit", decision: "allow", risk: "write", mode: "ask" });
	});
});

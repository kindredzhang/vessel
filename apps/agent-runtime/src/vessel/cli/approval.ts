import type { ApprovalDecision, ApprovalRequest } from "../access/gate.ts";
import type { AccessMode } from "../access/modes.ts";
import type { Prompter } from "./prompter.ts";

export interface ApproverOptions {
	prompter: Prompter;
	/** `--yes`: approve every call without asking. */
	yes?: boolean;
	/** False when stdin is not a TTY. */
	interactive: boolean;
}

const RISK_COLOR: Record<string, string> = {
	write: "33",
	outside: "35",
	destructive: "31",
	unknown: "36",
};

function paint(tty: boolean) {
	return (code: string, text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
}

/** Render one approval prompt and translate the answer into a decision. */
export function createApprover(options: ApproverOptions): (request: ApprovalRequest) => Promise<ApprovalDecision> {
	const tty = process.stdout.isTTY === true;
	const color = paint(tty);

	return async (request) => {
		if (options.yes) return { type: "allow", scope: "once" };
		if (!options.interactive) {
			return { type: "deny", reason: "no interactive terminal to approve from" };
		}

		const { verdict, description, mode } = request;
		const riskColor = RISK_COLOR[verdict.risk] ?? "33";
		const lines = [
			"",
			`${color("33", "⚠ Approval needed")} ${color("2", `· ${mode} mode`)}`,
			`  ${color("1", request.call.toolName)} ${color(riskColor, `(${verdict.risk})`)} ${description}`,
			`  ${color("2", verdict.reason)}`,
			`  ${color("2", "[y] once   [a] always this session   [d] deny   [s] switch to auto   [⏎] deny")}`,
		];
		process.stdout.write(`${lines.join("\n")}\n`);

		const answer = (await options.prompter.readLine(color("36", "› ")))?.trim().toLowerCase() ?? "";
		const [choice, ...rest] = answer.split(/\s+/u);
		const detail = rest.join(" ");

		switch (choice) {
			case "y":
			case "yes":
				return { type: "allow", scope: "once" };
			case "a":
			case "always":
				return { type: "allow", scope: "session" };
			case "s":
				return { type: "switch", mode: "auto" };
			case "f":
				return { type: "switch", mode: "full" };
			case "d":
			case "deny":
			case "":
				return { type: "deny", reason: detail || undefined };
			default:
				return { type: "deny", reason: `unrecognized answer "${choice}"` };
		}
	};
}

/** Modes the CLI can switch to by name. */
export function isModeAnswer(value: string, modes: readonly AccessMode[]): value is AccessMode {
	return (modes as readonly string[]).includes(value);
}

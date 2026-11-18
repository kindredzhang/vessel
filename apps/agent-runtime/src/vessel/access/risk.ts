import { homedir } from "node:os";
import { resolve, sep } from "node:path";

export type Risk = "none" | "write" | "outside" | "destructive" | "unknown";

const RISK_RANK: Record<Risk, number> = {
	none: 0,
	unknown: 1,
	write: 2,
	outside: 3,
	destructive: 4,
};

export function worstRisk(a: Risk, b: Risk): Risk {
	return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}

export interface PathVerdict {
	kind: "inside" | "outside" | "protected";
	resolved: string;
	reason: string;
}

/** Directories that are never writable, in any mode. */
function protectedDirs(cwd: string): string[] {
	return [resolve(cwd, ".git"), resolve(cwd, ".vessel")];
}

export function classifyPath(rawPath: string, cwd: string): PathVerdict {
	const resolved = resolve(cwd, expandHome(rawPath));
	for (const dir of protectedDirs(cwd)) {
		if (resolved === dir || resolved.startsWith(dir + sep)) {
			return {
				kind: "protected",
				resolved,
				reason: `${resolved} is under ${dir}/, which Vessel never writes to`,
			};
		}
	}
	if (resolved === resolve(cwd) || resolved.startsWith(resolve(cwd) + sep)) {
		return { kind: "inside", resolved, reason: `${resolved} is inside the workspace` };
	}
	return { kind: "outside", resolved, reason: `${resolved} is outside the workspace ${resolve(cwd)}` };
}

/** Commands that are refused even in full-access mode. */
const HARD_BLOCKED: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /^\s*(sudo|doas)\b/u, reason: "privilege escalation is never allowed" },
	{ pattern: /\bmkfs(\.[a-z0-9]+)?\b/u, reason: "formatting a filesystem is never allowed" },
	{ pattern: /\bdd\b[^\n]*\bof=/u, reason: "raw device writes are never allowed" },
	{ pattern: /\brm\s+(-[a-zA-Z-]+\s+)*\/(\s|$)/u, reason: "removing / is never allowed" },
	{ pattern: /\brm\s+(-[a-zA-Z-]+\s+)*~\/?(\s|$)/u, reason: "removing the home directory is never allowed" },
	{ pattern: /:\(\)\s*\{\s*:\s*\|\s*:/u, reason: "fork bombs are never allowed" },
	{ pattern: />\s*\/dev\/(sd|disk|nvme|hd|rdisk)/u, reason: "raw device writes are never allowed" },
	{ pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\/(\s|$)/u, reason: "world-writable / is never allowed" },
	{ pattern: /\bgit\s+push\b[^\n]*(?:^|\s)(--force|--force-with-lease|-f)(?=\s|$)/u, reason: "force-pushing is never allowed" },
	{ pattern: /\b(curl|wget)\b[^\n]*\|\s*(ba|z|k|fi)?sh\b/u, reason: "piping remote code into a shell is never allowed" },
];

export function hardBlock(command: string): string | undefined {
	for (const rule of HARD_BLOCKED) {
		if (rule.pattern.test(command)) return rule.reason;
	}
	return undefined;
}

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /(^|[\s;&|])rm\b/u, reason: "deletes files" },
	{ pattern: /(^|[\s;&|])rmdir\b/u, reason: "deletes directories" },
	{ pattern: /\bshred\b/u, reason: "irreversibly destroys data" },
	{ pattern: /\bgit\s+reset\s+--hard\b/u, reason: "discards uncommitted work" },
	{ pattern: /\bgit\s+clean\b[^\n]*\s-[a-zA-Z]*[fdx]/u, reason: "deletes untracked files" },
	{ pattern: /\bgit\s+checkout\s+(--\s+)?\.\s*$/u, reason: "discards uncommitted work" },
	{ pattern: /(^|[\s;&|])(kill|killall|pkill)\b/u, reason: "terminates processes" },
	{ pattern: /(^|[\s;&|])(shutdown|reboot)\b/u, reason: "affects the host" },
	{ pattern: /\b(curl|wget)\b[^\n]*\|\s*(ba|z|k|fi)?sh\b/u, reason: "pipes remote code into a shell" },
];

const READ_ONLY_COMMANDS = new Set([
	"ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "tree", "rg", "grep",
	"fd", "which", "type", "date", "uname", "whoami", "id", "echo", "printf", "du",
	"df", "basename", "dirname", "realpath", "readlink", "jq", "sort", "uniq", "cut",
	"tr", "diff", "cmp", "md5sum", "shasum", "sha256sum", "ps", "env", "printenv",
	"sleep", "true", "false", "test", "expr", "seq", "column", "less", "more", "bat",
	"ag", "ack", "hexdump", "od", "strings", "tac", "nl", "paste", "comm", "tee-dry",
]);

const WRITE_COMMANDS = new Set([
	"touch", "mkdir", "cp", "mv", "ln", "tee", "truncate", "install", "rsync", "scp",
	"patch", "npm", "pnpm", "yarn", "bun", "pip", "pip3", "cargo", "go", "make",
	"prettier", "eslint", "tsc", "deno-install",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "node", "bun", "deno", "python", "python3", "ruby", "perl", "npx", "bunx", "uv"]);

const GIT_READ_SUBCOMMANDS = new Set([
	"status", "log", "diff", "show", "blame", "ls-files", "rev-parse", "describe",
	"shortlog", "merge-base", "cat-file", "show-ref", "for-each-ref", "grep", "rev-list",
]);

const GIT_WRITE_SUBCOMMANDS = new Set([
	"add", "commit", "apply", "checkout", "switch", "restore", "merge", "rebase",
	"pull", "push", "cherry-pick", "revert", "init", "clone", "mv", "rm", "am",
	"fetch", "submodule", "worktree", "bisect", "filter-branch", "gc", "prune",
]);

const READ_ONLY_GIT_FLAGS = new Set(["-l", "-v", "-a", "--list", "--show-current", "--get", "--get-all", "-ll"]);

function splitSegments(command: string): string[] {
	// `2>&1` is fd duplication, not a background job: drop it before splitting.
	const cleaned = command.replace(/\d*>&\d+/gu, " ");
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < cleaned.length; i += 1) {
		const char = cleaned[i] ?? "";
		if (quote) {
			current += char;
			if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		const pair = cleaned.slice(i, i + 2);
		if (pair === "&&" || pair === "||") {
			segments.push(current);
			current = "";
			i += 1;
			continue;
		}
		if (char === ";" || char === "\n" || char === "|" || char === "&") {
			segments.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	segments.push(current);
	return segments.filter((segment) => segment.trim().length > 0);
}

function stripQuotes(token: string): string {
	const trimmed = token.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	for (const char of segment.trim()) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/u.test(char)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

/** Remove leading `FOO=bar` assignments so the real command becomes tokens[0]. */
function commandTokens(segment: string): string[] {
	const tokens = tokenize(segment);
	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")) index += 1;
	return tokens.slice(index);
}

function classifyRedirects(segment: string, cwd: string): Risk | undefined {
	const redirects = segment.match(/(?:\d?>>?|&>)\s*("[^"]+"|'[^']+'|\S+)/gu);
	if (!redirects) return undefined;
	let risk: Risk | undefined;
	for (const redirect of redirects) {
		const target = redirect.replace(/^(?:\d?>>?|&>)\s*/u, "");
		const cleaned = stripQuotes(target);
		if (cleaned.startsWith("&")) continue; // fd duplication: 2>&1
		if (cleaned === "/dev/null" || cleaned.startsWith("/tmp/")) continue;
		const verdict = classifyPath(cleaned, cwd);
		const candidate: Risk = verdict.kind === "protected" ? "destructive" : verdict.kind === "outside" ? "outside" : "write";
		risk = risk ? worstRisk(risk, candidate) : candidate;
	}
	return risk;
}

function classifyGit(tokens: string[], cwd: string): Risk {
	const sub = tokens[1] ?? "";
	if (GIT_READ_SUBCOMMANDS.has(sub)) return "none";
	if (sub === "branch" || sub === "tag" || sub === "remote" || sub === "stash" || sub === "config" || sub === "reflog") {
		const rest = tokens.slice(2);
		const mutating = rest.some((token) => token.startsWith("-") && !READ_ONLY_GIT_FLAGS.has(token));
		if (sub === "stash" && rest[0] !== undefined && rest[0] !== "list" && rest[0] !== "show") return "write";
		if (sub === "config" && !rest.some((token) => READ_ONLY_GIT_FLAGS.has(token))) return "write";
		return mutating ? "write" : "none";
	}
	if (sub === "reset") return tokens.includes("--hard") ? "destructive" : "write";
	if (GIT_WRITE_SUBCOMMANDS.has(sub)) return "write";
	if (sub === "") return "none";
	return "write";
}

export interface BashRisk {
	risk: Risk;
	reason: string;
}

export function classifyBash(command: string, cwd: string): BashRisk {
	const trimmed = command.trim();
	if (!trimmed) return { risk: "unknown", reason: "empty command" };

	const blocked = hardBlock(trimmed);
	if (blocked) return { risk: "destructive", reason: blocked };

	let risk: Risk = "none";
	const reasons: string[] = [];
	const note = (next: Risk, reason: string): void => {
		risk = worstRisk(risk, next);
		reasons.push(reason);
	};

	// Pipeline-spanning rules (curl | sh) must see the whole command.
	for (const rule of DESTRUCTIVE_PATTERNS) {
		if (rule.pattern.test(trimmed)) note("destructive", rule.reason);
	}

	for (const segment of splitSegments(trimmed)) {
		const redirectRisk = classifyRedirects(segment, cwd);
		if (redirectRisk) note(redirectRisk, "redirects output into a file");

		for (const rule of DESTRUCTIVE_PATTERNS) {
			if (rule.pattern.test(segment)) {
				note("destructive", rule.reason);
				break;
			}
		}

		const tokens = commandTokens(segment);
		const head = tokens[0] ?? "";
		if (!head) continue;

		if (head === "cd") {
			const target = tokens[1];
			if (!target || target === "-") {
				note("unknown", "cd without a path depends on shell state");
				continue;
			}
			const verdict = classifyPath(target, cwd);
			if (verdict.kind === "outside") note("outside", verdict.reason);
			else if (verdict.kind === "protected") note("outside", verdict.reason);
			continue;
		}

		if (head === "find") {
			if (/(?:^|\s)-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)\b/u.test(segment)) {
				note("write", "find with -delete/-exec can change files");
			}
			continue;
		}

		if (head === "sed" || head === "perl") {
			if (/(?:^|\s)-i\b|--in-place\b|-[a-z]*i[a-z]*\b/u.test(segment)) {
				note("write", "edits files in place");
			} else {
				note("unknown", `${head} without -i may still write via scripts`);
			}
			continue;
		}

		if (head === "git") {
			note(classifyGit(tokens, cwd), `git ${tokens[1] ?? ""}`.trim());
			continue;
		}

		if (READ_ONLY_COMMANDS.has(head)) continue;

		if (SHELLS.has(head)) {
			// A shell or interpreter can do anything: never claim it is safe.
			if (head === "bun" || head === "npm" || head === "pnpm" || head === "yarn") {
				const sub = tokens[1] ?? "";
				if (sub === "test" || sub === "run" || sub === "x" || sub === "exec" || sub === "install" || sub === "add" || sub === "remove") {
					note("unknown", `${head} ${sub} runs arbitrary project code`);
				} else {
					note("unknown", `${head} runs project code`);
				}
			} else {
				note("unknown", `${head} can run arbitrary commands`);
			}
			continue;
		}

		if (WRITE_COMMANDS.has(head)) {
			const target = tokens.slice(1).map(stripQuotes).find((token) => {
				if (!token.startsWith("/") && !token.startsWith("~/")) return false;
				return classifyPath(token, cwd).kind !== "inside";
			});
			if (target) {
				const verdict = classifyPath(target, cwd);
				note(verdict.kind === "protected" ? "destructive" : "outside", verdict.reason);
				continue;
			}
			note("write", `${head} writes to the workspace`);
			continue;
		}

		// Unknown commands that take absolute paths outside the workspace.
		const outsideToken = tokens.slice(1).map(stripQuotes).find((token) => {
			if (!token.startsWith("/") && !token.startsWith("~/")) return false;
			return classifyPath(token, cwd).kind !== "inside";
		});
		if (outsideToken) note("outside", `touches ${outsideToken}, outside the workspace`);
		else note("unknown", `${head} is not a known command`);
	}

	if (risk === "none") return { risk: "none", reason: "read-only command" };
	return { risk, reason: reasons.join("; ") };
}

/**
 * Vessel CLI.
 *
 *   bun run vessel "list the files here"    one-shot
 *   bun run vessel                          interactive
 *   bun run vessel --mode plan "how do I …" plan first
 *   bun run vessel --models                 show the models the endpoint reports
  bun run serve                           the agent behind an HTTP API
 */
import { createVesselAgent, type VesselAgent } from "./agent.ts";
import { createApprover } from "./cli/approval.ts";
import { createPrompter, type Prompter } from "./cli/prompter.ts";
import { ACCESS_MODES, MODE_INFO, isAccessMode, type AccessMode } from "./access/modes.ts";
import { pickModel, providerSettings, type VesselThinkingLevel } from "./models.ts";
import { serveCommand } from "./serve.ts";

const tty = process.stdout.isTTY === true;
const paint = (code: string) => (text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = paint("2");
const bold = paint("1");
const cyan = paint("36");
const red = paint("31");
const yellow = paint("33");

interface CliOptions {
	prompt?: string;
	model?: string;
	thinking?: VesselThinkingLevel;
	mode?: AccessMode;
	yes: boolean;
	persist: boolean;
	listModels: boolean;
	help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { persist: false, listModels: false, help: false, yes: false };
	const words: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--model" || arg === "-m") options.model = argv[++i];
		else if (arg === "--thinking" || arg === "-t") options.thinking = argv[++i] as VesselThinkingLevel;
		else if (arg === "--mode") options.mode = parseModeArg(argv[++i]);
		else if (arg === "--yes" || arg === "-y") options.yes = true;
		else if (arg === "--persist") options.persist = true;
		else if (arg === "--models" || arg === "--list-models") options.listModels = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else words.push(arg);
	}
	if (words.length > 0) options.prompt = words.join(" ");
	return options;
}

function parseModeArg(value: string | undefined): AccessMode | undefined {
	if (!value) {
		console.error(red("--mode needs a value: plan | ask | auto | full"));
		process.exitCode = 1;
		return undefined;
	}
	if (isAccessMode(value)) return value;
	console.error(red(`unknown mode "${value}" — plan | ask | auto | full`));
	process.exitCode = 1;
	return undefined;
}

function usage(): void {
	console.log(`${bold("vessel")} — a coding agent built on the Pi SDK

${dim("Usage")}
  bun run vessel [options] [prompt...]

${dim("Options")}
  -m, --model <id>       model id from the endpoint (default $VESSEL_MODEL, else the first listed)
  -t, --thinking <level> off | minimal | low | medium | high | xhigh | max
      --mode <mode>      plan | ask | auto | full (default $VESSEL_ACCESS_MODE, else ask)
  -y, --yes              approve every gated call without asking (headless runs)
      --persist          keep the transcript in <cwd>/.vessel/sessions
      --models           list the models this endpoint reports
  -h, --help             show this help

${dim("Access modes")}
${ACCESS_MODES.map((mode) => `  ${mode.padEnd(5)} ${MODE_INFO[mode].hint}`).join("\n")}

${dim("Interactive commands")}
  /models  /model <id>  /thinking <level>  /mode [plan|ask|auto|full]  /exit

${dim("Environment")}
  VESSEL_BASE_URL        Custom Provider base URL, e.g. https://host/v1 (required)
  VESSEL_API_KEY         Custom Provider API key (required)
  VESSEL_MODEL           default model id
  VESSEL_ACCESS_MODE     default access mode
  VESSEL_SHOW_THINKING   set to 1 to stream thinking deltas

.env is loaded automatically.`);
}

function describeModel(agent: VesselAgent): string {
	const model = agent.model;
	const levels = Object.entries(model.thinkingLevelMap ?? {})
		.filter(([, value]) => value)
		.map(([key]) => key);
	return `${bold(model.name)} ${dim(`(${model.id})`)}${levels.length ? dim(` · thinking: ${levels.join("/")}`) : ""}`;
}

function describeMode(agent: VesselAgent): string {
	const mode = agent.accessMode;
	return `${bold(mode)} ${dim(`(${MODE_INFO[mode].hint})`)}`;
}

function summarizeArgs(args: unknown): string {
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		const key = ["path", "file_path", "command", "pattern", "query"].find((k) => typeof record[k] === "string");
		if (key) return String(record[key]).slice(0, 120);
	}
	const json = JSON.stringify(args ?? {});
	return json.length > 120 ? `${json.slice(0, 117)}...` : json;
}

/** Stream one agent run to stdout. */
function printEvents(agent: VesselAgent, showThinking: boolean): () => void {
	return agent.session.subscribe((event) => {
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta") process.stdout.write(update.delta);
			else if (update.type === "thinking_delta" && showThinking) process.stdout.write(dim(update.delta));
			return;
		}
		if (event.type === "tool_execution_start") {
			process.stdout.write(`\n${cyan("⏺")} ${bold(event.toolName)} ${dim(summarizeArgs(event.args))}\n`);
			return;
		}
		if (event.type === "tool_execution_end" && event.isError) {
			process.stdout.write(`${red("✗")} ${event.toolName} failed\n`);
			return;
		}
		if (event.type === "compaction_start") {
			process.stdout.write(`${dim(`… compacting (${event.reason})`)}\n`);
		}
	});
}

async function runOnce(agent: VesselAgent, prompt: string, showThinking: boolean): Promise<void> {
	const unsubscribe = printEvents(agent, showThinking);
	try {
		await agent.session.prompt(prompt);
		process.stdout.write("\n");
	} finally {
		unsubscribe();
	}
}

function printModels(agent: VesselAgent): void {
	const active = agent.model.id;
	for (const model of agent.catalog.models) {
		const marker = model.id === active ? cyan("●") : dim("○");
		console.log(`${marker} ${model.id}  ${dim(model.name)}`);
	}
	console.log(dim(`\n${agent.catalog.models.length} models from ${agent.catalog.baseUrl}`));
}

function printModeList(agent: VesselAgent): void {
	for (const mode of ACCESS_MODES) {
		const marker = mode === agent.accessMode ? cyan("●") : dim("○");
		console.log(`${marker} ${bold(mode.padEnd(5))} ${MODE_INFO[mode].hint}`);
		console.log(`  ${dim(MODE_INFO[mode].description)}`);
	}
}

async function repl(agent: VesselAgent, showThinking: boolean, prompter: Prompter): Promise<void> {
	prompter.onInterrupt(() => {
		if (!agent.session.isIdle) {
			void agent.session.abort().then(() => process.stdout.write(dim("\n(stopped)")));
		} else {
			prompter.close();
		}
	});

	console.log(dim(`cwd ${agent.cwd}`));
	console.log(dim(`endpoint ${agent.catalog.baseUrl} · ${agent.catalog.models.length} models`));
	console.log(dim(`tools ${agent.session.getActiveToolNames().join(" ")}`));
	console.log(dim("type /help for commands, /exit to quit"));

	try {
		for (;;) {
			const raw = await prompter.readLine(`\n${cyan("›")} `);
			if (raw === null) break;
			const line = raw.trim();
			if (line === "/exit" || line === "/quit") break;
			if (line === "/help") {
				console.log(dim("/models  /model <id>  /thinking <level>  /mode [mode]  /exit"));
			} else if (line === "/models") {
				printModels(agent);
			} else if (line.startsWith("/model")) {
				const id = line.slice("/model".length).trim();
				const next = pickModel(agent.session.modelRuntime, id);
				if (!next) console.log(red("unknown model — see /models"));
				else {
					await agent.session.setModel(next);
					agent.model = next;
					console.log(`model ${describeModel(agent)}`);
				}
			} else if (line.startsWith("/mode")) {
				const wanted = line.slice("/mode".length).trim();
				if (!wanted) {
					console.log(`mode ${describeMode(agent)} · tools ${agent.session.getActiveToolNames().join(" ")}`);
					printModeList(agent);
				} else if (!isAccessMode(wanted)) {
					console.log(red("unknown mode — plan | ask | auto | full"));
				} else {
					agent.setAccessMode(wanted);
					console.log(`mode ${describeMode(agent)} · tools ${agent.session.getActiveToolNames().join(" ")}`);
				}
			} else if (line.startsWith("/thinking")) {
				const level = line.slice("/thinking".length).trim() as VesselThinkingLevel;
				try {
					agent.session.setThinkingLevel(level);
					console.log(dim(`thinking ${agent.session.thinkingLevel}`));
				} catch (error) {
					console.log(red(error instanceof Error ? error.message : String(error)));
				}
			} else if (line.startsWith("/")) {
				console.log(dim("unknown command — /help"));
			} else if (line) {
				await runOnce(agent, line, showThinking);
				console.log(dim(`\n${agent.session.model?.name ?? agent.model.name} · ${agent.session.thinkingLevel} thinking · ${agent.accessMode} mode`));
			}
		}
	} finally {
		prompter.close();
	}
}

export async function main(argv: string[]): Promise<void> {
	if (argv[0] === "serve") {
		await serveCommand(argv.slice(1));
		return;
	}
	const options = parseArgs(argv);
	if (process.exitCode === 1) return;
	if (options.help) {
		usage();
		return;
	}

	if (options.listModels) {
		try {
			providerSettings();
		} catch (error) {
			console.error(red(error instanceof Error ? error.message : String(error)));
			process.exitCode = 1;
			return;
		}
		const probe = await createVesselAgent({ model: options.model, thinkingLevel: options.thinking });
		try {
			printModels(probe);
		} finally {
			probe.dispose();
		}
		return;
	}

	const prompter = createPrompter();
	const ask = createApprover({
		prompter,
		yes: options.yes,
		interactive: process.stdin.isTTY === true,
	});

	let agent: VesselAgent;
	try {
		agent = await createVesselAgent({
			model: options.model,
			thinkingLevel: options.thinking,
			accessMode: options.mode,
			persist: options.persist,
			ask,
		});
	} catch (error) {
		prompter.close();
		console.error(red(error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
		return;
	}

	const showThinking = process.env.VESSEL_SHOW_THINKING === "1";

	try {
		if (options.prompt) {
			await runOnce(agent, options.prompt, showThinking);
			return;
		}
		console.log(`${bold("vessel")} ${dim("·")} ${describeModel(agent)} ${dim("·")} ${describeMode(agent)}`);
		if (options.yes) console.log(yellow("--yes: every gated call is approved without asking"));
		await repl(agent, showThinking, prompter);
	} finally {
		agent.dispose();
		prompter.close();
	}
}

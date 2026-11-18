/**
 * Vessel's agent: the smallest useful Pi SDK session.
 *
 * One workspace, one conversation, every model a Custom Provider endpoint
 * lists, the seven built-in coding tools, and one gate that decides whether a
 * tool call may run. Nothing is discovered from ~/.pi/agent, so the same inputs
 * produce the same agent on every machine.
 */
import { resolve } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	SettingsManager,
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createAccessExtension } from "./access/extension.ts";
import { createAuditLogger, createGate } from "./access/gate.ts";
import {
	isAccessMode,
	parseAccessMode,
	toolsFor,
	type AccessMode,
} from "./access/modes.ts";
import type { ApprovalDecision, ApprovalRequest } from "./access/gate.ts";
import {
	createProviderRuntime,
	loadModelCatalog,
	pickModel,
	type ModelCatalog,
	type ProviderSettings,
	providerSettings,
	type VesselThinkingLevel,
} from "./models.ts";

export const VESSEL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

const ACCESS_MODE_ENTRY = "vessel.accessMode";

export function vesselSystemPrompt(cwd: string): string {
	return `You are Vessel, a focused coding agent working in ${cwd}.

You have read, bash, edit, write, grep, find and ls. Inspect before you change
anything, make the smallest edit that solves the problem, then verify it.

Rules:
- Use read/grep/find/ls for inspection; use bash for commands, tests and builds.
- Never claim a command succeeded without looking at its output.
- Keep answers short and concrete, and reply in the user's language.`;
}

export interface VesselAgentOptions {
	/** Workspace the built-in tools operate on. Default: process.cwd() */
	cwd?: string;
	/** Model id from the endpoint's list. Default: $VESSEL_MODEL or the first model listed. */
	model?: string;
	/** Thinking level, clamped to what the chosen model supports. Default: "medium". */
	thinkingLevel?: VesselThinkingLevel;
	/** Enabled tools. Default: VESSEL_TOOLS. */
	tools?: string[];
	/** Keep the transcript under <cwd>/.vessel/sessions. Default: false (in memory). */
	persist?: boolean;
	/** Inject a catalog instead of fetching it from the endpoint. */
	catalog?: ModelCatalog;
	/** Inject endpoint settings instead of reading VESSEL_BASE_URL / VESSEL_API_KEY. */
	settings?: ProviderSettings;
	/** Starting file-access mode. Default: $VESSEL_ACCESS_MODE, else "ask". */
	accessMode?: AccessMode;
	/** Approval handler. Without one, `ask` decisions fail closed. */
	ask?(request: ApprovalRequest): Promise<ApprovalDecision>;
	/** Where to append the JSONL audit log. Default: <cwd>/.vessel/audit.jsonl; false disables it. */
	auditPath?: string | false;
	/** Allow destructive commands in full mode (default true; hard rules still apply). */
	allowDestructiveInFull?: boolean;
}

export interface VesselAgent {
	session: AgentSession;
	model: NonNullable<AgentSession["model"]>;
	catalog: ModelCatalog;
	cwd: string;
	/** Current file-access mode. */
	get accessMode(): AccessMode;
	/** Change mode: swaps the declared toolset and is recorded in the session. */
	setAccessMode(mode: AccessMode): void;
	dispose(): void;
}

function lastRecordedMode(sessionManager: SessionManager): AccessMode | undefined {
	const entries = sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== ACCESS_MODE_ENTRY) continue;
		const data = entry.data as { mode?: unknown } | undefined;
		if (typeof data?.mode === "string" && isAccessMode(data.mode)) return data.mode;
	}
	return undefined;
}

export async function createVesselAgent(options: VesselAgentOptions = {}): Promise<VesselAgent> {
	const cwd = options.cwd ?? process.cwd();
	const settings = options.settings ?? providerSettings();
	const catalog = options.catalog ?? (await loadModelCatalog({ settings }));
	const modelRuntime = await createProviderRuntime(catalog, settings);
	const model = pickModel(modelRuntime, options.model ?? process.env.VESSEL_MODEL);
	if (!model) throw new Error(`${settings.baseUrl}/models listed no usable model`);

	const sessionManager = options.persist
		? SessionManager.create(cwd, `${cwd}/.vessel/sessions`)
		: SessionManager.inMemory(cwd);
	const settingsManager = SettingsManager.inMemory({ defaultTools: [...VESSEL_TOOLS] });

	const baseTools = options.tools ? [...options.tools] : [...VESSEL_TOOLS];
	let mode: AccessMode =
		lastRecordedMode(sessionManager) ?? options.accessMode ?? parseAccessMode(process.env.VESSEL_ACCESS_MODE) ?? "ask";

	const gate = createGate({
		cwd,
		getMode: () => mode,
		ask: options.ask,
		onModeChange: (next) => setAccessMode(next),
		record: createAuditLogger(options.auditPath ?? resolve(cwd, ".vessel", "audit.jsonl")),
		policy: { allowDestructiveInFull: options.allowDestructiveInFull },
	});

	/** Function declaration so the gate's onModeChange can reference it. */
	function setAccessMode(next: AccessMode): void {
		mode = next;
		gate.clearSessionAllows();
		session.setActiveToolsByName(toolsFor(next, baseTools));
		sessionManager.appendCustomEntry(ACCESS_MODE_ENTRY, { mode: next });
	}

	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: resolve(cwd, ".vessel", "agent"),
		settingsManager,
		noExtensions: true, // no on-disk extensions: the access gate is the only one
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: vesselSystemPrompt(cwd),
		extensionFactories: [createAccessExtension(gate, () => mode, cwd)],
	});
	await loader.reload();

	// Register every tool: `tools` here is an allowlist, so a tool excluded at
	// construction can never be reactivated by a later mode switch.
	const tools = baseTools;
	const { session } = await createAgentSession({
		cwd,
		model,
		modelRuntime,
		thinkingLevel: options.thinkingLevel ?? "medium",
		tools,
		sessionManager,
		settingsManager,
		resourceLoader: loader,
	});
	// The plan mode declares a smaller toolset; apply it after construction.
	session.setActiveToolsByName(toolsFor(mode, tools));

	return {
		session,
		model,
		catalog,
		cwd,
		get accessMode() {
			return mode;
		},
		setAccessMode,
		dispose: () => session.dispose(),
	};
}

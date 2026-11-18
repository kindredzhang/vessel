/**
 * Vessel — a small coding agent built on the Pi SDK.
 *
 *   import { createVesselAgent } from "./agent.ts";
 *
 *   const vessel = await createVesselAgent({ cwd: process.cwd() });
 *   try {
 *     vessel.session.subscribe((event) => { ... });
 *     await vessel.session.prompt("What does this project do?");
 *   } finally {
 *     vessel.dispose();
 *   }
 */
export {
	createVesselAgent,
	VESSEL_TOOLS,
	vesselSystemPrompt,
	type VesselAgent,
	type VesselAgentOptions,
} from "./agent.ts";
export {
	createProviderRuntime,
	loadModelCatalog,
	pickModel,
	PROVIDER_ID,
	PROVIDER_NAME,
	providerSettings,
	type ModelCatalog,
	type ProviderSettings,
	type VesselModel,
	type VesselThinkingLevel,
} from "./models.ts";
export {
	ACCESS_MODES,
	MODE_INFO,
	isAccessMode,
	parseAccessMode,
	modePrompt,
	toolsFor,
	type AccessMode,
} from "./access/modes.ts";
export { decide, describeCall, type Decision, type ToolCall, type Verdict } from "./access/policy.ts";
export {
	createAuditLogger,
	createGate,
	type ApprovalDecision,
	type ApprovalRequest,
	type DecisionRecord,
	type Gate,
	type GateOptions,
} from "./access/gate.ts";
export { classifyBash, classifyPath, hardBlock, type Risk } from "./access/risk.ts";

import { createVesselAgent } from "../agent.ts";
import type { VesselThinkingLevel } from "../models.ts";
import { adaptAgent, type CreateAgent } from "./agent.ts";

/** Wire the real SDK-backed agent into the HTTP service. */
export const createRuntimeAgent: CreateAgent = async (options) => {
	const agent = await createVesselAgent({
		model: options.model,
		accessMode: options.accessMode,
		ask: options.ask,
		// The CLI defaults to medium; a served runtime lets the environment tune it,
		// which matters on gateways whose reasoning eats the whole budget.
		thinkingLevel: process.env.VESSEL_THINKING as VesselThinkingLevel | undefined,
	});
	return adaptAgent(agent);
};

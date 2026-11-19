/**
 * `vessel serve` — the same agent behind an HTTP API, for the desktop app.
 *
 *   bun run serve            # http://127.0.0.1:8787
 *   bun run serve --port 9000 --host 0.0.0.0
 */
import { createRuntimeAgent } from "./server/runtime.ts";
import { createVesselService, type VesselService } from "./server/service.ts";
import { isAccessMode, type AccessMode } from "./access/modes.ts";

const DEFAULT_PORT = 8787;

interface ServeOptions {
	port: number;
	host: string;
	token?: string;
	mode?: AccessMode;
	help: boolean;
}

function usage(): void {
	console.log(`vessel serve — Vessel agent over HTTP

Usage
  bun run serve [options]

Options
  --port <n>     port to listen on (default $VESSEL_SERVER_PORT or ${DEFAULT_PORT})
  --host <addr>  interface to bind (default 127.0.0.1; 0.0.0.0 exposes the
                 agent's shell to your network — pair it with --token)
  --token <t>    require a bearer token (default $VESSEL_SERVER_TOKEN)
  --mode <mode>  starting file-access mode: plan | ask | auto | full
  -h, --help     this text

API
  GET  /healthz
  GET  /v1/sessions              POST /v1/sessions {accessMode?, model?}
  GET  /v1/sessions/:id          DELETE /v1/sessions/:id
  POST /v1/sessions/:id/turns {prompt}        → text/event-stream
  POST /v1/sessions/:id/approvals {requestId, decision}
  POST /v1/sessions/:id/mode {mode}           POST /v1/sessions/:id/abort`);
}

function parse(argv: string[]): ServeOptions {
	const options: ServeOptions = {
		port: Number(process.env.VESSEL_SERVER_PORT ?? DEFAULT_PORT),
		host: "127.0.0.1",
		token: process.env.VESSEL_SERVER_TOKEN || undefined,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--port" || arg === "-p") options.port = Number(argv[++i]);
		else if (arg === "--host") options.host = argv[++i] ?? options.host;
		else if (arg === "--token") options.token = argv[++i];
		else if (arg === "--mode") {
			const value = argv[++i];
			if (value && isAccessMode(value)) options.mode = value;
			else {
				console.error(`unknown mode "${value}" — plan | ask | auto | full`);
				process.exitCode = 1;
			}
		} else if (arg === "--help" || arg === "-h") options.help = true;
		else {
			console.error(`unknown option ${arg}`);
			process.exitCode = 1;
		}
	}
	return options;
}

export async function serveCommand(argv: string[]): Promise<void> {
	const options = parse(argv);
	if (options.help) {
		usage();
		return;
	}
	if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
		console.error(`invalid port ${options.port}`);
		process.exitCode = 1;
		return;
	}
	if (options.mode) process.env.VESSEL_ACCESS_MODE = options.mode;
	if (options.host !== "127.0.0.1" && options.host !== "localhost" && !options.token) {
		console.error("binding a non-loopback address without --token would expose the agent; pass a token");
		process.exitCode = 1;
		return;
	}

	const service: VesselService = createVesselService({ createAgent: createRuntimeAgent, token: options.token });
	const server = Bun.serve({
		port: options.port,
		hostname: options.host,
		// A turn can be quiet for minutes while the model thinks; Bun's default
		// 10s idle timeout would cut the stream. Heartbeats do the rest.
		idleTimeout: 255,
		fetch: (request) => service.fetch(request),
	});

	console.log(`vessel serve · http://${options.host}:${server.port}${options.token ? " · token required" : ""}`);
	console.log("POST /v1/sessions to start, then POST /v1/sessions/:id/turns");

	const shutdown = (): void => {
		service.close();
		void server.stop();
		// Open SSE streams keep the loop alive; exit once they are cut, otherwise
		// a killed `serve` lingers as a zombie holding sessions nobody can reach.
		setTimeout(() => process.exit(0), 300);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	await new Promise(() => {});
}

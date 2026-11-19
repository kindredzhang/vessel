import { Plus, Trash2, Cpu, Radio } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
	ACCESS_MODES,
	ApiError,
	MODE_INFO,
	type AccessMode,
	type Decision,
	type Message,
	type SessionView,
	RuntimeClient,
} from "./api";
import { TurnChannel, messageOf, type ApprovalRequest } from "./chat/channel";
import { VesselThread } from "./chat/Thread";
import { WireChatProvider } from "./chat/wireRuntime";
import { Runtime, type Info } from "./mygo";

export function App() {
	const [info, setInfo] = useState<Info | null>(null);
	const [client, setClient] = useState<RuntimeClient | null>(null);
	const [reachable, setReachable] = useState<boolean | null>(null);

	const [sessions, setSessions] = useState<SessionView[]>([]);
	const [active, setActive] = useState<string | null>(null);
	const [history, setHistory] = useState<Message[]>([]);
	const [mountToken, setMountToken] = useState(0);
	const [mode, setMode] = useState<AccessMode>("ask");
	const [approval, setApproval] = useState<ApprovalRequest | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const modeRef = useRef<AccessMode>("ask");
	modeRef.current = mode;

	useEffect(() => {
		let cancelled = false;
		Runtime.info()
			.then((next) => {
				if (!cancelled) setInfo(next);
			})
			.catch(() => {
				if (cancelled) return;
				setInfo({
					app: "Vessel",
					version: "web",
					os: "web",
					arch: "",
					goVersion: "",
					apiBaseUrl: "http://localhost:8080",
					agentUrl: import.meta.env.VITE_AGENT_URL ?? "http://127.0.0.1:8787",
				});
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// The runtime address is the only thing that decides whether we can chat.
	useEffect(() => {
		if (!info) return;
		const next = new RuntimeClient(info.agentUrl);
		let cancelled = false;
		next
			.listSessions()
			.then((list) => {
				if (cancelled) return;
				setClient(next);
				setReachable(true);
				setSessions(list);
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setClient(next);
				setReachable(false);
				setNotice(
					`The agent runtime at ${info.agentUrl} did not answer (${messageOf(error)}). Start it with \`bun run serve\` in apps/agent-runtime.`,
				);
			});
		return () => {
			cancelled = true;
		};
	}, [info]);

	const refreshSessions = useCallback(async (target: RuntimeClient) => {
		try {
			const list = await target.listSessions();
			setSessions(list);
			setReachable(true);
		} catch {
			setReachable(false);
		}
	}, []);

	const channel = useMemo(() => {
		if (!client) return null;
		return new TurnChannel(
			client,
			{
				approval: (request) => setApproval(request),
				settled: (summary) => {
					setApproval(null);
					setMode(summary.accessMode);
					if (summary.silent) setNotice("The model finished without saying anything. Try a different model or /thinking.");
					void refreshSessions(client);
				},
				failed: (message) => {
					setApproval(null);
					setNotice(message);
				},
				sessionStarted: (session) => {
					setActive(session.id);
					setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
				},
			},
			() => modeRef.current,
		);
	}, [client, refreshSessions]);

	const openSession = useCallback(
		async (session: SessionView) => {
			if (!client || !channel) return;
			setNotice(null);
			setApproval(null);
			channel.attach(session);
			setActive(session.id);
			setMode(session.accessMode);
			// History first: the runtime only reads it when it mounts.
			try {
				const full = await client.getSession(session.id);
				setHistory(full.messages);
			} catch (error) {
				setHistory([]);
				setNotice(`That session is gone (${messageOf(error)}).`);
				void refreshSessions(client);
			}
			setMountToken((token) => token + 1);
		},
		[client, channel, refreshSessions],
	);

	const newSession = useCallback(() => {
		channel?.detach();
		setActive(null);
		setHistory([]);
		setApproval(null);
		setNotice(null);
		setMountToken((token) => token + 1);
	}, [channel]);

	const changeMode = useCallback(
		async (next: AccessMode) => {
			setMode(next);
			const id = channel?.id ?? active;
			if (!client || !id) return;
			try {
				const session = await client.setMode(id, next);
				setMode(session.accessMode);
				void refreshSessions(client);
			} catch (error) {
				setNotice(`Could not switch mode: ${messageOf(error)}`);
			}
		},
		[active, channel, client, refreshSessions],
	);

	const decide = useCallback(
		async (decision: Decision) => {
			const request = approval;
			const id = channel?.id ?? active;
			if (!client || !request || !id) return;
			setApproval(null);
			try {
				await client.decide(id, request.requestId, decision);
			} catch (error) {
				setNotice(`Approval did not land: ${messageOf(error)}`);
			}
		},
		[active, approval, channel, client],
	);

	const removeSession = useCallback(
		async (session: SessionView) => {
			if (!client) return;
			try {
				await client.deleteSession(session.id);
			} catch {
				// deleting something already gone is not worth a banner
			}
			if (session.id === active) newSession();
			void refreshSessions(client);
		},
		[active, client, newSession, refreshSessions],
	);

	const chat = useMemo(() => {
		if (!channel) return null;
		// One route: the AI SDK transport assembles the messages, assistant-ui
		// renders them. Remounting on the token reseeds the thread with history.
		return (
			<div key={mountToken}>
				<WireChatProvider channel={channel} history={history}>
					<VesselThread footer={<ApprovalCard request={approval} onDecide={decide} />} />
				</WireChatProvider>
			</div>
		);
	}, [approval, channel, decide, history, mountToken]);

	const model = active ? sessions.find((item) => item.id === active)?.model : sessions[0]?.model;

	return (
		<div className="flex h-full min-h-0">
			<aside className="flex w-[15.5rem] shrink-0 flex-col border-r border-line bg-paper">
				<header className="flex items-baseline justify-between px-4 pb-3 pt-4">
					<h1 className="font-serif text-[19px] tracking-tight text-ink">vessel</h1>
					<span className="label">{info ? info.version : "…"}</span>
				</header>

				<button
					type="button"
					onClick={newSession}
					className="mx-3 mb-3 flex items-center gap-2 rounded-md border border-line bg-raised px-3 py-2 text-left text-[13px] text-ink-soft transition hover:border-line-strong hover:text-ink"
				>
					<Plus className="size-3.5" />
					New session
				</button>

				<div className="min-h-0 flex-1 overflow-y-auto px-2">
					<p className="label px-2 pb-1.5 pt-2">sessions</p>
					{sessions.length === 0 ? (
						<p className="px-2 py-1 text-[12.5px] leading-relaxed text-muted">No sessions yet.</p>
					) : (
						<ul className="flex flex-col">
							{sessions.map((session) => (
								<li key={session.id}>
									<div
										className={`group flex items-center gap-1 rounded-md pr-1 ${
											session.id === active ? "bg-accent-soft" : "hover:bg-raised"
										}`}
									>
										<button
											type="button"
											onClick={() => void openSession(session)}
											className="min-w-0 flex-1 px-2 py-1.5 text-left"
										>
											<span className="block truncate text-[13px] text-ink">
												{firstLine(session.messages) || "New conversation"}
											</span>
											<span className="label">{clockOf(session.createdAt)}</span>
										</button>
										<button
											type="button"
											onClick={() => void removeSession(session)}
											aria-label="Delete session"
											className="p-1 text-muted opacity-0 transition group-hover:opacity-100 hover:text-bad"
										>
											<Trash2 className="size-3.5" />
										</button>
									</div>
								</li>
							))}
						</ul>
					)}
				</div>

				<footer className="flex flex-col gap-1.5 border-t border-line px-4 py-3">
					<span className="label flex items-center gap-1.5">
						<Radio className={`size-3 ${reachable ? "text-accent" : "text-bad"}`} />
						{reachable === null ? "connecting" : reachable ? "runtime online" : "runtime offline"}
					</span>
					<span className="label flex items-center gap-1.5">
						<Cpu className="size-3" />
						{model ? model.name : "no model"}
					</span>
					<span className="truncate font-mono text-[10.5px] text-muted">{info?.agentUrl ?? "…"}</span>
				</footer>
			</aside>

			<main className="flex min-h-0 min-w-0 flex-1 flex-col">
				<TopBar mode={mode} onMode={changeMode} />

				{notice ? (
					<div className="flex items-start justify-between gap-4 border-b border-warn/30 bg-warn-soft px-7 py-2.5">
						<p className="text-[13px] leading-relaxed text-warn">{notice}</p>
						<button type="button" onClick={() => setNotice(null)} className="label shrink-0 hover:text-ink">
							dismiss
						</button>
					</div>
				) : null}

				<div className="min-h-0 flex-1">{chat ?? <div className="p-7 label">connecting…</div>}</div>
			</main>
		</div>
	);
}

function TopBar(props: { mode: AccessMode; onMode: (mode: AccessMode) => void }) {
	return (
		<header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line px-7 py-3">
			<div className="flex items-center gap-1 rounded-md border border-line bg-raised p-0.5">
				{ACCESS_MODES.map((mode) => (
					<button
						key={mode}
						type="button"
						onClick={() => props.onMode(mode)}
						title={MODE_INFO[mode].hint}
						className={`rounded px-2.5 py-1 text-[12px] transition ${
							mode === props.mode ? "bg-accent text-paper" : "text-ink-soft hover:text-ink"
						}`}
					>
						{MODE_INFO[mode].label}
					</button>
				))}
			</div>

			<span className="label">ai sdk transport</span>
		</header>
	);
}

function ApprovalCard(props: { request: ApprovalRequest | null; onDecide: (decision: Decision) => void }) {
	const request = props.request;
	if (!request) return null;
	return (
		<div className="rounded-[10px] border border-warn/40 bg-warn-soft px-4 py-3">
			<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
				<span className="label text-warn">approval needed</span>
				<span className="font-mono text-[12.5px] text-ink">
					{request.toolName} · risk {request.risk} · {MODE_INFO[request.mode].label.toLowerCase()} mode
				</span>
			</div>
			<p className="mt-1.5 break-words font-mono text-[12.5px] leading-relaxed text-ink-soft">
				{request.description}
			</p>
			<div className="mt-3 flex flex-wrap gap-2">
				<button type="button" onClick={() => props.onDecide("allow")} className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] text-paper">
					Allow once
				</button>
				<button type="button" onClick={() => props.onDecide("always")} className="rounded-md border border-line-strong bg-raised px-3 py-1.5 text-[12.5px] text-ink">
					Always this session
				</button>
				<button type="button" onClick={() => props.onDecide("deny")} className="rounded-md border border-bad/40 bg-raised px-3 py-1.5 text-[12.5px] text-bad">
					Deny
				</button>
				<button type="button" onClick={() => props.onDecide("auto")} className="rounded-md px-3 py-1.5 text-[12.5px] text-ink-soft hover:text-ink">
					Switch to Auto
				</button>
			</div>
		</div>
	);
}

function firstLine(messages: Message[]): string {
	const first = messages.find((message) => message.role === "user");
	return (first?.text ?? "").split("\n")[0]?.slice(0, 60) ?? "";
}

function clockOf(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export { ApiError };

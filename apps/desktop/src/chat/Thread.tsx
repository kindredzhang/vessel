import {
	AuiIf,
	ActionBarPrimitive,
	ComposerPrimitive,
	MessagePartPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
	useAui,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowUp, Square, Wrench } from "lucide-react";
import { useState, type ReactNode } from "react";

const STARTERS = [
	"What is in this workspace?",
	"Read src/vessel/cli.ts and explain the REPL",
	"Add a --json flag to the models command",
];

/**
 * The thread, built from assistant-ui primitives and styled with vessel's
 * paper-and-ink tokens. No prebuilt element components: the layout is ours,
 * the behaviour (streaming, composer, branching, tool parts) is theirs.
 */
export function VesselThread({ footer }: { footer?: ReactNode }) {
	return (
		<ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
			<ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-[46rem] flex-col gap-7 px-7 py-9">
					<AuiIf condition={(state) => state.thread.isEmpty}>
						<EmptyState />
					</AuiIf>

					<ThreadPrimitive.Messages>
						{({ message }) =>
							message.role === "user" ? <UserMessage /> : <AssistantMessage />
						}
					</ThreadPrimitive.Messages>
				</div>
			</ThreadPrimitive.Viewport>

			<ThreadPrimitive.ViewportFooter className="shrink-0 border-t border-line bg-paper/80 px-7 pb-5 pt-4 backdrop-blur">
				<div className="mx-auto flex w-full max-w-[46rem] flex-col gap-3">
					{footer}
					<Composer />
					<div className="flex items-center justify-between px-1">
						<span className="label">
							<AuiIf condition={(state) => state.thread.isRunning}>working…</AuiIf>
							<AuiIf condition={(state) => !state.thread.isRunning}>enter sends · shift+enter newline</AuiIf>
						</span>
						<span className="label">vessel runtime</span>
					</div>
				</div>
			</ThreadPrimitive.ViewportFooter>
		</ThreadPrimitive.Root>
	);
}

/** The composer commits its text on the next tick, so sending waits for it. */
async function sendStarter(aui: ReturnType<typeof useAui>, text: string): Promise<void> {
	const composer = aui.thread.composer();
	composer.setText(text);
	await new Promise((resolve) => setTimeout(resolve, 0));
	composer.send();
}

function EmptyState() {
	const aui = useAui();
	return (
		<div className="flex min-h-[58vh] flex-col justify-center gap-7">
			<div className="flex flex-col gap-3">
				<h2 className="font-serif text-[28px] leading-tight text-ink">vessel</h2>
				<p className="max-w-[34rem] font-serif text-[15.5px] leading-relaxed text-ink-soft">
					A coding agent with a body. Ask it about this workspace, or tell it what to build — it reads,
					runs and edits through the runtime you started with <code className="font-mono text-[13px]">bun run serve</code>.
				</p>
			</div>
			<div className="flex flex-wrap gap-2">
				{STARTERS.map((text) => (
					<button
						key={text}
						type="button"
						onClick={() => void sendStarter(aui, text)}
						className="rounded-full border border-line bg-raised px-3.5 py-1.5 text-left font-serif text-[13.5px] text-ink-soft transition hover:border-line-strong hover:text-ink"
					>
						{text}
					</button>
				))}
			</div>
		</div>
	);
}

function UserMessage() {
	return (
		<MessagePrimitive.Root className="group flex flex-col items-end gap-2">
			<span className="label">you</span>
			<div className="max-w-[85%] whitespace-pre-wrap rounded-[10px] border border-line bg-raised px-4 py-2.5 text-[14.5px] leading-relaxed text-ink">
				<MessagePrimitive.Parts>
					{({ part }) => (part.type === "text" ? <MessagePartPrimitive.Text /> : null)}
				</MessagePrimitive.Parts>
			</div>
			<ActionBarPrimitive.Root className="flex gap-3 opacity-0 transition group-hover:opacity-100" hideWhenRunning>
				<ActionBarPrimitive.Edit className="label hover:text-ink">edit</ActionBarPrimitive.Edit>
			</ActionBarPrimitive.Root>
		</MessagePrimitive.Root>
	);
}

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="group flex flex-col gap-2.5">
			<span className="label">vessel</span>
			<div className="flex flex-col gap-3">
				<MessagePrimitive.Parts>
					{({ part }) => {
						switch (part.type) {
							case "text":
								return <MarkdownTextPrimitive className="prose-vessel" />;
							case "reasoning":
								return <Reasoning text={part.text} running={part.status?.type === "running"} />;
							case "tool-call":
								return <ToolRow part={part} />;
							default:
								return null;
						}
					}}
				</MessagePrimitive.Parts>
			</div>
			<AuiIf condition={(state) => state.message.status?.type === "running"}>
				<span className="flex gap-1.5 py-1">
					<i className="size-1.5 animate-pulse rounded-full bg-accent [animation-delay:0ms]" />
					<i className="size-1.5 animate-pulse rounded-full bg-accent [animation-delay:180ms]" />
					<i className="size-1.5 animate-pulse rounded-full bg-accent [animation-delay:360ms]" />
				</span>
			</AuiIf>
			<ActionBarPrimitive.Root className="flex gap-3 opacity-0 transition group-hover:opacity-100" hideWhenRunning>
				<ActionBarPrimitive.Copy className="label hover:text-ink">copy</ActionBarPrimitive.Copy>
				<ActionBarPrimitive.Reload className="label hover:text-ink">retry</ActionBarPrimitive.Reload>
			</ActionBarPrimitive.Root>
		</MessagePrimitive.Root>
	);
}

function Reasoning({ text, running }: { text: string; running: boolean }) {
	const [open, setOpen] = useState(false);
	if (!text.trim()) return null;
	return (
		<div className="rounded-[10px] border border-line/70 bg-paper">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex w-full items-center gap-2 px-3 py-2 text-left"
			>
				<span className="label">{open ? "▾" : "▸"} thinking</span>
				<span className="text-[12px] text-muted">{running ? "in progress" : `${text.length} chars`}</span>
			</button>
			{open ? (
				<pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-line/70 px-3 py-2 font-mono text-[12px] leading-relaxed text-muted">
					{text}
				</pre>
			) : null}
		</div>
	);
}

function ToolRow({ part }: { part: { toolName: string; args?: unknown; result?: unknown; isError?: boolean } }) {
	const summary = summaryOf(part.args);
	const failed = part.isError === true;
	const running = part.result === undefined;
	return (
		<div
			className={`flex items-baseline gap-2.5 border-l-2 py-0.5 pl-3 font-mono text-[12.5px] ${
				failed ? "border-bad text-bad" : "border-line-strong text-ink-soft"
			}`}
		>
			<Wrench className={`size-3 shrink-0 translate-y-0.5 ${failed ? "text-bad" : "text-accent"}`} />
			<span className="font-medium">{part.toolName}</span>
			{summary ? <span className="truncate text-muted">{summary}</span> : null}
			{running ? <span className="text-muted">…</span> : null}
			{failed ? <span>failed</span> : null}
		</div>
	);
}

function summaryOf(args: unknown): string {
	if (args && typeof args === "object" && "summary" in args) {
		const summary = (args as { summary?: unknown }).summary;
		if (typeof summary === "string") return summary;
	}
	return "";
}

function Composer() {
	return (
		<ComposerPrimitive.Root className="flex items-end gap-2 rounded-[10px] border border-line-strong bg-raised px-3 py-2.5 shadow-[0_1px_0_rgba(0,0,0,0.02)] focus-within:border-accent">
			<ComposerPrimitive.Input
				autoFocus
				rows={1}
				placeholder="Ask vessel to read, run or change something…"
				className="max-h-40 flex-1 resize-none bg-transparent py-1 font-serif text-[15px] leading-relaxed text-ink outline-none placeholder:font-sans placeholder:text-[13.5px] placeholder:text-muted"
			/>
			<AuiIf condition={(state) => !state.thread.isRunning}>
				<ComposerPrimitive.Send
					className="flex size-8 items-center justify-center rounded-md bg-accent text-paper transition disabled:opacity-30"
					aria-label="Send"
				>
					<ArrowUp className="size-4" />
				</ComposerPrimitive.Send>
			</AuiIf>
			<AuiIf condition={(state) => state.thread.isRunning}>
				<ComposerPrimitive.Cancel
					className="flex size-8 items-center justify-center rounded-md border border-line-strong text-ink-soft"
					aria-label="Stop"
				>
					<Square className="size-3.5" />
				</ComposerPrimitive.Cancel>
			</AuiIf>
		</ComposerPrimitive.Root>
	);
}

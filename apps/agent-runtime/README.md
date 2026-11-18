# @vessel/agent-runtime

The agent half of [vessel](../../README.md): a coding agent built on the
[Pi coding agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
Vessel owns its workspace, prompt, tools, and model catalog — it does not inherit
`~/.pi/agent`, so the same inputs produce the same agent everywhere.

Models come from one **Custom Provider**: any OpenAI-compatible endpoint whose base
URL and API key you set in the environment. At startup Vessel calls `GET /models`
and registers **every** model the endpoint reports — no owner filter, no hardcoded
list. Point it at a different gateway and it picks up that gateway's models instead.

```bash
cd apps/agent-runtime
cp .env.example .env   # then fill in VESSEL_BASE_URL and VESSEL_API_KEY
```

## Run

```bash
bun install
bun run vessel                                  # interactive
bun run vessel "列出这个项目的文件"                # one-shot
bun run vessel --models                         # list the endpoint's models
bun run vessel -m deepseek-v4.1-flash -t high "解释 src/"
bun run vessel --mode plan "重构 src/vessel 的步骤"   # plan first, no writes
bun run vessel --mode ask "升级依赖"                 # ask before each change
bun run vessel --yes "跑一遍测试并修复失败"           # headless: auto-approve
bun run vessel --persist                        # transcript in ./.vessel/sessions
```

Interactive commands: `/models`, `/model <id>`, `/thinking <level>`,
`/mode [plan|ask|auto|full]`, `/exit`. Ctrl+C stops the running turn.

Environment:

| Variable               | Default            | Meaning                                        |
| ---------------------- | ------------------ | ---------------------------------------------- |
| `VESSEL_BASE_URL`      | — required         | Custom Provider base URL, e.g. `https://h/v1`  |
| `VESSEL_API_KEY`       | — required         | bearer token for that endpoint                 |
| `VESSEL_MODEL`         | first listed model | default model id                               |
| `VESSEL_ACCESS_MODE`   | `ask`              | default file-access mode                       |
| `VESSEL_SHOW_THINKING` | unset              | `1` streams reasoning deltas                   |

`.env` is loaded automatically. `-m` accepts the exact id, an id with the
`custom-provider/` prefix, or a unique suffix (`-m deepseek-v4.1-flash`).
The provider is registered as `custom-provider` / “Custom Provider”; each model
keeps its own context window, output limit, thinking levels and modalities.
Tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

## Access modes

Four modes, one gate. A mode decides which tools are declared to the model and
whether a call needs approval; every call is classified as
`none | write | outside | destructive | unknown` and logged to
`./.vessel/audit.jsonl`.

| Mode   | Product copy        | Workspace read | Workspace write      | Outside workspace | Destructive        |
| ------ | ------------------- | -------------- | -------------------- | ----------------- | ------------------ |
| `plan` | 编辑前先出计划       | allow          | deny (+ tool removed) | deny              | deny               |
| `ask`  | 改文件前先问我       | allow          | ask                  | ask               | ask                |
| `auto` | 在有风险时询问       | allow          | allow                | ask               | ask                |
| `full` | 减少确认次数         | allow          | allow                | allow             | allow (audited)    |

Hard rules hold in every mode: `sudo`, `mkfs`, `rm -rf /`, force-push, raw
device writes, piping remote code into a shell, and any write under `.git/` or
`.vessel/` are denied outright. Approval answers: `y` once, `a` for this
session (same risk class), `d` deny, `s` switch to `auto`, `f` switch to `full`;
the denial reason goes back to the model.

Modes are guardrails, not a sandbox: an approved `bash` command can still write
files internally. A hard boundary needs restricted `BashOperations`
(see `docs/access-modes.md` §7).

Headless runs (`vessel "..."` with no TTY) fail closed: an `ask` decision becomes
a denial unless you pass `--yes`.

## Use as a library

```ts
import { createVesselAgent } from "./src/vessel/index.ts";

const vessel = await createVesselAgent({
  cwd: process.cwd(),
  settings: { baseUrl: "https://host/v1", apiKey: "sk-..." }, // or omit and use env
  thinkingLevel: "high",
  accessMode: "ask",
  ask: async ({ call, verdict }) => {
    // Your UI: render and return { type: "allow" | "deny" | "switch", ... }.
    return { type: "deny", reason: `${call.toolName} not approved (${verdict.reason})` };
  },
});
try {
  vessel.session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });
  await vessel.session.prompt("What does this project do?");
} finally {
  vessel.dispose();
}
```

Swap models mid-session with `vessel.session.setModel(pickModel(vessel.session.modelRuntime, "vendor/model-id"))`;
switch modes with `vessel.setAccessMode("auto")`, and read the current one from
`vessel.accessMode`.

## Layout

```
index.ts                      CLI entry
src/vessel/models.ts          Custom Provider catalog: env settings, GET /models, runtime
src/vessel/agent.ts           createVesselAgent(): prompt, tools, gate, session
src/vessel/access/modes.ts    the four modes: tool sets, prompt addenda, labels
src/vessel/access/risk.ts     classifyBash / classifyPath / hard rules
src/vessel/access/policy.ts   decide(): pure mode × risk → allow | ask | deny
src/vessel/access/gate.ts     approvals, session memory, audit log
src/vessel/access/extension.ts  the single tool_call hook + per-turn prompt
src/vessel/cli.ts             REPL, one-shot mode, /mode, streaming output
src/vessel/cli/prompter.ts    one shared readline for REPL + approvals
src/vessel/cli/approval.ts    the y/a/d/s/f prompt
docs/access-modes.md          design notes and security boundary
```

## Checks

```bash
bun test
bun run typecheck
```

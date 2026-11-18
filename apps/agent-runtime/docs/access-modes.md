# Vessel 文件访问模式（4 种）设计

> 状态：已按第 1–4 步全部实现（`src/vessel/access/*`、`src/vessel/cli/*`）。
> 实现与本文的两处差异已在 §3、§4、§9 就地标注；验收结果见 §10。

对应产品里的四项：

| 模式 | 产品文案 | Vessel 内部语义 |
| --- | --- | --- |
| `plan` | 计划模式 · 编辑前先出计划 | 只读探索 + 产出计划，禁止任何写入 |
| `ask` | 变更前确认 · 改文件前先问我 | 读/查随便用，改文件/跑改文件的命令前逐次确认 |
| `auto` | 自主模式 · 在有风险时询问 | 工作区内自主，越界/破坏性/不可判定时才问 |
| `full` | 完全访问 · 减少确认次数 | 不问，只保留硬性拒绝规则 + 审计日志 |

模式不是一个「工具开关」，而是两条正交的轴：

- **能力轴（capability）**：这一轮哪些工具被声明给模型（`session.setActiveToolsByName`）。
- **审批轴（approval）**：某一次调用执行前要不要问人（`tool_call` 拦截）。

`plan` 同时改两条轴（去掉写工具 + 只放行只读 bash），其余三个模式只改审批轴。
这样切换模式不需要重建 session，也不会丢上下文。

---

## 1. 在 SDK 里拦哪里

已实测（`pi-coding-agent@1.5.2`，spike 已删除）：在 SDK 会话里用内联 extension 拦内建工具是可行的：

```ts
const loader = new DefaultResourceLoader({
  cwd,
  agentDir: `${cwd}/.vessel/agent`,   // 隔离，不读 ~/.pi/agent
  noExtensions: true,                 // 不加载磁盘上的扩展
  noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [accessModes({ getMode, ask })],  // 仍然会加载内联工厂
});
await loader.reload();                // 必须先 reload，createAgentSession 只取 getExtensions()

pi.on("tool_call", async (event) => {
  if (event.toolName === "ls") return { block: true, reason: "blocked by policy" };
});
```

实测结果：`extensions: 1 errors: 0`；模型调用 `ls` 时 `tool_execution_start` 照常发出，但工具没有执行，模型收到的是
`{ isError: true }` 且正文为 `spike gate: blocked by policy` —— **拒绝理由会回到模型上下文**，模型能据此换策略，这一点对体验很关键。

同一个 extension 里改提示词也已验证：

```ts
pi.on("before_agent_start", (event) => {
  event.systemPromptOptions.appendSystemPrompt += modePrompt(getMode());
});
```

为什么不做成 `customTools` 包一层内建工具：那样要自己重建 read/bash/edit/write 的接线，还会漏掉其它工具
（如 `codemode`/MCP 内部通过 `ctx.executeTool()` 发起的嵌套调用），而 `tool_call` 对两者都会触发。
bash 的 `BashSpawnHook` 只能覆盖 bash 一个工具，留作第二阶段的「硬隔离」入口（见 §7）。

---

## 2. 核心抽象：纯函数策略 + 有状态的闸门

`decide()` 必须是纯函数（无 IO、无 CLI），这样 4 种模式的行为可以用一张真值表测完。

```ts
// src/vessel/access/policy.ts
export type AccessMode = "plan" | "ask" | "auto" | "full";
export type Risk = "none" | "write" | "outside" | "destructive" | "unknown";

export type Verdict =
  | { kind: "allow" }
  | { kind: "deny"; risk: Risk; reason: string }        // 直接拒绝，理由回给模型
  | { kind: "ask"; risk: Risk; reason: string };        // 交给人决定

export interface ToolCall { toolName: string; input: Record<string, unknown>; cwd: string }

export function decide(mode: AccessMode, call: ToolCall): Verdict;
```

判定顺序（短路）：

1. **硬规则**（所有模式）：`rm -rf /`、`sudo`、`mkfs`、写 `.git/`、写 `.vessel/`、写 cwd 之外且用户确认过「不允许」的根目录 → `deny`。
2. **能力规则**：`plan` 下 `edit`/`write` → `deny`（本来也不会被声明，防复活）；`bash` 不在只读白名单 → `deny`。
3. **路径规则**：`edit`/`write`/`read` 的 `path` 解析后是否在 cwd 内（`resolve` + 相对路径判定，防 `../`、符号链接要 `realpath`）。
4. **命令规则**：`classifyBash()` 拆子命令 → `read-only | write | destructive | unknown`。
5. **模式规则**：按 §3 的矩阵把风险映射成 verdict。

---

## 3. 模式矩阵

`decide()` 对「读类调用」「工作区内写」「越界写」「破坏性命令」「不可判定命令」的输出：

| 调用性质 | plan | ask | auto | full |
| --- | --- | --- | --- | --- |
| `read`/`grep`/`find`/`ls`（cwd 内） | allow | allow | allow | allow |
| 只读 bash（`ls`、`git diff`、`rg`…） | allow | allow | allow | allow |
| `edit`/`write`（cwd 内） | **deny** | **ask** | allow | allow |
| 写类 bash（`> f`、`git add/commit`、`bun install`…） | **deny** | **ask** | allow | allow |
| 越界路径（cwd 外） | **deny** | **ask** | **ask** | allow（记审计） |
| 破坏性（`rm -r`、`git reset --hard`…） | **deny** | **ask** | **ask** | allow（记审计；硬规则仍 deny） |
| 不可判定命令（`unknown`） | **deny** | **ask** | **ask** | allow |
| 硬规则 | deny | deny | deny | deny |

设计要点：

- `ask` 只管「改」这一类，读永远不打扰 —— 这是它和 `auto` 的唯一差别，符合文案「改文件前先问我」。
- `auto` 的判定基准是**风险**而不是工具名：工作区内常规改动不问，越界/破坏性/看不懂才问。
- `full` 文案是「减少确认次数」而不是「无条件信任」：不必询问，但硬规则（`sudo`、`rm -rf /`、写 `.git/`…）仍然 deny，全部调用进审计。
  ~~破坏性命令默认仍 ask~~ → 实现为直接 allow（否则「完全访问」名不副实），需要更保守时用 `createVesselAgent({ allowDestructiveInFull: false })`。
- 无 UI 场景（`-p`、将来接 RPC/服务端）下 `ask` 降级为 `deny`，理由写明「no UI to approve」，模型会改走只读路线；`--yes` 显式降级为 allow。

---

## 4. 闸门（Gate）与交互

```ts
export type ApprovalDecision =
  | { type: "allow"; scope: "once" | "session" }   // y / a
  | { type: "deny"; reason?: string }              // d（可带理由，回给模型）
  | { type: "switch"; mode: AccessMode };          // s → auto，f → full

export interface ApprovalRequest {
  id: string; mode: AccessMode; toolName: string;
  summary: string;      // 一行 diff/命令摘要，彩色高亮改动部分
  risk: Risk; reason: string;
}
```

- 单个 `ApprovalQueue` 串行化所有询问：SDK 对同一条 assistant 消息里的并行调用是「先顺序 preflight、再并发执行」，所以闸门天然是串行的，但仍要用队列防止嵌套调用（`ctx.executeTool`）插队。
- `session` 作用域的 allow 存在内存 Set 里，按**风险类**记忆（`write` / `outside` / `destructive` / 未知工具名），换 session 或换模式即失效。
  ~~pattern 命令族~~ 留作后续增强。
- 拒绝理由要可执行：`"plan mode: bash 只允许只读命令，可以改用 read/grep，或切换 /mode auto 后再写"`。
- 连续拒绝 2 次后，闸门对本次 turn 返回 `{ block, terminate: true }`，避免模型反复撞墙浪费 token。
- 每次判定写一行 `.vessel/audit.jsonl`：`{ts, sessionId, mode, toolName, decision, risk, input-digest}`（不落完整文件内容）。

实现：`src/vessel/access/gate.ts` 的 `createGate()`；CLI 渲染（`src/vessel/cli/approval.ts`）：

```text
⚠ write  src/vessel/agent.ts
  auto: 路径在工作区内，但会覆盖已有文件

  [y] 允许一次  [a] 本会话都允许 write  [d] 拒绝  [s] 切到自主模式  [⏎] 拒绝
  reason (可选，会回给模型): _
```

---

## 5. 计划模式的实现

1. 进入：`setActiveToolsByName(["read", "grep", "find", "ls"])`（去掉 `edit`/`write`），bash 是否保留两种取舍：
   - 保留 + 只读白名单（推荐）：`git diff`、`rg` 可用，模型能看改动；
   - 完全去掉：更安静，但看不了 `git diff`。
2. 提示词（`before_agent_start` 追加）：要求先输出 `Plan:` + 编号步骤，禁止宣告「已完成」，最后一句必须询问是否执行。
3. 已实现：工具集 `toolsFor("plan")` 去掉 `edit`/`write`，bash 走只读白名单；提示词由 `before_agent_start` 追加。
4. 已实现：`/mode auto` 或审批里的 `s` 一步切换，同时还原工具集并写入会话记录；没有单独的 `exit_plan` 状态机。
5. 可选增强：执行阶段用 `[DONE:n]` 标记步骤进度（SDK 自带 `examples/extensions/plan-mode/`，含 bash 白名单与进度 widget，可以直接借鉴它的 `utils.ts`）。

---

## 6. 状态、持久化、对外 API

```ts
// 库接口
const vessel = await createVesselAgent({ accessMode: "ask", ask: myApprovalHandler });
vessel.setAccessMode("auto");          // 同时更新工具集 + 下一轮提示词 + 审计
vessel.accessMode;                     // 当前模式
```

- 默认模式来源优先级：`--mode` > `VESSEL_ACCESS_MODE` > 会话里上次选的（`appendCustomEntry`）> `ask`。
- `plan` 是否「粘性」：切换会话沿用，但**不**跨进程持久化 plan 状态（计划本来就该是当次产物）。
- REPL 增加 `/mode`（无参数显示 4 个选项，参数直接切）；状态行常驻显示 `plan | ask | auto | full`。
- 提示词每轮重算：`before_agent_start` 里读闭包里的 `getMode()`，所以切换立即生效，无需 `session.reload()`。
- 注意 `setActiveToolsByName` 只影响「声明给模型」的集合；闸门是第二道防线，两者都要有（模型可能仍调用被缓存的工具名）。

---

## 7. 诚实的安全边界

`plan`/`ask` 都是**协作式**约束，不是沙箱：一条被允许的 `bash` 命令内部仍可写文件（`python -c ...`），
`auto` 的路径判定也挡不住 bash 里 `cd /tmp && ...`。所以：

- 文档里明确写「模式是护栏，不是围栏」；
- 第二阶段把 `bash` 换成受限执行：`createBashTool(cwd, { operations })` 注入自定义 `BashOperations`
  （容器 / seatbelt / landlock，见 `docs/containerization.md`），这才是硬边界；
- `full` 之外的模式默认禁止 `cd` 到 cwd 外（闸门对 `cd /...` 直接 `ask`）；
- 审计日志可用于事后追责，也为将来的「信任项目」机制提供数据。

---

## 8. 文件结构与落地顺序

```text
src/vessel/access/modes.ts        AccessMode、MODE_INFO、toolsFor(mode)、modePrompt(mode)
src/vessel/access/risk.ts         classifyBash / classifyPath / 硬规则与命令族
src/vessel/access/policy.ts       decide(): Verdict（纯函数）
src/vessel/access/gate.ts         createGate() + createAuditLogger()
src/vessel/access/extension.ts    tool_call 拦截 + before_agent_start 提示词
src/vessel/access/policy.test.ts  模式 × 调用性质 真值表（39 例）
src/vessel/cli/prompter.ts        单 readline（REPL 与审批共用，行缓冲）
src/vessel/cli/approval.ts        审批 UI（y/a/d/s/f + 理由）
```

分四步落地，每步都能独立验收：

| 步骤 | 内容 | 验收 |
| --- | --- | --- |
| 1 | `policy.ts` + `risk.ts` + 真值表测试；默认模式 `full`（行为与今天完全一致） | `bun test` 全绿；`vessel "列出文件"` 不变 |
| 2 | `gate.ts` + CLI 审批 + `--mode`；实现 `ask`/`auto`/`full` | 伪造 `ask` 返回 deny → 模型看到理由并改道；并行 3 个 write 只弹 3 次且顺序稳定 |
| 3 | `plan`：工具集 + 只读 bash 白名单 + 提示词 + `/mode` + 计划批准 | plan 下 `getActiveToolNames()` 无 edit/write；`rm -rf` 被 deny；批准后自动转 auto |
| 4 | 审计日志、会话内记忆、无 UI 降级、`--yes` | `-p` 模式下 `ask` 全部 deny；`audit.jsonl` 行数与调用数一致 |

增量改造点（不破坏现有结构）：

- `agent.ts`：把自写的 `ResourceLoader` 换成 `DefaultResourceLoader({ agentDir: <cwd>/.vessel/agent, noExtensions: true, extensionFactories: [accessExtension] })` 并 `await loader.reload()`；新增 `accessMode` / `ask` 选项与 `setAccessMode()`。
- `cli.ts`：`--mode`、`/mode`、状态行、把 `ask` 接到 readline；`--models` 路径不需要闸门。
- 测试：`policy` 纯函数覆盖矩阵；`gate` 用 stub `ExtensionAPI` 直接驱动 handler（不必起真模型），再加 1 个可选的 e2e。

---

## 9. 产品决策（已拍板）

1. 新会话默认模式：`ask`。
2. `plan` 下保留 bash，但只放行只读命令。
3. `full` 下破坏性命令放行（仍受硬规则与审计约束）。
4. `a`（本会话允许）按风险类记忆，不按路径前缀。

## 10. 验收结果

- `bun test` 47 例全绿（policy 真值表 39 + 模型目录 8）；`bun run typecheck` 通过。
- `--mode plan` 下模型只出计划、文件未创建；`echo hi > x` 被 `risk=write` 拒绝。
- `--mode ask` 无 TTY 时 write 被拒绝并回传理由；带 pty 时可 `y` 批准并落盘，审计记 `approved once`。
- `--mode auto` 工作区内 write/read 放行，`sudo ls /` 在 `--mode full` 下仍被硬规则拒绝。
- 每次判定一行 `.vessel/audit.jsonl`（含 mode/toolName/risk/decision/reason）。

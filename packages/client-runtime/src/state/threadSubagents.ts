import * as DateTime from "effect/DateTime";
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ModelSelection,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";

import { formatSubagentDisplayTitle } from "./subagentDisplay.ts";
import { isActiveSubagentStatus, isTerminalSubagentStatus } from "./subagentRuntime.ts";
import { resolveActiveThreadRun } from "./threadWorkflows.ts";

type Projection = OrchestrationV2ThreadProjection;
type Subagent = OrchestrationV2Subagent;
type RunId = Projection["runs"][number]["id"];

export interface ThreadTurnSubagents {
  readonly runId: RunId | null;
  readonly turnActive: boolean;
  readonly subagents: ReadonlyArray<Subagent>;
  readonly liveCount: number;
  readonly settledCount: number;
}

export interface SubagentPillSegment {
  readonly label: string;
  readonly accessibilityLabel: string;
}

function orderKey(subagent: Subagent): number {
  return DateTime.toEpochMillis(subagent.startedAt ?? subagent.updatedAt);
}

/**
 * The agents behind the thread's agents pill and sheet: every agent of the active run (or, once
 * the thread is idle, of the run the most recently updated agent belongs to), plus any agent
 * still working from another run. A background agent outlives the turn that launched it, and the
 * Waiting strip counts it, so the pill has to count it and the sheet has to reach it too. Agents
 * of rolled-back runs stay out, as they do from the strip.
 */
export function deriveThreadTurnSubagents(
  projection: Pick<Projection, "runs" | "subagents">,
): ThreadTurnSubagents | null {
  const rolledBackRunIds = new Set(
    projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  const eligible = projection.subagents.filter(
    (subagent) => subagent.runId === null || !rolledBackRunIds.has(subagent.runId),
  );
  const [first] = eligible;
  if (first === undefined) return null;
  const activeRun = resolveActiveThreadRun(projection);
  const latestUpdated = eligible.reduce(
    (latest, subagent) =>
      DateTime.toEpochMillis(subagent.updatedAt) > DateTime.toEpochMillis(latest.updatedAt)
        ? subagent
        : latest,
    first,
  );
  const runId = activeRun?.id ?? latestUpdated.runId;
  const subagents = copySorted(
    eligible.filter(
      (subagent) => subagent.runId === runId || isActiveSubagentStatus(subagent.status),
    ),
    (left, right) => orderKey(left) - orderKey(right) || left.id.localeCompare(right.id),
  );
  if (subagents.length === 0) return null;

  let liveCount = 0;
  let settledCount = 0;
  for (const subagent of subagents) {
    if (isActiveSubagentStatus(subagent.status)) liveCount += 1;
    else if (isTerminalSubagentStatus(subagent.status)) settledCount += 1;
  }
  return { runId, turnActive: activeRun !== null, subagents, liveCount, settledCount };
}

export function resolveSubagentPillSegment(
  turn: ThreadTurnSubagents | null,
): SubagentPillSegment | null {
  if (turn === null) return null;
  if (!turn.turnActive && turn.liveCount === 0) return null;
  const total = turn.subagents.length;
  if (turn.liveCount > 0) {
    return {
      label: `${turn.liveCount}/${total}`,
      accessibilityLabel: `${turn.liveCount} of ${total} agents working`,
    };
  }
  return {
    label: `${total} done`,
    accessibilityLabel: `${total} ${total === 1 ? "agent" : "agents"} done`,
  };
}

export type ThreadSubagentRowState = "active" | "done" | "failed" | "stopped";

export interface ThreadSubagentRow {
  readonly key: string;
  /**
   * Null when there is nothing to open: a native subagent the provider reported without a child
   * thread.
   */
  readonly childThreadId: ThreadId | null;
  readonly label: string;
  readonly state: ThreadSubagentRowState;
  readonly summary: string | null;
  /** The model slug the thread is configured with; see deriveSubagentUsage for models actually used. */
  readonly model: string | null;
  /** Carries the reasoning level; null when only a bare model name is known. */
  readonly modelSelection: ModelSelection | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly attention: "approval" | "input" | null;
  /** Moves when a run is requested or finishes, not while text streams, so ordering stays still. */
  readonly lastActivityAt: number;
}

export interface ThreadSubagentGroup {
  readonly parentThreadId: ThreadId;
  readonly title: string;
  readonly rows: ReadonlyArray<ThreadSubagentRow>;
  readonly activeCount: number;
  readonly lastActivityAt: number;
}

export interface SubagentParentSummary {
  readonly id: ThreadId;
  readonly title: string;
  readonly archived: boolean;
}

const SUBAGENT_LABEL_MAX_LENGTH = 48;
const SUBAGENT_LABEL_MIN_WORD_BREAK = 24;
const SUBAGENT_SUMMARY_MAX_LENGTH = 220;

function clipAtWord(text: string, maxLength: number, minWordBreak: number): string {
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, maxLength - 1);
  const wordBreak = clipped.lastIndexOf(" ");
  return `${(wordBreak >= minWordBreak ? clipped.slice(0, wordBreak) : clipped).trimEnd()}…`;
}

/**
 * A short name for what a subagent is doing. Child threads are already titled from the task's
 * title or prompt, so this only compacts that text: first line, first sentence, one line of
 * bounded length.
 */
function compactSubagentLabel(raw: string | null | undefined): string | null {
  const firstLine = formatSubagentDisplayTitle((raw ?? "").trim()).split(/\r?\n/u, 1)[0] ?? "";
  const text = firstLine
    .replace(/^[#>*\-\s]+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (text.length === 0) return null;
  const sentence = /^(.{12,}?)[.!?:](?:\s|$)/u.exec(text)?.[1] ?? text;
  return clipAtWord(sentence, SUBAGENT_LABEL_MAX_LENGTH, SUBAGENT_LABEL_MIN_WORD_BREAK);
}

function subagentRowLabel(...sources: ReadonlyArray<string | null | undefined>): string {
  for (const source of sources) {
    const label = compactSubagentLabel(source);
    if (label !== null) return label;
  }
  return "Sub agent";
}

/** One whitespace-collapsed line the view clamps to two; markdown markers are only noise here. */
function compactSubagentSummary(raw: string | null | undefined): string | null {
  const text = (raw ?? "")
    .replace(/^[#>*\-\s]+/u, "")
    .replace(/[*_`]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length === 0
    ? null
    : clipAtWord(text, SUBAGENT_SUMMARY_MAX_LENGTH, SUBAGENT_SUMMARY_MAX_LENGTH / 2);
}

function subagentRowState(status: string | null | undefined): ThreadSubagentRowState {
  switch (status) {
    case "preparing":
    case "starting":
    case "queued":
    case "pending":
    case "running":
    case "waiting":
      return "active";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return "stopped";
    default:
      return "done";
  }
}

export function formatSubagentAgentCount(agentCount: number): string {
  return `${agentCount} ${agentCount === 1 ? "agent" : "agents"}`;
}

export function formatSubagentGroupLabel(title: string, agentCount: number): string {
  return `${title} · ${formatSubagentAgentCount(agentCount)}`;
}

const millis = (value: DateTime.Utc | null | undefined): number | null =>
  value == null ? null : DateTime.toEpochMillis(value);
const iso = (value: DateTime.Utc | null | undefined): string | null =>
  value == null ? null : DateTime.formatIso(value);

function childRow(
  child: OrchestrationV2ThreadShell,
  agent: Subagent | undefined,
): ThreadSubagentRow {
  // The child's own status wins once it has run; before that, only the delegation says anything.
  const status =
    child.activityRunStatus ??
    (child.latestRunId !== null && agent !== undefined && !isOrchestrationV2WorkActive(agent.status)
      ? child.status
      : (agent?.status ?? child.status));
  const state = subagentRowState(status);
  const startedAt =
    iso(child.activityRunStartedAt ?? child.latestRunStartedAt) ?? iso(agent?.startedAt);
  const completedAt =
    state === "active" ? null : (iso(child.latestRunCompletedAt) ?? iso(agent?.completedAt));
  const lastMessage = child.latestVisibleMessage;
  const assistantText = lastMessage?.role === "assistant" ? lastMessage.text : null;
  const summarySources =
    state === "active"
      ? [agent?.progress, assistantText, agent?.prompt, lastMessage?.text]
      : [agent?.result, assistantText, agent?.prompt, lastMessage?.text];
  return {
    key: child.id,
    childThreadId: child.id,
    label: subagentRowLabel(child.title, agent?.title, agent?.prompt),
    state,
    summary: summarySources.map(compactSubagentSummary).find((summary) => summary !== null) ?? null,
    model: child.modelSelection.model,
    modelSelection: child.modelSelection,
    providerInstanceId: child.providerInstanceId,
    startedAt,
    completedAt,
    attention:
      child.pendingRuntimeRequest === null
        ? null
        : child.pendingRuntimeRequest.kind === "user_input"
          ? "input"
          : "approval",
    lastActivityAt: Math.max(
      millis(child.createdAt) ?? 0,
      millis(child.latestRunRequestedAt) ?? 0,
      millis(child.latestRunCompletedAt) ?? 0,
    ),
  };
}

function threadlessRow(agent: Subagent): ThreadSubagentRow {
  const state = subagentRowState(agent.status);
  return {
    key: agent.id,
    childThreadId: null,
    label: subagentRowLabel(agent.title, agent.prompt),
    state,
    summary:
      [state === "active" ? agent.progress : agent.result, agent.prompt]
        .map(compactSubagentSummary)
        .find((summary) => summary !== null) ?? null,
    model: agent.model,
    modelSelection: agent.modelSelection ?? null,
    providerInstanceId: agent.providerInstanceId,
    startedAt: iso(agent.startedAt),
    completedAt: state === "active" ? null : iso(agent.completedAt),
    attention: null,
    lastActivityAt:
      millis(agent.completedAt) ?? millis(agent.startedAt) ?? millis(agent.updatedAt) ?? 0,
  };
}

/**
 * Every thread's sub agents, grouped by parent thread, from thread shells alone: nothing here
 * needs a thread's detail. `activeSubagents` are the open thread's delegation records, whose
 * progress and results enrich its rows and which also list native sub agents that have no child
 * thread. Working groups come first, then the most recently active; the open thread's group
 * leads. Rows go working first, then newest first.
 */
export function deriveSubagentGroups(input: {
  readonly children: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly parents: ReadonlyArray<SubagentParentSummary>;
  readonly activeThreadId: ThreadId | null;
  readonly activeSubagents?: ReadonlyArray<Subagent>;
}): ReadonlyArray<ThreadSubagentGroup> {
  const parentsById = new Map(input.parents.map((parent) => [parent.id, parent] as const));
  const activeAgentsByChild = new Map<ThreadId, Subagent>();
  for (const agent of input.activeSubagents ?? []) {
    if (agent.childThreadId !== null) activeAgentsByChild.set(agent.childThreadId, agent);
  }
  const rowsByParent = new Map<ThreadId, Array<{ row: ThreadSubagentRow; createdAt: number }>>();
  const add = (parentId: ThreadId, row: ThreadSubagentRow, createdAt: number) => {
    const rows = rowsByParent.get(parentId);
    if (rows === undefined) rowsByParent.set(parentId, [{ row, createdAt }]);
    else rows.push({ row, createdAt });
  };
  for (const child of input.children) {
    const parentId = child.lineage.parentThreadId;
    if (
      parentId === null ||
      child.lineage.relationshipToParent !== "subagent" ||
      child.deletedAt !== null
    ) {
      continue;
    }
    add(
      parentId,
      childRow(
        child,
        parentId === input.activeThreadId ? activeAgentsByChild.get(child.id) : undefined,
      ),
      millis(child.createdAt) ?? 0,
    );
  }
  for (const agent of input.activeSubagents ?? []) {
    if (agent.childThreadId === null && input.activeThreadId !== null) {
      add(input.activeThreadId, threadlessRow(agent), millis(agent.startedAt) ?? 0);
    }
  }
  const groups: ThreadSubagentGroup[] = [];
  for (const [parentId, entries] of rowsByParent) {
    const parent = parentsById.get(parentId);
    if (parent === undefined || (parent.archived && parentId !== input.activeThreadId)) continue;
    const rows = copySorted(
      entries,
      (left, right) =>
        Number(right.row.state === "active") - Number(left.row.state === "active") ||
        right.createdAt - left.createdAt ||
        left.row.key.localeCompare(right.row.key),
    ).map((entry) => entry.row);
    groups.push({
      parentThreadId: parentId,
      title: parent.title,
      rows,
      activeCount: rows.filter((row) => row.state === "active").length,
      lastActivityAt: Math.max(...rows.map((row) => row.lastActivityAt)),
    });
  }
  return copySorted(
    groups,
    (left, right) =>
      Number(right.parentThreadId === input.activeThreadId) -
        Number(left.parentThreadId === input.activeThreadId) ||
      Number(right.activeCount > 0) - Number(left.activeCount > 0) ||
      right.lastActivityAt - left.lastActivityAt ||
      left.parentThreadId.localeCompare(right.parentThreadId),
  );
}

export interface SubagentSessionUsage {
  readonly tokens: number | null;
  readonly toolCalls: number;
  readonly topTools: ReadonlyArray<string>;
  /** Slugs in the order the thread first ran them. */
  readonly models: ReadonlyArray<string>;
}

const TOOL_ITEM_NAMES = {
  command_execution: "shell",
  file_change: "edit",
  file_search: "search",
  web_search: "web",
} as const;
const TOP_TOOL_COUNT = 2;

/**
 * The detail-level figures a thread shell does not carry. Tokens are the main agent's input and
 * output summed over provider turns; a provider that reports no per-turn usage leaves them null
 * rather than showing the context size as if it were spend.
 */
export function deriveSubagentUsage(
  projection: Pick<Projection, "runs" | "providerTurns"> & {
    readonly turnItems: ReadonlyArray<{ readonly type: string; readonly toolName?: string | null }>;
  },
): SubagentSessionUsage {
  let tokens: number | null = null;
  for (const turn of projection.providerTurns) {
    const usage = turn.turnTokenUsage;
    if (usage === undefined) continue;
    tokens = (tokens ?? 0) + (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  const toolCounts = new Map<string, number>();
  let toolCalls = 0;
  for (const item of projection.turnItems) {
    const name =
      item.type === "dynamic_tool"
        ? (item.toolName ?? "tool")
        : TOOL_ITEM_NAMES[item.type as keyof typeof TOOL_ITEM_NAMES];
    if (name === undefined) continue;
    toolCalls += 1;
    toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
  }
  const topTools = copySorted(
    [...toolCounts],
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )
    .slice(0, TOP_TOOL_COUNT)
    .map(([name]) => name);
  const models = [
    ...new Set(
      copySorted(projection.runs, (left, right) => left.ordinal - right.ordinal).map(
        (run) => run.modelSelection.model,
      ),
    ),
  ];
  return { tokens, toolCalls, topTools, models };
}

import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";

import { formatSubagentDisplayTitle } from "./subagentDisplay.ts";
import { isActiveSubagentStatus, isTerminalSubagentStatus } from "./subagentRuntime.ts";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  orderWebThreadLineageRows,
  threadRelationshipRowStatus,
} from "./threadRelationships.ts";
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
   * thread, or a child whose shell is not loaded.
   */
  readonly childThreadId: ThreadId | null;
  readonly label: string;
  readonly state: ThreadSubagentRowState;
}

const SUBAGENT_LABEL_MAX_LENGTH = 48;
const SUBAGENT_LABEL_MIN_WORD_BREAK = 24;

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
  if (sentence.length <= SUBAGENT_LABEL_MAX_LENGTH) return sentence;
  const clipped = sentence.slice(0, SUBAGENT_LABEL_MAX_LENGTH - 1);
  const wordBreak = clipped.lastIndexOf(" ");
  return `${(wordBreak >= SUBAGENT_LABEL_MIN_WORD_BREAK ? clipped.slice(0, wordBreak) : clipped).trimEnd()}…`;
}

function subagentRowLabel(...sources: ReadonlyArray<string | null | undefined>): string {
  for (const source of sources) {
    const label = compactSubagentLabel(source);
    if (label !== null) return label;
  }
  return "Sub agent";
}

function subagentRowState(status: string | null): ThreadSubagentRowState {
  switch (status) {
    case "preparing":
    case "starting":
    case "queued":
    case "pending":
    case "running":
    case "in_progress":
    case "waiting":
    case "blocked":
      return "active";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return "stopped";
    default:
      return "done";
  }
}

/**
 * The sub agents of one thread, working ones first and newest first within each group. A row's
 * state follows its child thread, so a finished sub agent the user prompted again reads as
 * working; see deriveThreadRelationshipGraph.
 */
export function deriveThreadSubagentRows(input: {
  readonly threadId: ThreadId;
  readonly subagents: Projection["subagents"];
  readonly shells: ReadonlyArray<OrchestrationV2ThreadShell>;
}): ReadonlyArray<ThreadSubagentRow> {
  const graph = deriveThreadRelationshipGraph({
    threads: input.shells,
    projection: {
      thread: { id: input.threadId },
      subagents: input.subagents,
      contextTransfers: [],
    },
  });
  const agentsByChildThreadId = new Map<ThreadId, Subagent>();
  for (const agent of input.subagents) {
    if (agent.childThreadId !== null) agentsByChildThreadId.set(agent.childThreadId, agent);
  }
  const childRows = orderWebThreadLineageRows({
    graph,
    rows: immediateThreadRelationships(graph, input.threadId).filter(
      ({ edge }) => edge.kind === "subagent" && edge.sourceThreadId === input.threadId,
    ),
    currentThreadId: input.threadId,
    mergeTargetThreadId: null,
  }).flatMap((row): ThreadSubagentRow[] => {
    const node = graph.nodes.get(row.threadId);
    if (node?.thread?.deletedAt != null) return [];
    const agent = agentsByChildThreadId.get(row.threadId);
    return [
      {
        key: row.threadId,
        childThreadId: node?.missing === false ? row.threadId : null,
        label: subagentRowLabel(node?.thread?.title, agent?.title, agent?.prompt),
        state: subagentRowState(threadRelationshipRowStatus(graph, row)),
      },
    ];
  });
  const threadlessRows = input.subagents
    .filter((agent) => agent.childThreadId === null)
    .map((agent): ThreadSubagentRow => ({
      key: agent.id,
      childThreadId: null,
      label: subagentRowLabel(agent.title, agent.prompt),
      state: subagentRowState(agent.status),
    }));
  const rows = [...childRows, ...threadlessRows];
  return [
    ...rows.filter((row) => row.state === "active"),
    ...rows.filter((row) => row.state !== "active"),
  ];
}

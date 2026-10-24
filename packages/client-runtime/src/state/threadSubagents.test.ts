import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deriveSubagentGroups,
  deriveSubagentUsage,
  deriveThreadTurnSubagents,
  formatSubagentGroupLabel,
  resolveSubagentPillSegment,
  type SubagentParentSummary,
} from "./threadSubagents.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function subagent(
  overrides: Omit<Partial<OrchestrationV2Subagent>, "id"> & { readonly id: string },
): OrchestrationV2Subagent {
  const { id, ...rest } = overrides;
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    parentNodeId: NodeId.make("node-1"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: ThreadId.make("thread-child"),
    nativeTaskRef: null,
    prompt: "Do the thing",
    title: "Worker",
    model: "gpt-5.4",
    status: "running",
    result: null,
    startedAt: at("2026-06-20T00:00:00.000Z"),
    completedAt: null,
    updatedAt: at("2026-06-20T00:00:01.000Z"),
    ...rest,
  };
}

const run = (id: string, status: "running" | "completed" | "rolled_back") =>
  ({ id: RunId.make(id), status }) as never;
const activeRun = run("run-1", "running");
const finishedRun = run("run-1", "completed");

describe("deriveThreadTurnSubagents", () => {
  it("scopes the roster to the active run and orders it by start time", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-0", "completed"), activeRun],
      subagents: [
        subagent({ id: "b", startedAt: at("2026-06-20T00:00:05.000Z") }),
        subagent({ id: "old", runId: RunId.make("run-0"), status: "completed" }),
        subagent({ id: "a", startedAt: at("2026-06-20T00:00:02.000Z") }),
      ],
    });

    expect(turn?.runId).toBe("run-1");
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(turn?.turnActive).toBe(true);
  });

  it("falls back to the most recently updated agent's run once the turn settles", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun, run("run-2", "completed")],
      subagents: [
        subagent({ id: "old", status: "completed", updatedAt: at("2026-06-20T00:00:01.000Z") }),
        subagent({
          id: "recent",
          runId: RunId.make("run-2"),
          status: "completed",
          updatedAt: at("2026-06-20T00:00:09.000Z"),
        }),
      ],
    });

    expect(turn?.runId).toBe("run-2");
    expect(turn?.turnActive).toBe(false);
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["recent"]);
  });

  it("lists every live agent from earlier turns once no turn is running", () => {
    const turn = deriveThreadTurnSubagents({
      runs: ["run-103", "run-105", "run-107", "run-109"].map((id) => run(id, "completed")),
      subagents: [
        subagent({
          id: "settled-103",
          runId: RunId.make("run-103"),
          status: "completed",
          startedAt: at("2026-06-20T00:00:00.000Z"),
          updatedAt: at("2026-06-20T00:00:04.000Z"),
        }),
        subagent({
          id: "bg-103",
          runId: RunId.make("run-103"),
          startedAt: at("2026-06-20T00:00:01.000Z"),
          updatedAt: at("2026-06-20T00:00:05.000Z"),
        }),
        subagent({
          id: "bg-105",
          runId: RunId.make("run-105"),
          startedAt: at("2026-06-20T00:00:02.000Z"),
          updatedAt: at("2026-06-20T00:00:06.000Z"),
        }),
        subagent({
          id: "bg-107",
          runId: RunId.make("run-107"),
          startedAt: at("2026-06-20T00:00:03.000Z"),
          updatedAt: at("2026-06-20T00:00:07.000Z"),
        }),
      ],
    });

    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["bg-103", "bg-105", "bg-107"]);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("3/3");
  });

  it("keeps the active turn's roster and adds a live agent from an earlier turn", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-0", "completed"), activeRun],
      subagents: [
        subagent({ id: "background", runId: RunId.make("run-0") }),
        subagent({ id: "earlier-done", runId: RunId.make("run-0"), status: "completed" }),
        subagent({ id: "working", startedAt: at("2026-06-20T00:00:05.000Z") }),
        subagent({
          id: "done",
          status: "completed",
          startedAt: at("2026-06-20T00:00:06.000Z"),
        }),
      ],
    });

    expect(turn?.runId).toBe("run-1");
    expect(turn?.turnActive).toBe(true);
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["background", "working", "done"]);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("2/3");
  });

  it("leaves out a live agent whose turn was rolled back", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-0", "rolled_back"), finishedRun],
      subagents: [
        subagent({ id: "rolled-back", runId: RunId.make("run-0") }),
        subagent({ id: "live", updatedAt: at("2026-06-20T00:00:09.000Z") }),
      ],
    });

    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["live"]);
  });

  it("lists a workflow coordinator's members, which carry no run", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [],
      subagents: [
        subagent({ id: "member-0", runId: null, startedAt: at("2026-06-20T00:00:01.000Z") }),
        subagent({
          id: "member-1",
          runId: null,
          status: "completed",
          startedAt: at("2026-06-20T00:00:02.000Z"),
        }),
      ],
    });

    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["member-0", "member-1"]);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("1/2");
  });

  it("counts idle as neither working nor done", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [
        subagent({ id: "a", status: "running" }),
        subagent({ id: "b", status: "idle" }),
        subagent({ id: "c", status: "failed" }),
      ],
    });

    expect(turn?.liveCount).toBe(1);
    expect(turn?.settledCount).toBe(1);
    expect(turn?.subagents).toHaveLength(3);
  });
});

describe("deriveSubagentGroups", () => {
  const parentId = ThreadId.make("parent");
  const parent = (id: string, overrides: Partial<SubagentParentSummary> = {}) => ({
    id: ThreadId.make(id),
    title: `Parent ${id}`,
    archived: false,
    ...overrides,
  });

  function child(
    id: string,
    overrides: Partial<Record<string, unknown>> = {},
    parentThreadId: ThreadId = parentId,
  ): OrchestrationV2ThreadShell {
    return {
      id: ThreadId.make(id),
      title: `Title of ${id}`,
      status: "completed",
      activityRunStatus: null,
      latestRunId: "run-child",
      latestRunRequestedAt: at("2026-06-20T00:00:00.000Z"),
      latestRunCompletedAt: at("2026-06-20T00:01:00.000Z"),
      updatedAt: at("2026-06-20T00:01:00.000Z"),
      createdAt: at("2026-06-20T00:00:00.000Z"),
      deletedAt: null,
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      providerInstanceId: "codex",
      lineage: { parentThreadId, relationshipToParent: "subagent", rootThreadId: parentThreadId },
      ...overrides,
    } as never;
  }

  const derive = (
    children: ReadonlyArray<OrchestrationV2ThreadShell>,
    overrides: Partial<Parameters<typeof deriveSubagentGroups>[0]> = {},
  ) =>
    deriveSubagentGroups({
      children,
      parents: [parent("parent")],
      activeThreadId: null,
      ...overrides,
    });

  it("groups sub agents by parent thread and ignores forks and deleted children", () => {
    const groups = derive(
      [
        child("a"),
        child("b", {}, ThreadId.make("other")),
        child("fork", {
          lineage: {
            parentThreadId: parentId,
            relationshipToParent: "fork",
            rootThreadId: parentId,
          },
        }),
        child("gone", { deletedAt: at("2026-06-20T00:02:00.000Z") }),
      ],
      { parents: [parent("parent"), parent("other")] },
    );

    expect(groups).toHaveLength(2);
    expect(
      Object.fromEntries(
        groups.map((group) => [group.parentThreadId, group.rows.map((row) => row.key)]),
      ),
    ).toEqual({ parent: ["a"], other: ["b"] });
  });

  it("leaves out groups whose parent is archived or unknown, unless it is the open thread", () => {
    const children = [
      child("a"),
      child("b", {}, ThreadId.make("archived")),
      child("c", {}, ThreadId.make("unknown")),
    ];
    const parents = [parent("parent"), parent("archived", { archived: true })];
    expect(derive(children, { parents }).map((group) => group.parentThreadId)).toEqual(["parent"]);
    expect(
      derive(children, { parents, activeThreadId: ThreadId.make("archived") }).map(
        (group) => group.parentThreadId,
      ),
    ).toEqual(["archived", "parent"]);
  });

  it("orders the open thread first, then working groups, then the most recently active", () => {
    const groups = deriveSubagentGroups({
      children: [
        child(
          "idle-old",
          { latestRunCompletedAt: at("2026-06-20T00:01:00.000Z") },
          ThreadId.make("p-old"),
        ),
        child(
          "idle-new",
          { latestRunCompletedAt: at("2026-06-20T01:00:00.000Z") },
          ThreadId.make("p-new"),
        ),
        child("busy", { activityRunStatus: "running" }, ThreadId.make("p-busy")),
        child("mine"),
      ],
      parents: ["p-old", "p-new", "p-busy", "parent"].map((id) => parent(id)),
      activeThreadId: parentId,
    });

    expect(groups.map((group) => group.parentThreadId)).toEqual([
      "parent",
      "p-busy",
      "p-new",
      "p-old",
    ]);
  });

  it("counts working sub agents per group and lists them first, newest first", () => {
    const [group] = derive([
      child("done-old", { createdAt: at("2026-06-20T00:00:01.000Z") }),
      child("done-new", { createdAt: at("2026-06-20T00:00:05.000Z") }),
      child("working", { createdAt: at("2026-06-20T00:00:02.000Z"), activityRunStatus: "running" }),
    ]);

    expect(group?.activeCount).toBe(1);
    expect(group?.rows.map((row) => row.key)).toEqual(["working", "done-new", "done-old"]);
  });

  it("pluralises the group label", () => {
    expect(formatSubagentGroupLabel("Implement REST service", 3)).toBe(
      "Implement REST service · 3 agents",
    );
    expect(formatSubagentGroupLabel("Implement REST service", 1)).toBe(
      "Implement REST service · 1 agent",
    );
  });

  describe("state", () => {
    const stateOf = (overrides: Partial<Record<string, unknown>>) =>
      derive([child("a", overrides)])[0]?.rows[0]?.state;

    it("is active while a run is, whatever the last status says", () => {
      expect(stateOf({ activityRunStatus: "running", status: "completed" })).toBe("active");
      expect(stateOf({ status: "queued" })).toBe("active");
    });

    it("keeps failed and stopped apart from finished", () => {
      expect(stateOf({ status: "completed" })).toBe("done");
      expect(stateOf({ status: "failed" })).toBe("failed");
      expect(stateOf({ status: "cancelled" })).toBe("stopped");
      expect(stateOf({ status: "interrupted" })).toBe("stopped");
    });
  });

  describe("summary and meta", () => {
    const rowFor = (shell: OrchestrationV2ThreadShell, agent?: OrchestrationV2Subagent) =>
      deriveSubagentGroups({
        children: [shell],
        parents: [parent("parent")],
        activeThreadId: parentId,
        activeSubagents: agent === undefined ? [] : [agent],
      })[0]?.rows[0];

    it("prefers the delegation's progress while working and its result once done", () => {
      const agent = subagent({
        id: "task",
        childThreadId: ThreadId.make("a"),
        progress: "Reading the router",
        result: "Added the /users route",
        prompt: "Build the users route",
      });
      const latestVisibleMessage = { role: "assistant", text: "latest message" };

      expect(
        rowFor(child("a", { activityRunStatus: "running", latestVisibleMessage }), agent)?.summary,
      ).toBe("Reading the router");
      expect(
        rowFor(child("a", { latestVisibleMessage }), { ...agent, status: "completed" })?.summary,
      ).toBe("Added the /users route");
    });

    it("falls back to the latest assistant message, then to the prompt", () => {
      expect(
        rowFor(
          child("a", {
            latestVisibleMessage: { role: "assistant", text: "## Done\n\nFixed **the** bug" },
          }),
        )?.summary,
      ).toBe("Done Fixed the bug");
      expect(
        rowFor(child("a", { latestVisibleMessage: { role: "user", text: "the task text" } }))
          ?.summary,
      ).toBe("the task text");
      expect(
        rowFor(
          child("a", { latestVisibleMessage: { role: "user", text: "x" } }),
          subagent({
            id: "task",
            childThreadId: ThreadId.make("a"),
            prompt: "Write the migration",
            result: null,
          }),
        )?.summary,
      ).toBe("Write the migration");
      expect(rowFor(child("a"))?.summary).toBeNull();
    });

    it("clips a long summary at a word", () => {
      const summary = rowFor(
        child("a", { latestVisibleMessage: { role: "assistant", text: "word ".repeat(100) } }),
      )?.summary;

      expect(summary?.length).toBeLessThanOrEqual(220);
      expect(summary?.endsWith("word…")).toBe(true);
    });

    it("reports the model, timing and a pending question or approval", () => {
      const question = rowFor(
        child("a", {
          pendingRuntimeRequest: {
            id: "r",
            kind: "user_input",
            createdAt: at("2026-06-20T00:00:30.000Z"),
          },
        }),
      );
      const approval = rowFor(
        child("b", {
          pendingRuntimeRequest: {
            id: "r",
            kind: "command_execution_approval",
            createdAt: at("2026-06-20T00:00:30.000Z"),
          },
          latestRunStartedAt: at("2026-06-20T00:00:10.000Z"),
        }),
      );

      expect(question?.attention).toBe("input");
      expect(approval?.attention).toBe("approval");
      expect(approval).toMatchObject({
        model: "gpt-5.4",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        startedAt: "2026-06-20T00:00:10.000Z",
        completedAt: "2026-06-20T00:01:00.000Z",
      });
    });

    it("lists a native sub agent without a child thread under the open thread only", () => {
      const native = subagent({
        id: "native",
        origin: "provider_native",
        childThreadId: null,
        title: null,
        prompt: "Audit the retry logic in the sync client. Report any races.",
        status: "running",
      });

      expect(
        deriveSubagentGroups({
          children: [],
          parents: [parent("parent")],
          activeThreadId: null,
          activeSubagents: [native],
        }),
      ).toEqual([]);
      expect(
        deriveSubagentGroups({
          children: [],
          parents: [parent("parent")],
          activeThreadId: parentId,
          activeSubagents: [native],
        })[0]?.rows,
      ).toEqual([
        expect.objectContaining({
          key: "native",
          childThreadId: null,
          label: "Audit the retry logic in the sync client",
          state: "active",
        }),
      ]);
    });
  });

  it.each([
    ["Subagent: Review the auth flow", "Review the auth flow"],
    ["/root/code_reviewer", "Code Reviewer"],
    ["  # Fix flaky\n\nbody text", "Fix flaky"],
    [
      "Investigate why the websocket reconnect loop keeps spinning after sleep",
      "Investigate why the websocket reconnect loop…",
    ],
    ["", "Sub agent"],
  ])("labels %j as %j", (title, label) => {
    expect(derive([child("a", { title })])[0]?.rows[0]?.label).toBe(label);
  });
});

describe("deriveSubagentUsage", () => {
  const turn = (usage?: { inputTokens?: number; outputTokens?: number }) =>
    ({
      turnTokenUsage: usage === undefined ? undefined : { usageStatus: "partial", ...usage },
    }) as never;
  const run = (ordinal: number, model: string) =>
    ({ ordinal, modelSelection: { instanceId: "codex", model } }) as never;

  it("sums input and output tokens over turns, and is null when nothing reports usage", () => {
    expect(
      deriveSubagentUsage({
        runs: [],
        providerTurns: [
          turn({ inputTokens: 1000, outputTokens: 200 }),
          turn(),
          turn({ outputTokens: 50 }),
        ],
        turnItems: [],
      }).tokens,
    ).toBe(1250);
    expect(
      deriveSubagentUsage({ runs: [], providerTurns: [turn()], turnItems: [] }).tokens,
    ).toBeNull();
  });

  it("counts tool calls and names the most used", () => {
    const usage = deriveSubagentUsage({
      runs: [],
      providerTurns: [],
      turnItems: [
        { type: "command_execution" },
        { type: "command_execution" },
        { type: "command_execution" },
        { type: "file_change" },
        { type: "dynamic_tool", toolName: "mcp__linear__get_issue" },
        { type: "dynamic_tool", toolName: "mcp__linear__get_issue" },
        { type: "assistant_message" },
        { type: "reasoning" },
      ],
    });

    expect(usage.toolCalls).toBe(6);
    expect(usage.topTools).toEqual(["shell", "mcp__linear__get_issue"]);
  });

  it("lists each model once, in the order it first ran", () => {
    expect(
      deriveSubagentUsage({
        runs: [run(3, "gpt-5.4"), run(1, "gpt-5.4"), run(2, "claude-opus-5-5")],
        providerTurns: [],
        turnItems: [],
      }).models,
    ).toEqual(["gpt-5.4", "claude-opus-5-5"]);
  });
});

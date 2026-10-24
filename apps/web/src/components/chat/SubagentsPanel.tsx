import { LegendList } from "@legendapp/list/react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  deriveSubagentGroups,
  deriveSubagentUsage,
  formatSubagentAgentCount,
  type ThreadSubagentGroup,
  type ThreadSubagentRow,
  type ThreadSubagentRowState,
} from "@t3tools/client-runtime/state/thread-subagents";
import {
  deriveReportedModelSelection,
  formatModelSelectionEffort,
} from "@t3tools/client-runtime/state/thread-execution";
import { ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { deriveSubagentElapsedMs, formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatModelSlugName } from "@t3tools/shared/model";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useEnvironmentProviders } from "../../state/environments";
import {
  useEnvironmentSubagentShells,
  useQuietThreadProjection,
  useQuietThreadShell,
} from "../../state/entities";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";

// The header is a fixed h-8. A row is a title line, a summary line and a meta line plus padding.
const GROUP_HEADER_HEIGHT = 32;
const ROW_HEIGHT_ESTIMATE = 64;

const NO_SUBAGENTS: ReadonlyArray<never> = [];

function useSubagentGroups(threadRef: ScopedThreadRef): ReadonlyArray<ThreadSubagentGroup> {
  const { children, parents } = useEnvironmentSubagentShells(threadRef.environmentId);
  const activeSubagents = useQuietThreadProjection(threadRef)?.projection.subagents ?? NO_SUBAGENTS;
  return deriveSubagentGroups({
    children,
    parents,
    activeThreadId: threadRef.threadId,
    activeSubagents,
  });
}

// A fixed box so the icon lines up with the first text line however tall the row gets. Failed
// and stopped sub agents read as finished here; their meta line says which.
function SubagentStateIcon(props: { readonly state: ThreadSubagentRowState }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {props.state === "active" ? (
        <Spinner size="md" tone="warning" aria-label="Working" />
      ) : (
        <span role="img" aria-label="Finished" className="size-2 rounded-full bg-success" />
      )}
    </span>
  );
}

function SubagentMeta(props: {
  readonly row: ThreadSubagentRow;
  readonly threadRef: ScopedThreadRef;
}) {
  const { row } = props;
  // Mounted only while the row is in view, so this is also what loads a sub agent's detail.
  const projection = useQuietThreadProjection(
    row.childThreadId === null
      ? null
      : scopeThreadRef(props.threadRef.environmentId, row.childThreadId),
  )?.projection;
  const usage = projection === undefined ? null : deriveSubagentUsage(projection);
  const provider = useEnvironmentProviders()
    .get(props.threadRef.environmentId)
    ?.find((entry) => entry.instanceId === row.providerInstanceId);
  const effort =
    row.modelSelection === null
      ? null
      : formatModelSelectionEffort(
          row.modelSelection,
          provider?.models,
          projection === undefined ? null : deriveReportedModelSelection(projection),
        );
  const models = (usage !== null && usage.models.length > 0 ? usage.models : [row.model ?? ""])
    .filter((model) => model.length > 0)
    .map(formatModelSlugName);
  const elapsedMs =
    row.state === "active"
      ? null
      : deriveSubagentElapsedMs(
          { status: "completed", startedAt: row.startedAt, completedAt: row.completedAt },
          0,
        );
  const parts: ReactNode[] = [];
  if (row.attention !== null) {
    parts.push(
      <span className="text-warning">
        {row.attention === "input" ? "Has a question" : "Needs approval"}
      </span>,
    );
  }
  if (row.state === "failed") {
    parts.push(<span className="font-medium text-destructive">Failed</span>);
  }
  if (row.state === "stopped") {
    parts.push(<span className="font-medium text-foreground">Stopped</span>);
  }
  if (models.length > 0) {
    parts.push(
      models.length > 2
        ? `${models.slice(0, 2).join(", ")} +${models.length - 2}`
        : models.join(", "),
    );
  }
  if (effort !== null) parts.push(effort);
  if (usage?.tokens != null) parts.push(`${formatTokens(usage.tokens)} tokens`);
  if (usage !== null && usage.toolCalls > 0) {
    parts.push(
      `${usage.toolCalls} ${usage.toolCalls === 1 ? "tool" : "tools"} (${usage.topTools.join(", ")})`,
    );
  }
  if (row.state === "active" && row.startedAt !== null) {
    parts.push(
      <AgentElapsed
        agent={{ status: "running", startedAt: row.startedAt, completedAt: null }}
        compact
      />,
    );
  } else if (elapsedMs !== null) {
    parts.push(formatDuration(elapsedMs));
  }
  if (parts.length === 0) return null;
  return (
    <span className="mt-1 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
      {parts.map((part, index) => (
        // The parts are positional: which ones show changes, not which one is which.
        // oxlint-disable-next-line react/no-array-index-key
        <Fragment key={index}>
          {index === 0 ? null : <span aria-hidden>·</span>}
          <span className={cn("min-w-0", index === parts.length - 1 ? "shrink-0" : "truncate")}>
            {part}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

const ROW_CLASS_NAME =
  "flex w-full items-start gap-2 rounded-(--control-radius) px-2.5 py-2 text-left";

function SubagentRowView(props: {
  readonly row: ThreadSubagentRow;
  readonly threadRef: ScopedThreadRef;
}) {
  const { row, threadRef } = props;
  const content = (
    <>
      <SubagentStateIcon state={row.state} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{row.label}</span>
        {row.summary === null ? null : (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{row.summary}</span>
        )}
        <SubagentMeta row={row} threadRef={threadRef} />
      </span>
    </>
  );
  const childThreadId = row.childThreadId;
  if (childThreadId === null) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              tabIndex={0}
              aria-disabled="true"
              className={`${ROW_CLASS_NAME} cursor-default opacity-70`}
            />
          }
        >
          {content}
        </TooltipTrigger>
        <TooltipPopup side="top">This sub agent has no session to open.</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <button
      type="button"
      onClick={() => useRightPanelStore.getState().openSubagentSession(threadRef, childThreadId)}
      className={`${ROW_CLASS_NAME} cursor-pointer transition-colors hover:bg-accent/60`}
    >
      {content}
    </button>
  );
}

function SubagentGroupHeader(props: {
  readonly group: ThreadSubagentGroup;
  readonly expanded: boolean;
  readonly threadRef: ScopedThreadRef;
}) {
  const { group, expanded, threadRef } = props;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() =>
        useRightPanelStore
          .getState()
          .setSubagentGroupExpanded(threadRef, group.parentThreadId, !expanded)
      }
      className="flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-(--control-radius) px-2 text-left text-xs transition-colors hover:bg-accent/60"
    >
      <ChevronRightIcon
        aria-hidden
        className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-90")}
      />
      <span className="min-w-0 truncate font-medium">{group.title}</span>
      <span className="shrink-0 text-muted-foreground">
        · {formatSubagentAgentCount(group.rows.length)}
      </span>
      {!expanded && group.activeCount > 0 ? <SubagentStateIcon state="active" /> : null}
    </button>
  );
}

type ListItem =
  | { readonly kind: "group"; readonly group: ThreadSubagentGroup; readonly expanded: boolean }
  | { readonly kind: "row"; readonly row: ThreadSubagentRow };

const listItemKey = (item: ListItem) =>
  item.kind === "group" ? `group:${item.group.parentThreadId}` : `row:${item.row.key}`;

function SubagentsList(props: {
  readonly threadRef: ScopedThreadRef;
  readonly groupExpansion: Readonly<Record<string, boolean>> | undefined;
}) {
  const { threadRef, groupExpansion } = props;
  const groups = useSubagentGroups(threadRef);
  if (groups.length === 0) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>No sub agents yet</EmptyTitle>
          <EmptyDescription>Work an agent hands to sub agents shows up here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  // The open thread's group starts open and the rest closed; the user's own choice wins.
  const items = groups.flatMap((group): ListItem[] => {
    const expanded =
      groupExpansion?.[group.parentThreadId] ?? group.parentThreadId === threadRef.threadId;
    return [
      { kind: "group", group, expanded },
      ...(expanded ? group.rows.map((row): ListItem => ({ kind: "row", row })) : []),
    ];
  });
  // Only the rows in view are mounted, and each mounted row loads its own thread detail.
  return (
    <LegendList<ListItem>
      data={items}
      keyExtractor={listItemKey}
      getItemType={(item) => item.kind}
      renderItem={({ item }) =>
        item.kind === "group" ? (
          <SubagentGroupHeader group={item.group} expanded={item.expanded} threadRef={threadRef} />
        ) : (
          <SubagentRowView row={item.row} threadRef={threadRef} />
        )
      }
      getFixedItemSize={(item) => (item.kind === "group" ? GROUP_HEADER_HEIGHT : undefined)}
      estimatedItemSize={ROW_HEIGHT_ESTIMATE}
      drawDistance={200}
      className="min-h-0 flex-1 overscroll-contain p-1.5"
    />
  );
}

function SubagentSessionHeader(props: {
  readonly threadRef: ScopedThreadRef;
  readonly childThreadId: ThreadId;
}) {
  const { threadRef, childThreadId } = props;
  const row = useSubagentGroups(threadRef)
    .flatMap((group) => group.rows)
    .find((entry) => entry.childThreadId === childThreadId);
  const child = useQuietThreadShell(scopeThreadRef(threadRef.environmentId, childThreadId));
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-3 pl-1.5">
      <Button
        variant="ghost"
        size="xs"
        aria-label="Back to sub agents"
        onClick={() => useRightPanelStore.getState().openSubagentSession(threadRef, null)}
      >
        <ChevronLeftIcon />
        Sub agents
      </Button>
      {row === undefined ? null : <SubagentStateIcon state={row.state} />}
      <span className="min-w-0 flex-1 truncate text-sm">
        {row?.label ?? formatSubagentDisplayTitle(child?.title ?? "")}
      </span>
    </div>
  );
}

function SubagentSession(props: {
  readonly threadRef: ScopedThreadRef;
  readonly childThreadId: string;
}) {
  const { threadRef } = props;
  const childThreadId = ThreadId.make(props.childThreadId);
  const child = useQuietThreadShell(scopeThreadRef(threadRef.environmentId, childThreadId));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SubagentSessionHeader threadRef={threadRef} childThreadId={childThreadId} />
      {child === null || child.deletedAt != null ? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>This sub agent is no longer available</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        // The thread's own composer handle: the shared one belongs to the main view's composer.
        <ComposerHandleContext value={null}>
          <ChatView
            key={childThreadId}
            embedded
            routeKind="server"
            environmentId={threadRef.environmentId}
            threadId={childThreadId}
            onOpenRelatedThread={(relatedThreadId) =>
              useRightPanelStore.getState().openSubagentSession(threadRef, relatedThreadId)
            }
          />
        </ComposerHandleContext>
      )}
    </div>
  );
}

/**
 * The right panel's Sub agents tab: every sub agent in the environment grouped by parent thread,
 * and the session of the one the user opened. The open thread stays on the main page throughout.
 */
export function SubagentsPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly childThreadId: string | null;
  readonly groupExpansion: Readonly<Record<string, boolean>> | undefined;
}) {
  return props.childThreadId === null ? (
    <SubagentsList threadRef={props.threadRef} groupExpansion={props.groupExpansion} />
  ) : (
    <SubagentSession threadRef={props.threadRef} childThreadId={props.childThreadId} />
  );
}

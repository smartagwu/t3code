import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  deriveThreadSubagentRows,
  type ThreadSubagentRow,
  type ThreadSubagentRowState,
} from "@t3tools/client-runtime/state/thread-subagents";
import { ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { ChevronLeftIcon, CircleCheckIcon, CircleSlashIcon, CircleXIcon } from "lucide-react";

import { ComposerHandleContext } from "../../composerHandleContext";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  useThreadRelationshipShells,
} from "../../state/entities";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const NO_SUBAGENTS: ReadonlyArray<never> = [];

const STATE_LABELS = {
  active: "Working",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
} as const satisfies Record<ThreadSubagentRowState, string>;

function useThreadSubagentRows(threadRef: ScopedThreadRef): ReadonlyArray<ThreadSubagentRow> {
  const subagents = useQuietThreadProjection(threadRef)?.projection.subagents ?? NO_SUBAGENTS;
  const shells = useThreadRelationshipShells(threadRef);
  return deriveThreadSubagentRows({ threadId: threadRef.threadId, subagents, shells });
}

function SubagentStateIcon(props: { readonly state: ThreadSubagentRowState }) {
  const label = STATE_LABELS[props.state];
  switch (props.state) {
    case "active":
      return <Spinner size="md" tone="warning" aria-label={label} />;
    case "done":
      return (
        <CircleCheckIcon role="img" aria-label={label} className="size-4 shrink-0 text-success" />
      );
    case "failed":
      return (
        <CircleXIcon role="img" aria-label={label} className="size-4 shrink-0 text-destructive" />
      );
    case "stopped":
      return (
        <CircleSlashIcon
          role="img"
          aria-label={label}
          className="size-4 shrink-0 text-muted-foreground"
        />
      );
  }
}

const ROW_CLASS_NAME =
  "flex h-8 w-full items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm";

function SubagentRow(props: {
  readonly row: ThreadSubagentRow;
  readonly onOpen: (childThreadId: string) => void;
}) {
  const { row, onOpen } = props;
  const content = (
    <>
      <SubagentStateIcon state={row.state} />
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
    </>
  );
  if (row.childThreadId === null) {
    return (
      <li>
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                tabIndex={0}
                aria-disabled="true"
                className={`${ROW_CLASS_NAME} cursor-default opacity-60`}
              />
            }
          >
            {content}
          </TooltipTrigger>
          <TooltipPopup side="top">This sub agent has no session to open.</TooltipPopup>
        </Tooltip>
      </li>
    );
  }
  const childThreadId = row.childThreadId;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(childThreadId)}
        className={`${ROW_CLASS_NAME} cursor-pointer transition-colors hover:bg-accent/60`}
      >
        {content}
      </button>
    </li>
  );
}

function SubagentsList(props: { readonly threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  const rows = useThreadSubagentRows(threadRef);
  if (rows.length === 0) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>No sub agents yet</EmptyTitle>
          <EmptyDescription>
            Work this thread delegates to other agents shows up here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ScrollArea>
      <ul aria-label="Sub agents" className="m-0 flex list-none flex-col gap-0.5 p-2">
        {rows.map((row) => (
          <SubagentRow
            key={row.key}
            row={row}
            onOpen={(childThreadId) =>
              useRightPanelStore.getState().openSubagentSession(threadRef, childThreadId)
            }
          />
        ))}
      </ul>
    </ScrollArea>
  );
}

function SubagentSession(props: {
  readonly threadRef: ScopedThreadRef;
  readonly childThreadId: string;
}) {
  const { threadRef } = props;
  const childThreadId = ThreadId.make(props.childThreadId);
  const childRef = scopeThreadRef(threadRef.environmentId, childThreadId);
  const child = useQuietThreadShell(childRef);
  const row = useThreadSubagentRows(threadRef).find(
    (entry) => entry.childThreadId === childThreadId,
  );
  const backToList = () => useRightPanelStore.getState().openSubagentSession(threadRef, null);
  const title = row?.label ?? formatSubagentDisplayTitle(child?.title ?? "");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-3 pl-1.5">
        <Button variant="ghost" size="xs" aria-label="Back to sub agents" onClick={backToList}>
          <ChevronLeftIcon />
          Sub agents
        </Button>
        {row === undefined ? null : <SubagentStateIcon state={row.state} />}
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
      </div>
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
 * The right panel's Sub agents tab: the parent thread's sub agents, and the session of the one
 * the user opened. The parent thread stays on the main page the whole time.
 */
export function SubagentsPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly childThreadId: string | null;
}) {
  return props.childThreadId === null ? (
    <SubagentsList threadRef={props.threadRef} />
  ) : (
    <SubagentSession threadRef={props.threadRef} childThreadId={props.childThreadId} />
  );
}

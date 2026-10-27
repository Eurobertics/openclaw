import { Show, createMemo, lazy } from "solid-js";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "./chat-details-subagents.css";
import "./chat-subagents-working.css";
import type { ChatSubagentActivity } from "../chat-subagent-wait.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

const ChatDetailsSubagentRows = lazy(() => import("./chat-details-subagent-rows.tsx"), {
  export: "ChatDetailsSubagentRows",
});

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

export type Subagent = Pick<ChatSubagentActivity, "key" | "label" | "status">;

export type ChatDetailsSubagentsProps = {
  /** Collection members, in native launch order. The caller owns roster selection. */
  rows: readonly Subagent[];
  /** Native mobile presentation, not the width of a desktop pane. */
  mobile: boolean;
  /** Render in the section header's trailing slot when its body is collapsed. */
  collapsed?: boolean;
  /** Localized “Working”, without the ellipsis used by common.working. */
  workingLabel: string;
  onOpenSubagent: (key: string) => void;
  /** Must request the collection explicitly, clearing any previously selected child. */
  onOpenSubagents: () => void;
};

const SUMMARY_ORDER = ["running", "waiting", "queued", "done", "stopped"] as const;
function isWorking(row: Subagent) {
  return row.status === "running" || row.status === "waiting";
}

/** Controlled Details content. The parent owns section chrome and navigation. */
export function ChatDetailsSubagents(props: ChatDetailsSubagentsProps) {
  const working = createMemo(() => props.rows.filter(isWorking));
  const ordered = createMemo(() => [...working(), ...props.rows.filter((row) => !isWorking(row))]);
  const counts = createMemo(() =>
    SUMMARY_ORDER.map((status) => ({
      status,
      // Done summarizes settled work here; individual rows retain their real outcome.
      count: props.rows.filter((row) => (row.status === "failed" ? "done" : row.status) === status)
        .length,
    })).filter((entry) => entry.count > 0),
  );
  return (
    <Show when={props.rows.length > 0}>
      <Show
        when={!props.collapsed}
        fallback={
          <Show when={working().length > 0}>
            <span
              class="chat-details-subagents__collapsed"
              role="img"
              aria-label={
                working().length === 1
                  ? t("chat.subagentsRunningOne")
                  : t("chat.subagentsRunning", { count: String(working().length) })
              }
            >
              <span class="session-run-spinner" aria-hidden="true" />
            </span>
          </Show>
        }
      >
        <ChatLazyBoundary>
          <ChatDetailsSubagentRows {...props} ordered={ordered()} counts={counts()} />
        </ChatLazyBoundary>
      </Show>
    </Show>
  );
}

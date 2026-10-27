import { For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatDetailsSubagentsProps, Subagent } from "./chat-details-subagents.tsx";

const STATUS_KEYS = {
  queued: "common.queued",
  waiting: "chat.waitingOnSubagents",
  done: "activity.status.done",
  failed: "common.failed",
  stopped: "chat.sessionDetails.stopped",
} as const;

function isWorking(row: Subagent) {
  return row.status === "running" || row.status === "waiting";
}

function statusLabel(row: Subagent, workingLabel: string) {
  return row.status === "running" ? workingLabel : t(STATUS_KEYS[row.status]);
}

function SubagentAvatar(props: { row: Subagent; summary?: boolean }) {
  return (
    <span
      class="chat-details-subagents__avatar"
      style={{ "--subagent-avatar-hue": fnv1aUtf16(props.row.key) % 360 }}
      aria-hidden="true"
    >
      <Icon name="bot" />
      <Show when={!props.summary && (isWorking(props.row) || props.row.status === "done")}>
        <span class="chat-details-subagents__badge">
          <Show
            when={isWorking(props.row)}
            fallback={<Icon name="check" class="chat-details-subagents__check" />}
          >
            <span class="chat-details-subagents__spinner" />
          </Show>
        </span>
      </Show>
    </span>
  );
}

function SubagentRow(props: ChatDetailsSubagentsProps & { row: Subagent }) {
  const nameOverflow = useScrollState(true, false);
  return (
    <div role="listitem">
      <button
        type="button"
        class="chat-details-subagents__row"
        data-subagent-session-key={props.row.key}
        aria-label={`${props.row.label} ${statusLabel(props.row, props.workingLabel)}`}
        onClick={() => props.onOpenSubagent(props.row.key)}
      >
        <SubagentAvatar row={props.row} />
        <span class="chat-details-subagents__name" ref={nameOverflow}>
          {props.row.label}
        </span>
        <span
          class={[
            "chat-details-subagents__status",
            {
              "sr-only":
                props.row.status === "done" || (props.mobile && props.row.status === "running"),
              "chat-details-subagents__working": !props.mobile && props.row.status === "running",
            },
          ]}
        >
          {statusLabel(props.row, props.workingLabel)}
        </span>
        <Show when={props.mobile}>
          <Icon name="chevronRight" class="chat-details-subagents__chevron" />
        </Show>
      </button>
    </div>
  );
}

export function ChatDetailsSubagentRows(
  props: ChatDetailsSubagentsProps & {
    ordered: readonly Subagent[];
    counts: readonly { status: Subagent["status"]; count: number }[];
  },
) {
  const countLabel = (status: Subagent["status"]) =>
    status === "running" ? props.workingLabel : t(STATUS_KEYS[status]);
  return (
    <div class={["chat-details-subagents", { "chat-details-subagents--mobile": props.mobile }]}>
      <Show
        when={props.rows.length > (props.mobile ? 3 : 5)}
        fallback={
          <div
            class="chat-details-subagents__list"
            role="list"
            aria-label={t("chat.sessionDetails.subagents")}
          >
            <For each={props.ordered} keyed={(row) => row.key}>
              {(row) => <SubagentRow {...props} row={row()} />}
            </For>
          </div>
        }
      >
        <button
          type="button"
          class="chat-details-subagents__row chat-details-subagents__summary"
          onClick={() => props.onOpenSubagents()}
          aria-label={`${t("chat.sessionDetails.allSubagents")}. ${props.counts
            .map((entry) => `${entry.count} ${countLabel(entry.status)}`)
            .join(", ")}`}
        >
          <span class="chat-details-subagents__stack" aria-hidden="true">
            <For each={props.ordered.slice(0, 4)} keyed={(row) => row.key}>
              {(row) => <SubagentAvatar row={row()} summary />}
            </For>
          </span>
          <span class="chat-details-subagents__counts">
            <For each={props.counts} keyed={(entry) => entry.status}>
              {(entry) => (
                <span class="chat-details-subagents__count" data-status={entry().status}>
                  <span>{entry().count}</span>{" "}
                  <span class="chat-details-subagents__count-label">
                    {countLabel(entry().status)}
                  </span>
                </span>
              )}
            </For>
          </span>
          <Show when={props.mobile}>
            <Icon name="chevronRight" class="chat-details-subagents__chevron" />
          </Show>
        </button>
      </Show>
    </div>
  );
}

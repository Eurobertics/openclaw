import { Show, createMemo } from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { createProcessesPresentation } from "./chat-processes-presentation.ts";

export function ChatDetailsDesktopProcessRow(props: {
  row: SessionProcessSummary;
  presentation: ReturnType<typeof createProcessesPresentation>;
  presented: boolean;
  onOpen: () => void;
  elementRef: (instanceId: string) => (element: HTMLDivElement) => void;
}) {
  const stop = createMemo(() => props.presentation.createStop(() => props.row));
  const nameOverflow = useScrollState(true, false, { revision: () => props.row.name });
  const status = () =>
    t(
      stop().stopping()
        ? "chat.processesPanel.stopping"
        : `chat.processesPanel.status.${props.row.status}`,
    );
  const description = () => `${props.row.name}. ${status()}`;
  return (
    <div
      ref={[props.elementRef(props.row.instanceId)]}
      class="chat-details-processes__row"
      role="listitem"
      data-process-id={props.row.processId}
      data-status={props.row.status}
      data-stopping={stop().stopping() ? "" : undefined}
      data-actionable={props.row.canStop ? "" : undefined}
    >
      <button
        class="chat-details-processes__open"
        type="button"
        aria-label={description()}
        disabled={!props.presented}
        onClick={() => props.onOpen()}
      >
        <span class="chat-details-processes__icon" aria-hidden="true">
          <Icon name="squareTerminal" />
          <span class="chat-details-processes__badge" data-status={props.row.status}>
            <span class="chat-details-processes__spinner" />
          </span>
        </span>
        <span class="chat-details-processes__name" ref={nameOverflow}>
          {props.row.name}
        </span>
      </button>
      <Show when={props.row.status === "running" && props.row.canStop}>
        <button
          class="chat-details-processes__action chat-details-processes__stop"
          type="button"
          title={t("chat.processesPanel.stopProcess")}
          aria-label={t("chat.processesPanel.stop", { name: props.row.name })}
          disabled={!props.presented || stop().stopping()}
          onClick={() => {
            if (props.presented) {
              void stop().stop();
            }
          }}
        >
          <Show when={stop().stopping()} fallback={<Icon name="stop" />}>
            <span class="chat-details-processes__spinner" />
          </Show>
        </button>
      </Show>
      <Show when={stop().stopping()}>
        <span class="sr-only" role="status">
          {status()}
        </span>
      </Show>
    </div>
  );
}

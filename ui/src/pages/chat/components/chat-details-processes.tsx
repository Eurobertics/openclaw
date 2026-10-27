import {
  Errored,
  For,
  Loading,
  Show,
  createMemo,
  createSignal,
  isPending,
  latest,
  lazy,
} from "solid-js";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createKeyedListMotion } from "../../../lib/reactive/keyed-list-motion.ts";
import type { ProcessesPanelData } from "../processes-panel-data.ts";
import "./chat-details-processes.css";
import { ChatDetailsDesktopSection } from "./chat-details-desktop-section.tsx";
import { createDetailsProcessesPresentation } from "./chat-details-processes-presentation.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { createProcessesPresentation } from "./chat-processes-presentation.ts";

const ProcessRow = lazy(() => import("./chat-details-desktop-process-row.tsx"), {
  export: "ChatDetailsDesktopProcessRow",
});

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

type Props = {
  /** Read the native host's projection; it owns observation, refresh and stop authority. */
  processes: () => ProcessesPanelData | undefined;
  presented: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onOpen?: (instanceId?: string) => void;
};

/** Desktop list using the same process snapshot and operations as the full panel. */
export function ChatDetailsProcesses(props: Props) {
  const presentation = createProcessesPresentation(() => props.processes(), true);
  const snapshot = () => props.processes()?.snapshot;
  const rows = createDetailsProcessesPresentation(() => snapshot()?.rows ?? []);
  const visibleRows = createMemo(() => rows().slice(0, 3));
  const hidden = () => rows().length - visibleRows().length;
  const [revealing, setRevealing] = createSignal(false);
  const motion = createKeyedListMotion({
    ids: () => visibleRows().map((row) => row.instanceId),
    scope: presentation.scope,
    ready: () => Boolean(snapshot()?.hasResult),
    active: () =>
      props.presented && props.expanded && !revealing() && snapshot()?.errorKind !== "access",
  });
  const open = (instanceId?: string) => {
    if (props.presented) {
      props.onOpen?.(instanceId);
    }
  };
  const hasRunning = () => rows().length > 0;
  const ProcessError = (errorProps: { loading: boolean; retry: () => void }) => (
    <Show when={snapshot()?.errorKind !== "read" && snapshot()?.error}>
      {(error) => (
        <div class="chat-details-processes__error" role="alert">
          <span>{error()}</span>
          <button
            class="chip"
            type="button"
            disabled={!props.presented || errorProps.loading}
            onClick={() => errorProps.retry()}
          >
            {t("common.retry")}
          </button>
        </div>
      )}
    </Show>
  );
  const Content = (contentProps: { loading: boolean; retry: () => void }) => (
    <>
      <Show when={!hasRunning()}>
        <ProcessError loading={contentProps.loading} retry={contentProps.retry} />
      </Show>
      <Show when={hasRunning()}>
        <div class="chat-details-processes" aria-busy={contentProps.loading ? "true" : "false"}>
          <ProcessError loading={contentProps.loading} retry={contentProps.retry} />
          <div
            class="chat-details-processes__list"
            role="list"
            aria-label={t("chat.sessionDetails.processes")}
          >
            <ChatLazyBoundary>
              <For each={visibleRows()} keyed={(row) => row.instanceId}>
                {(row) => (
                  <ProcessRow
                    row={row()}
                    elementRef={motion.row}
                    presentation={presentation}
                    presented={props.presented}
                    onOpen={() => open(row().instanceId)}
                  />
                )}
              </For>
            </ChatLazyBoundary>
          </div>
          <button
            class="chat-details-processes__view-all"
            type="button"
            disabled={!props.presented}
            onClick={() => open()}
          >
            {hidden() > 0
              ? t("chat.sessionDetails.showMore", { count: String(hidden()) })
              : t("chat.processesPanel.viewAll")}
          </button>
        </div>
      </Show>
    </>
  );
  const retry = () => void props.processes()?.refresh();
  const ReadContent = () => (
    <Errored
      fallback={(_error, reset) => (
        <Content
          loading={isPending(presentation.read)}
          retry={() => {
            retry();
            reset();
          }}
        />
      )}
    >
      <Loading on={presentation.scope()} fallback={<Content loading retry={retry} />}>
        {(latest(presentation.read), null)}
        <Content loading={isPending(presentation.read)} retry={retry} />
      </Loading>
    </Errored>
  );
  // The disclosure's layout owner must survive pending and errored body reads.
  return (
    <Show when={props.onOpen}>
      <Show when={motion.present()} fallback={<ReadContent />}>
        <div ref={motion.shell} class="chat-details-processes__envelope">
          <div ref={motion.content} class="chat-details-processes__motion-content">
            <Show when={hasRunning()}>
              <ChatDetailsDesktopSection
                section="processes"
                title={t("chat.sessionDetails.processes")}
                expanded={props.expanded}
                presented={props.presented}
                onExpandedChange={(expanded) => props.onExpandedChange(expanded)}
                onRevealMotionChange={setRevealing}
              >
                <ReadContent />
              </ChatDetailsDesktopSection>
            </Show>
          </div>
        </div>
      </Show>
    </Show>
  );
}

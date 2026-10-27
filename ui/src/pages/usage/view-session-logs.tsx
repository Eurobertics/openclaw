import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type Range,
  type VirtualItem,
} from "@tanstack/virtual-core";
import { createMemo, createSignal, For, onSettled } from "solid-js";
import { createMsFormatter } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";
import type { ParsedSessionLog } from "./helpers.ts";
import { formatUsageTokens } from "./metrics.ts";

const ESTIMATED_ROW_HEIGHT = 730;
const WINDOWED_ROW_COUNT = 100;
const INITIAL_ROW_COUNT = 6;

/** The admitted receipt owns row identities; filters only choose occurrences from it. */
export function SessionLogList(props: {
  entries: ParsedSessionLog[];
  rows: ParsedSessionLog[];
  expanded: boolean;
}) {
  let list: HTMLDivElement;
  let measuredReceipt: ParsedSessionLog[] | undefined;
  const getViewport = () => list.closest<HTMLElement>("main.content");
  const mountedRows = new Set<HTMLDivElement>();
  const [viewport, setViewport] = createSignal<HTMLElement | null>();
  const [window, setWindow] = createSignal<{ items: VirtualItem[]; height: number }>();
  // Reordering can retain focus only while the same row identity remains admitted.
  const [focused, setFocused] = createSignal<ParsedSessionLog | undefined>((previous) => {
    const entries = props.entries;
    return previous && entries.includes(previous) ? previous : undefined;
  });
  const [disclosures, setDisclosures] = createSignal<{
    receipt: ParsedSessionLog[];
    expanded: boolean;
    overrides: ReadonlyMap<ParsedSessionLog, boolean>;
  }>((previous) => {
    const receipt = props.entries;
    const expanded = props.expanded;
    return previous?.receipt === receipt && previous.expanded === expanded
      ? previous
      : { receipt, expanded, overrides: new Map() };
  });
  const formatTimestamp = createMemo(() => createMsFormatter(undefined, t("common.na")));
  const receiptIndexes = createMemo(
    () => new Map(props.entries.map((entry, index) => [entry, index])),
  );
  const rowIndexes = createMemo(() => new Map(props.rows.map((entry, index) => [entry, index])));
  const itemKey = createMemo(() => {
    const rows = props.rows;
    const staticIndexes = receiptIndexes();
    return (index: number) => staticIndexes.get(rows[index]!)!;
  });
  // Before mount, render only the initial window; standalone consumers without
  // the shell scroller fall back to the unchanged eager list after settling.
  const windowed = createMemo(() => props.rows.length >= WINDOWED_ROW_COUNT && viewport() !== null);
  const pinned = createMemo(() => {
    const rows = props.rows;
    const currentFocus = focused();
    const focusIndex = currentFocus ? rowIndexes().get(currentFocus) : undefined;
    const indexes = new Set([0, rows.length - 1]);
    const interactive = rows.flatMap((entry, index) =>
      entry.toolInfo.tools.length ? [index] : [],
    );
    if (interactive.length) {
      indexes.add(interactive[0]!);
      indexes.add(interactive.at(-1)!);
    }
    if (focusIndex !== undefined) {
      indexes.add(focusIndex);
      const next = interactive.find((index) => index > focusIndex);
      const previous = interactive.findLast((index) => index < focusIndex);
      if (next !== undefined) {
        indexes.add(next);
      }
      if (previous !== undefined) {
        indexes.add(previous);
      }
    }
    return [...indexes].filter((index) => index >= 0 && index < rows.length);
  });
  const rangeExtractor = createMemo(() => {
    // TanStack keeps each callback until the next measured memo snapshot.
    const staticIndexes = pinned();
    return (range: Range) =>
      [...new Set([...defaultRangeExtractor(range), ...staticIndexes])].toSorted((a, b) => a - b);
  });
  const publish = () => {
    if (virtualizer.options.enabled) {
      setWindow({ items: virtualizer.getVirtualItems(), height: virtualizer.getTotalSize() });
    }
  };
  const virtualizer = new Virtualizer<HTMLElement, HTMLDivElement>({
    count: 0,
    enabled: false,
    getScrollElement: getViewport,
    initialOffset: () => getViewport()?.scrollTop ?? 0,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    overscan: 2,
    gap: 10,
    useAnimationFrameWithResizeObserver: true,
    onChange: publish,
  });
  onSettled(() => {
    setViewport(getViewport());
    const { _didMount: mountVirtualizer } = virtualizer;
    return mountVirtualizer();
  });
  createLayoutMeasurement(
    () => ({
      receipt: props.entries,
      rows: props.rows,
      itemKey: itemKey(),
      rangeExtractor: rangeExtractor(),
      viewport: viewport(),
      windowed: windowed(),
    }),
    (next) => {
      if (!next?.viewport) {
        return;
      }
      if (next.viewport.clientHeight === 0) {
        // Parked routes must not replace real row sizes with hidden geometry.
        virtualizer.setOptions({ ...virtualizer.options, useCachedMeasurements: true });
        return;
      }
      virtualizer.setOptions({
        ...virtualizer.options,
        enabled: next.windowed,
        useCachedMeasurements: false,
        count: next.rows.length,
        getItemKey: next.itemKey,
        scrollMargin:
          list.getBoundingClientRect().top -
          next.viewport.getBoundingClientRect().top +
          next.viewport.scrollTop,
        rangeExtractor: next.rangeExtractor,
      });
      const { _willUpdate: updateVirtualizer } = virtualizer;
      updateVirtualizer();
      if (measuredReceipt !== next.receipt) {
        measuredReceipt = next.receipt;
        virtualizer.measure();
      }
      if (next.windowed) {
        for (const row of mountedRows) {
          virtualizer.measureElement(row);
        }
      }
      publish();
    },
    {
      targets: () => {
        const scroller = getViewport();
        // Earlier Usage sections can move the list without resizing it.
        const page = list.closest<HTMLElement>(".usage-page");
        return [list, ...(scroller ? [scroller] : []), ...(page ? [page] : [])];
      },
      changeTiming: "sync",
      fonts: true,
    },
  );
  const items = createMemo(() => new Map(window()?.items.map((item) => [item.index, item])));
  const visibleRows = createMemo(() => {
    if (!windowed()) {
      return props.rows;
    }
    const range = window()
      ? items().keys()
      : Array.from({ length: Math.min(INITIAL_ROW_COUNT, props.rows.length) }, (_, index) => index);
    const indexes = new Set([...pinned(), ...range]);
    return [...indexes].toSorted((a, b) => a - b).flatMap((index) => props.rows[index] ?? []);
  });
  function Row(rowProps: { entry: ParsedSessionLog }) {
    let element: HTMLDivElement;
    const index = () => rowIndexes().get(rowProps.entry)!;
    const top = () => {
      const item = items().get(index());
      return item
        ? item.start - virtualizer.options.scrollMargin
        : index() * (ESTIMATED_ROW_HEIGHT + 10);
    };
    const open = () => disclosures().overrides.get(rowProps.entry) ?? disclosures().expanded;
    onSettled(() => {
      mountedRows.add(element);
      if (virtualizer.options.enabled) {
        virtualizer.measureElement(element);
      }
      return () => {
        mountedRows.delete(element);
        virtualizer.measureElement(null);
      };
    });
    return (
      <div
        ref={(node) => (element = node)}
        class={["session-log-entry", rowProps.entry.log.role === "user" ? "user" : "assistant"]}
        role="listitem"
        aria-posinset={index() + 1}
        aria-setsize={props.rows.length}
        data-index={index()}
        style={
          windowed()
            ? {
                position: "absolute",
                top: "0",
                left: "0",
                width: "100%",
                transform: `translateY(${top()}px)`,
              }
            : undefined
        }
        onFocusIn={() => setFocused(rowProps.entry)}
      >
        <div class="session-log-meta">
          <span class="session-log-role">
            {rowProps.entry.log.role === "user"
              ? t("usage.details.you")
              : rowProps.entry.log.role === "assistant"
                ? t("usage.overview.assistant")
                : t("usage.details.tool")}
          </span>
          <span>{formatTimestamp()(rowProps.entry.log.timestamp)}</span>
          {rowProps.entry.log.tokens ? (
            <>
              {" "}
              <span>{formatUsageTokens(rowProps.entry.log.tokens)}</span>{" "}
            </>
          ) : undefined}
        </div>
        <div class="session-log-content">{rowProps.entry.cleanContent}</div>
        {rowProps.entry.toolInfo.tools.length ? (
          <details
            class="session-log-tools"
            prop:open={open()}
            onToggle={(event) => {
              const expanded = event.currentTarget.open;
              const entry = rowProps.entry;
              setDisclosures((current) => {
                if ((current.overrides.get(entry) ?? current.expanded) === expanded) {
                  return current;
                }
                const overrides = new Map(current.overrides);
                if (expanded === current.expanded) {
                  overrides.delete(entry);
                } else {
                  overrides.set(entry, expanded);
                }
                return { ...current, overrides };
              });
            }}
          >
            <summary>{rowProps.entry.toolInfo.summary}</summary>
            <div class="session-log-tools-list">
              <For each={rowProps.entry.toolInfo.tools}>
                {([name, count]) => (
                  <span class="session-log-tools-pill">
                    {name} × {count}
                  </span>
                )}
              </For>
            </div>
          </details>
        ) : undefined}
      </div>
    );
  }
  return (
    <div
      class="session-logs-list"
      role="list"
      ref={(element) => (list = element)}
      style={
        windowed()
          ? {
              position: "relative",
              height: `${window()?.height ?? props.rows.length * (ESTIMATED_ROW_HEIGHT + 10)}px`,
            }
          : undefined
      }
      onFocusOut={(event) => {
        if (!(event.relatedTarget instanceof Node) || !list.contains(event.relatedTarget)) {
          setFocused(undefined);
        }
      }}
    >
      <For each={visibleRows()}>{(entry) => <Row entry={entry} />}</For>
      {props.rows.length === 0 ? (
        <div class="usage-empty-block usage-empty-block--compact">
          {t("usage.details.noMessagesMatch")}
        </div>
      ) : undefined}
    </div>
  );
}

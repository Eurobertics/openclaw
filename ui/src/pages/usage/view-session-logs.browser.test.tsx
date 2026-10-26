import { createSignal } from "solid-js";
import { expect, it, onTestFinished } from "vitest";
import "../../styles.css";
import "../../styles/usage.css";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { SessionLogEntry } from "./types.ts";
import { SessionDetailPanel } from "./view-details.tsx";
import { createUsageProps } from "./view.test-support.ts";

function mountConversation() {
  const base = createUsageProps();
  const [logs, setLogs] = createSignal<SessionLogEntry[]>(
    Array.from({ length: 1_000 }, (_, index) => ({
      timestamp: 1_000 + index,
      role: "assistant",
      content: `message-${index}\n${"Wrapped synthetic conversation content.\n".repeat(12)}[Tool: tool_${index % 10}]`,
    })),
  );
  const [expanded, setExpanded] = createSignal(false);
  const [filters, setFilters] = createSignal(base.detail.logFilters);
  const viewport = document.createElement("main");
  viewport.className = "content";
  viewport.style.cssText = "position:fixed;inset:0;width:800px;height:600px;overflow:auto";
  document.body.append(viewport);
  const view = mountSolid(
    () => (
      <SessionDetailPanel
        session={{ key: "synthetic-conversation", label: "Synthetic conversation" }}
        detail={{
          ...base.detail,
          get sessionLogs() {
            return logs();
          },
          get sessionLogsExpanded() {
            return expanded();
          },
          get logFilters() {
            return filters();
          },
          sessionLogsStatus: { hasLoaded: true, error: null, stale: false, awaitingGateway: false },
        }}
        callbacks={{
          ...base.callbacks.details,
          onToggleSessionLogsExpanded: () => setExpanded((value) => !value),
          onLogFiltersChange: (patch) => setFilters((value) => ({ ...value, ...patch })),
        }}
        range={{ startDate: "", endDate: "", selectedDays: [], timeZone: "utc" }}
        contextExpanded={false}
        onClose={() => {}}
      />
    ),
    { container: viewport },
  );
  onTestFinished(() => {
    view.unmount();
    viewport.remove();
  });
  const list = () => viewport.querySelector<HTMLElement>(".session-logs-list")!;
  const row = (index: number) =>
    viewport.querySelector<HTMLElement>(`.session-log-entry[data-index="${index}"]`);
  const tools = (index: number) => row(index)?.querySelector<HTMLDetailsElement>("details");
  const listOffset = () =>
    list().getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
  return { viewport, view, list, row, tools, listOffset, setExpanded, setLogs, logs };
}

it("windows long conversations in the page scroller and retains local disclosures across reveal", async () => {
  const { page, userEvent } = await import("vitest/browser");
  await page.viewport(1000, 800);
  const fixture = mountConversation();
  const { viewport, row, tools, listOffset } = fixture;
  expect(row(1)).not.toBeNull();
  await waitForSolid(() => {
    expect(viewport.querySelectorAll(".session-log-entry").length).toBeLessThan(30);
    expect(viewport.querySelector(".session-logs-header-count")?.textContent).toContain("1000");
    expect(viewport.querySelectorAll('select[aria-label="Filter by tool"] option')).toHaveLength(10);
  });
  viewport.scrollTop = listOffset() + 10 * 740;
  await waitForSolid(() => expect(tools(10)).toBeDefined());
  await userEvent.click(tools(10)!.querySelector("summary")!);
  await waitForSolid(() => expect(tools(10)?.open).toBe(true));
  const savedTop =
    row(10)!.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
  fixture.view.getByRole("textbox", { name: "Search conversation" }).focus();
  row(999)!.scrollIntoView();
  await waitForSolid(() => {
    expect(row(10)).toBeNull();
    expect(tools(999)).toBeDefined();
  });
  viewport.scrollTop = savedTop;
  await waitForSolid(() => expect(tools(10)?.open).toBe(true));

  fixture.setExpanded(true);
  row(999)!.scrollIntoView();
  await waitForSolid(() => expect(tools(999)?.open).toBe(true));
  fixture.setExpanded(false);
  await waitForSolid(() => expect(tools(999)?.open).toBe(false));
  viewport.scrollTop = savedTop;
  await waitForSolid(() => expect(tools(10)?.open).toBe(false));
  await userEvent.click(tools(10)!.querySelector("summary")!);
  await waitForSolid(() => expect(tools(10)?.open).toBe(true));
  row(0)!.scrollIntoView();
  await userEvent.click(tools(0)!.querySelector("summary")!);
  await waitForSolid(() => expect(tools(0)?.open).toBe(true));
  fixture.setLogs(fixture.logs().map((entry) => ({ ...entry })));
  await waitForSolid(() => expect(tools(0)?.open).toBe(false));
  expect(getComputedStyle(fixture.list()).overflowY).not.toBe("auto");
});

it("keeps the focused summary and its next native Tab target mounted during scrolling", async () => {
  const { page, userEvent } = await import("vitest/browser");
  await page.viewport(1000, 800);
  const { viewport, row, tools, listOffset } = mountConversation();
  viewport.scrollTop = listOffset() + 10 * 740;
  await waitForSolid(() => expect(tools(10)).toBeDefined());
  const summary = tools(10)!.querySelector("summary")!;
  summary.focus();
  row(999)!.scrollIntoView();
  await waitForSolid(() => {
    expect(document.activeElement).toBe(summary);
    expect(tools(11)).toBeDefined();
  });
  await userEvent.tab();
  expect(document.activeElement).toBe(tools(11)!.querySelector("summary"));
  const target = row(11)!.getBoundingClientRect();
  const bounds = viewport.getBoundingClientRect();
  expect(target.bottom).toBeGreaterThan(bounds.top);
  expect(target.top).toBeLessThan(bounds.bottom);
});

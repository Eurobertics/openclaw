import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { extractCanvasShortcodes } from "../../../../src/chat/canvas-render.js";
import type { ChatItem, MessageGroup, NormalizedMessage } from "../../lib/chat/chat-types.ts";
import {
  canvasPreviewsMatch,
  readCanvasContentPreview,
  normalizeRoleForGrouping,
} from "../../lib/chat/message-normalizer.ts";
import type { CanvasToolPreview } from "../../lib/chat/tool-cards.ts";
import { canvasPreviewBaseIdentity, hasRenderableNormalizedMessage } from "./chat-thread-items.ts";
import { transcriptRunId } from "./chat-thread-run-identity.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { copyLiveTerminalIdentity, readLiveTerminalRunId } from "./terminal-message-identity.ts";

export function canvasAssistantItemKey(
  message: unknown,
  source: Parameters<typeof canvasPreviewBaseIdentity>[1],
  fallback: string,
): string {
  const identity = canvasPreviewBaseIdentity(message, source);
  return identity ? `canvas:${identity}` : `${fallback}:canvas`;
}

export function collectCanvasTurns(
  historyItems: Array<Extract<ChatItem, { kind: "message" }>>,
  normalizedHistory: Array<NormalizedMessage | null>,
  matchesSearch: (message: unknown) => boolean,
) {
  let canvasTurn: {
    previews: { preview: CanvasToolPreview; item: (typeof historyItems)[number] }[];
    lastMatchingAssistantIndex: number;
  } = {
    previews: [],
    lastMatchingAssistantIndex: -1,
  };
  // Rows in one turn share these facts so a tool result can see the assistant
  // projection that follows it, without consuming a view from another turn.
  return historyItems.map((item, index) => {
    const message = normalizedHistory[index];
    const role = message && normalizeRoleForGrouping(message.role);
    if (role === "user" || role === "system") {
      canvasTurn = { previews: [], lastMatchingAssistantIndex: -1 };
    }
    if (role === "assistant" && message && matchesSearch(item.message)) {
      canvasTurn.lastMatchingAssistantIndex = index;
      canvasTurn.previews.push(
        ...message.content.flatMap((block) =>
          block.type === "canvas" ? [{ preview: block.preview, item }] : [],
        ),
      );
    }
    return canvasTurn;
  });
}

export function collectOwnedCanvasPreviews(items: readonly (ChatItem | MessageGroup)[]) {
  const messages = items.flatMap((item) =>
    item.kind === "group"
      ? item.messages.map((entry) => entry.message)
      : item.kind === "message"
        ? [item.message]
        : [],
  );
  return messages.flatMap((source) => {
    if (readLiveTerminalRunId(source)) {
      return [];
    }
    const runId = transcriptRunId(source);
    const message = runId ? safeNormalizeMessage(source) : null;
    if (!message || normalizeRoleForGrouping(message.role) !== "assistant") {
      return [];
    }
    return message.content.flatMap((block) =>
      block.type === "canvas" ? [{ runId, preview: block.preview }] : [],
    );
  });
}

export function stripOwnedCanvasShortcodes(
  text: string,
  runId: string | null | undefined,
  ownedCanvas: ReturnType<typeof collectOwnedCanvasPreviews>,
): string {
  if (ownedCanvas.length === 0) {
    return text;
  }
  return extractCanvasShortcodes(text, (preview) =>
    ownedCanvas.some(
      (entry) => entry.runId === runId && canvasPreviewsMatch(entry.preview, preview),
    ),
  ).text;
}

/** Reconcile live copies after the owned previews and stream rows have been placed. */
export function reconcileLiveCanvasPreviews(
  items: ChatItem[],
  hiddenHistoryKeys: ReadonlySet<string>,
  hiddenInputKeys: ReadonlySet<string>,
): ChatItem[] {
  const ownedCanvas = collectOwnedCanvasPreviews(
    items.filter((item) => !hiddenHistoryKeys.has(item.key) && !hiddenInputKeys.has(item.key)),
  );
  for (const item of items) {
    if (item.kind === "stream") {
      item.text = stripOwnedCanvasShortcodes(item.text, item.runId, ownedCanvas);
      continue;
    }
    if (item.kind !== "message") {
      continue;
    }
    const runId = readLiveTerminalRunId(item.message);
    const terminal = runId ? asRecord(item.message) : null;
    if (!terminal || !Array.isArray(terminal.content)) {
      continue;
    }
    const isOwned = (preview: Pick<CanvasToolPreview, "viewId" | "url">) =>
      ownedCanvas.some(
        (entry) => entry.runId === runId && canvasPreviewsMatch(entry.preview, preview),
      );
    let changed = false;
    const content = terminal.content.flatMap((value) => {
      const preview = readCanvasContentPreview(value);
      if (preview && isOwned(preview)) {
        changed = true;
        return [];
      }
      const block = asRecord(value);
      if (block?.type === "text" && typeof block.text === "string") {
        const extracted = extractCanvasShortcodes(block.text, isOwned);
        if (extracted.previews.length > 0) {
          changed = true;
          return [{ ...block, text: extracted.text }];
        }
      }
      return [value];
    });
    if (changed) {
      const projection = { ...terminal, content };
      copyLiveTerminalIdentity(terminal, projection);
      item.message = projection;
    }
  }
  return items.filter((item) =>
    item.kind === "stream"
      ? Boolean(item.text.trim() || item.thinking)
      : item.kind !== "message" || hasRenderableNormalizedMessage(item.message),
  );
}

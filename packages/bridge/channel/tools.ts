/**
 * channel/tools.ts — the four LLM tool registrations (god-file split 5/5,
 * 2026-10-20): send-file, todo, sleep, task.
 *
 * Extracted from channel/index.ts. Pure move — code is verbatim from
 * index.ts; only import/export boundaries were added. The delivery
 * paths (deliverDueWakes / deliverDueTasks) stay in index.ts: they are
 * session wiring, not tool registration.
 */
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { channelError } from "./commands";
import {
  deleteDiscordMessage,
  editDiscordMessage,
  getDiscordChannelId,
  getDiscordToken,
  sendDiscordMessage,
  sendFilesToDiscord,
} from "./discord";
import { lastActiveChannel } from "./index";
import { sanitizeSensitiveText, sanitizeUnknownValue } from "./sanitize";
import { parseWakeAt, scheduleWake } from "./sleep";
import { parseTaskSpec, scheduleTask } from "./tasks";
import {
  loadBoard,
  renderBoard,
  sanitizeTodos,
  saveBoard,
  type TodoBoard,
} from "./todos";
import { type ChannelConfig, getDefaultChannel } from "./types";
// ─── send-file tool ────────────────────────────────────────────────
// Uploads local file(s) to the active Discord channel in one message
// (multipart upload, 25 MB per-file cap). Replaces the webdrop round-trip
// for anything small.

export function registerSendFileTool(
  pi: ExtensionAPI,
  channels: ChannelConfig[],
): void {
  pi.registerTool({
    name: "send-file",
    label: "Send file",
    description:
      "Send file(s) from this machine to the active Discord channel. Use it when the user should receive an image, report, log, or any file. Files up to 25 MB each; all files are sent in one message (images shown in a grid).",
    promptSnippet: "Send local file(s) to the active Discord channel",
    promptGuidelines: [
      "Use send-file to deliver files to the user instead of pasting long paths or webdrop links.",
    ],
    parameters: Type.Object({
      files: Type.Array(Type.String(), {
        minItems: 1,
        description:
          "File paths (absolute, or relative to the working directory)",
      }),
    }),
    async execute(
      _toolCallId,
      params: { files: string[] },
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const active =
        lastActiveChannel && lastActiveChannel.type === "discord"
          ? lastActiveChannel
          : null;
      const ch = active || getDefaultChannel(channels);
      if (ch?.type !== "discord") {
        return {
          content: [{ type: "text", text: "No Discord channel available" }],
          details: {},
        };
      }
      const token = getDiscordToken(ch.id) || ch.botToken;
      const channelId = getDiscordChannelId(ch.id);
      if (!token || !channelId) {
        return {
          content: [
            {
              type: "text",
              text: `Channel ${ch.name}: no bot token/channel id`,
            },
          ],
          details: {},
        };
      }
      // Some models prefix paths with @ — normalize it.
      const files = params.files.map((f) =>
        path.resolve(ctx.cwd, f.replace(/^@/, "")),
      );
      const r = await sendFilesToDiscord(channelId, files, token);
      if (r.success) {
        return {
          content: [
            {
              type: "text",
              text: `Sent ${files.length} file(s) to ${ch.name}`,
            },
          ],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: r.error || "send failed" }],
        details: {},
      };
    },
  });
}

// ─── todo tool ─────────────────────────────────────────────────────────
// Maintains the per-channel todo board. FULL-LIST semantics: the model
// always sends the complete updated list; an empty array clears the
// board. State: ~/.pi/agent/todos/<channelId>.json. The Discord board
// message is posted once, then edited in place; board send/edit failures
// never fail the tool call (state is the source of truth).
// Description text is opencode's proven todo prompt.
export const TODO_TOOL_DESCRIPTION = `Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.
## When to use
Use proactively when:
- The task requires 3+ distinct steps or actions (not just 3 tool calls for a single conceptual step)
- The work is non-trivial and benefits from planning
- The user provides multiple tasks (numbered or comma-separated) or explicitly asks for a todo list
- New instructions arrive - capture them as todos
- You start a task - mark it in_progress (only one at a time) before working
- You finish a task - mark it completed and add any follow-ups discovered during the work
## When NOT to use
Skip when:
- The work is a single, straightforward task (or <3 trivial steps)
- The request is purely informational or conversational
- Tracking adds no organizational value
## States
- pending - not started
- in_progress - actively working (exactly ONE at a time)
- completed - finished successfully
- cancelled - no longer needed
## Rules
- Update status in real time; do not batch completions
- Mark completed only after the required work is actually done, including any required verification. Never based on intent
- Keep exactly one in_progress while work remains
- If blocked or partial, keep it in_progress and add a follow-up todo describing the blocker
- Preserve user-provided commands verbatim (flags, args, order)
- Items should be specific and actionable; break large work into smaller steps
When in doubt, use it.`;

/**
 * Post or edit the channel's Discord todo board message. Never throws:
 * a failed post/edit is logged, and the state file remains authoritative
 * (the next sync retries, or re-posts when the message id was lost).
 * Exported for tests.
 */
export async function syncTodoBoard(
  ch: ChannelConfig,
  board: TodoBoard,
): Promise<void> {
  try {
    if (board.todos.length === 0) {
      if (board.boardMessageId) {
        await deleteDiscordMessage(ch, board.boardMessageId);
        board.boardMessageId = undefined;
        saveBoard(board);
      }
      return;
    }
    const text = renderBoard(board.todos);
    if (board.boardMessageId) {
      const r = await editDiscordMessage(ch, board.boardMessageId, text);
      if (!r.success)
        console.error(
          `[todos] board edit failed: ${sanitizeSensitiveText(r.error || "")}`,
        );
      return;
    }
    const r = await sendDiscordMessage(ch, text);
    if (r.success && r.messageId) {
      board.boardMessageId = r.messageId;
      saveBoard(board);
    } else {
      // Webhook-only channels return no message id — the next sync re-posts.
      console.error(
        `[todos] board post failed: ${sanitizeSensitiveText(r.error || "")}`,
      );
    }
  } catch (e) {
    console.error(`[todos] board sync failed: ${sanitizeUnknownValue(e)}`);
  }
}

export function registerTodoTool(
  pi: ExtensionAPI,
  channels: ChannelConfig[],
): void {
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: TODO_TOOL_DESCRIPTION,
    promptSnippet:
      "Maintain the channel todo board (send the FULL updated list every time)",
    promptGuidelines: [
      "Call todo with the complete updated list whenever a task's status changes; empty list clears the board.",
    ],
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({
            description: "What to do (specific and actionable)",
          }),
          status: Type.Union(
            [
              Type.Literal("pending"),
              Type.Literal("in_progress"),
              Type.Literal("completed"),
              Type.Literal("cancelled"),
            ],
            { description: "Item status" },
          ),
        }),
        {
          maxItems: 50,
          description:
            "The COMPLETE updated list (empty array clears the board)",
        },
      ),
    }),
    async execute(
      _toolCallId,
      params: { todos: any[] },
      _signal,
      _onUpdate,
      _ctx: ExtensionContext,
    ) {
      const active =
        lastActiveChannel && lastActiveChannel.type === "discord"
          ? lastActiveChannel
          : null;
      const ch = active || getDefaultChannel(channels);
      if (ch?.type !== "discord") {
        return {
          content: [{ type: "text", text: "No Discord channel available" }],
          details: {},
        };
      }
      const todos = sanitizeTodos(params.todos);
      const prev = loadBoard(ch.id);
      const board: TodoBoard = {
        channelId: ch.id,
        todos,
        updatedAt: new Date().toISOString(),
        ...(prev?.boardMessageId
          ? { boardMessageId: prev.boardMessageId }
          : {}),
      };
      let stateNote = "";
      try {
        saveBoard(board);
      } catch (e) {
        // State write failed — report it but still echo the list so the
        // model keeps its copy.
        stateNote = `\n\n[!] board save failed: ${channelError(e) ?? "error"}`;
      }
      await syncTodoBoard(ch, board);
      const text =
        todos.length === 0 ? "todo board cleared" : renderBoard(todos);
      return {
        content: [{ type: "text", text: text + stateNote }],
        details: {},
      };
    },
  });
}

// ─── sleep tool ───────────────────────────────────────────────────────────
// Durable "wake me at X": records the wake on disk, tells the model to end
// the run. Delivery is external (session_start catch-up + 30s poller) so it
// survives pi.service restarts and machine reboots. The wake lands as a
// fresh channel-inbound turn in the same session.
export const SLEEP_TOOL_DESCRIPTION = `Pause this session and wake it at a later time. Schedule a wake (minutes from now, or an ISO time), optionally with a note for your waking self, then END YOUR REPLY IMMEDIATELY — the run ends now and a "Woke after sleeping until ..." message starts the next turn in this same session. Use it to sleep until a known time (deploy window closes, meeting ends, CI should be done) instead of polling. The wake survives process restarts.`;

export function registerSleepTool(
  pi: ExtensionAPI,
  channels: ChannelConfig[],
): void {
  pi.registerTool({
    name: "sleep",
    label: "Sleep",
    description: SLEEP_TOOL_DESCRIPTION,
    promptSnippet:
      "Pause the session and wake it at a later time (minutes or ISO until, optional note)",
    promptGuidelines: [
      "After calling sleep, end the reply immediately — do not keep working or poll; the wake arrives as a new message in this session.",
    ],
    parameters: Type.Object({
      minutes: Type.Optional(
        Type.Union([Type.Number(), Type.String()], {
          description: "Sleep length in minutes (e.g. 30)",
        }),
      ),
      until: Type.Optional(
        Type.String({
          description:
            "Wake time as ISO timestamp, e.g. 2026-09-10T15:00:00Z (exactly one of minutes/until)",
        }),
      ),
      note: Type.Optional(
        Type.String({
          description: "Optional note stored and shown back at wake time",
        }),
      ),
    }),
    async execute(
      _toolCallId,
      params: { minutes?: number | string; until?: string; note?: string },
      _signal,
      _onUpdate,
      _ctx: ExtensionContext,
    ) {
      const active =
        lastActiveChannel && lastActiveChannel.type === "discord"
          ? lastActiveChannel
          : null;
      const ch = active || getDefaultChannel(channels);
      if (ch?.type !== "discord") {
        return {
          content: [{ type: "text", text: "No Discord channel available" }],
          details: {},
        };
      }
      const res = parseWakeAt(params);
      if (res.error !== undefined || res.wakeAt === undefined) {
        return {
          content: [
            { type: "text", text: `[!] ${res.error ?? "invalid wake time"}` },
          ],
          details: {},
        };
      }
      const wake = scheduleWake({
        channelId: ch.id,
        channelName: ch.name,
        wakeAt: res.wakeAt,
        note: params.note,
      });
      const text = `[ok] sleeping until ${new Date(wake.wakeAt).toISOString()} (id ${wake.id}). End your reply now; this session wakes at that time.`;
      return { content: [{ type: "text", text }], details: { wake } };
    },
  });
}

// ─── task tool ───────────────────────────────────────────────────────────
// Durable "fire this prompt into this session at a later time": one-shot
// (minutes from now, or an ISO time) or recurring (5-field cron, optional
// IANA tz). Delivery is external (session_start catch-up + 30s poller) so
// it survives pi.service restarts and machine reboots. The fire lands as a
// fresh channel-inbound turn in the same session.
export const TASK_TOOL_DESCRIPTION = `Schedule a prompt that fires into THIS session as a new message at a later time. One-shot: minutes from now or an ISO time (e.g. "remind me in 2h to check the build"). Recurring: a 5-field cron expression (e.g. "daily 06:00 run the fleet check" = "0 6 * * *"), optional IANA timezone. The fire arrives as a normal channel message in this same session — a fresh turn for your future self. It survives process restarts and reboots. After scheduling, do not wait or poll; the fire is its own message.`;

export function registerTaskTool(
  pi: ExtensionAPI,
  channels: ChannelConfig[],
): void {
  pi.registerTool({
    name: "task",
    label: "Task",
    description: TASK_TOOL_DESCRIPTION,
    promptSnippet:
      "Schedule a prompt to fire into this session later (one-shot minutes/ISO, or recurring cron)",
    promptGuidelines: [
      "Write the prompt for your future self: self-contained, no 'this' or 'it'.",
      "After calling task, keep working or end the reply — the fire arrives as its own message later.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "The message to deliver when the task fires (self-contained instruction)",
      }),
      minutes: Type.Optional(
        Type.Union([Type.Number(), Type.String()], {
          description:
            "One-shot: fire N minutes from now (e.g. 120) — exactly one of minutes/at/cron",
        }),
      ),
      at: Type.Optional(
        Type.String({
          description:
            "One-shot: fire time as ISO timestamp, e.g. 2026-09-10T15:00:00Z (exactly one of minutes/at/cron)",
        }),
      ),
      cron: Type.Optional(
        Type.String({
          description:
            "Recurring: 5-field cron (minute hour dom month dow), e.g. '0 6 * * *' = daily 06:00 — exactly one of minutes/at/cron",
        }),
      ),
      tz: Type.Optional(
        Type.String({
          description:
            "IANA timezone for the cron expression (e.g. Australia/Melbourne); default system tz",
        }),
      ),
    }),
    async execute(
      _toolCallId,
      params: {
        prompt?: string;
        minutes?: number | string;
        at?: string;
        cron?: string;
        tz?: string;
      },
      _signal,
      _onUpdate,
      _ctx: ExtensionContext,
    ) {
      const active =
        lastActiveChannel && lastActiveChannel.type === "discord"
          ? lastActiveChannel
          : null;
      const ch = active || getDefaultChannel(channels);
      if (ch?.type !== "discord") {
        return {
          content: [{ type: "text", text: "No Discord channel available" }],
          details: {},
        };
      }
      const res = parseTaskSpec(params);
      if (res.error !== undefined || res.spec === undefined) {
        return {
          content: [
            { type: "text", text: `[!] ${res.error ?? "invalid task spec"}` },
          ],
          details: {},
        };
      }
      const task = scheduleTask({
        channelId: ch.id,
        channelName: ch.name,
        prompt: params.prompt!.trim(),
        spec: res.spec,
      });
      const when =
        task.kind === "cron"
          ? `cron "${task.cron}"${task.tz ? ` (${task.tz})` : " (system tz)"}`
          : `at ${new Date(task.atMs!).toISOString()}`;
      const text =
        `[ok] task ${task.id} scheduled: ${when}, next fire ${new Date(task.nextFireAt).toISOString()} — ` +
        `it arrives as a message in this channel. Cancel with /tasks cancel ${task.id}.`;
      return { content: [{ type: "text", text }], details: { task } };
    },
  });
}

import { describe, expect, test } from "bun:test";
import { extractQueueSuffix } from "./queue";

describe("extractQueueSuffix", () => {
  test("dot + space + queue at end", () => {
    expect(extractQueueSuffix("fix the bug. queue")).toEqual({
      prompt: "fix the bug",
      forceQueue: true,
    });
  });

  test("no space: '.queue'", () => {
    expect(extractQueueSuffix("fix the bug.queue")).toEqual({
      prompt: "fix the bug",
      forceQueue: true,
    });
  });

  test("punctuation run: '... queue'", () => {
    expect(extractQueueSuffix("fix the bug... queue")).toEqual({
      prompt: "fix the bug",
      forceQueue: true,
    });
  });

  test("trailing spaces are fine", () => {
    expect(extractQueueSuffix("fix the bug. queue   ")).toEqual({
      prompt: "fix the bug",
      forceQueue: true,
    });
  });

  test("other sentence punctuation: ! ; :", () => {
    for (const p of ["!", ";", ":"]) {
      expect(extractQueueSuffix(`fix the bug${p} queue`)).toEqual({
        prompt: "fix the bug",
        forceQueue: true,
      });
    }
  });

  test("optional trailing period after queue", () => {
    expect(extractQueueSuffix("fix the bug. queue.")).toEqual({
      prompt: "fix the bug",
      forceQueue: true,
    });
  });

  test("case-insensitive", () => {
    expect(extractQueueSuffix("fix the bug. QUEUE")).toEqual({
      prompt: "fix the bug",
      forceQueue: true,
    });
  });

  test("suffixed-only message strips to empty", () => {
    expect(extractQueueSuffix(". queue")).toEqual({
      prompt: "",
      forceQueue: true,
    });
  });

  test("mid-sentence 'queue' does NOT match", () => {
    expect(extractQueueSuffix("put it in the queue")).toEqual({
      prompt: "put it in the queue",
      forceQueue: false,
    });
  });

  test("'queue' alone does NOT match (no punctuation)", () => {
    expect(extractQueueSuffix("queue")).toEqual({
      prompt: "queue",
      forceQueue: false,
    });
  });

  test("comma before queue does NOT match (list, ambiguous)", () => {
    expect(extractQueueSuffix("buy eggs, queue")).toEqual({
      prompt: "buy eggs, queue",
      forceQueue: false,
    });
  });

  test("similar words do NOT match", () => {
    expect(extractQueueSuffix("do this. queued")).toEqual({
      prompt: "do this. queued",
      forceQueue: false,
    });
    expect(extractQueueSuffix("do this. queueing")).toEqual({
      prompt: "do this. queueing",
      forceQueue: false,
    });
  });

  test("queue in the middle, other text after", () => {
    expect(extractQueueSuffix(". queue it up")).toEqual({
      prompt: ". queue it up",
      forceQueue: false,
    });
  });

  test("no suffix: unchanged", () => {
    expect(extractQueueSuffix("fix the bug please")).toEqual({
      prompt: "fix the bug please",
      forceQueue: false,
    });
  });
});

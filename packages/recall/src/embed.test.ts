// embed.ts unit tests (audit F6): the OpenAI-compatible /v1/embeddings
// contract — batched fetch, per-batch index re-sort, error paths.
// global fetch is stubbed per test.

import { afterAll, describe, expect, mock, test } from "bun:test";
import { embed, embedBatched } from "./embed";

const OPTS = {
  url: "http://127.0.0.1:11434/v1/embeddings",
  model: "test-model",
  timeoutMs: 5_000,
};

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

// one embedding per input text, values carry the batch size + position so
// a re-sort bug (wrong batch, wrong order) is visible in the result
function jsonFetch() {
  return mock(async (_url: unknown, init?: unknown) => {
    const body = JSON.parse((init as RequestInit).body as string) as {
      input: string[];
    };
    const data = body.input
      .map((_, i) => ({ index: i, embedding: [body.input.length, i] }))
      .reverse(); // arrive out of order; the port must re-sort by index
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("embedBatched", () => {
  test("re-sorts by index within each batch; 13 texts -> 2 batches (default 12)", async () => {
    globalThis.fetch = jsonFetch();
    const texts = Array.from({ length: 13 }, (_, i) => `text ${i}`);
    const starts: number[] = [];
    const out = await embedBatched(OPTS, texts, (start) => {
      starts.push(start);
    });
    expect(starts).toEqual([0, 12]);
    // batch 1: 12 texts -> [12, i]; batch 2: 1 text -> [1, 0]
    expect(out).toEqual([
      ...Array.from({ length: 12 }, (_, i) => [12, i]),
      [1, 0],
    ]);
  });

  test("HTTP !ok -> error carries status + body", async () => {
    globalThis.fetch = mock(
      async () => new Response("bad gateway", { status: 502 }),
    ) as unknown as typeof fetch;
    let err: unknown;
    try {
      await embedBatched(OPTS, ["hello"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("embed HTTP 502");
    expect((err as Error).message).toContain("bad gateway");
  });
});

describe("embed", () => {
  test("single text -> one vector", async () => {
    globalThis.fetch = jsonFetch();
    const v = await embed(OPTS, "hello");
    expect(v).toEqual([1, 0]);
  });

  test("no embedding returned -> error", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ) as unknown as typeof fetch;
    let err: unknown;
    try {
      await embed(OPTS, "hello");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("embed: no embedding returned");
  });
});

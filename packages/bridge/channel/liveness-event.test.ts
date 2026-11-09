// liveness-event.test.ts — hall-monitor#757 leg B: the fire-and-forget
// liveness event POST. Hermetic: the HTTP leg is injected
// (setLivenessHttp) so no test touches the live hall-monitor API; the
// key-file seam is pinned (JARATE_INBOX_KEY_FILE) so a real on-box key
// file is never read.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveAgentName,
  resolveLivenessTarget,
  sendLivenessEvent,
  setLivenessHttp,
} from "./liveness-event";

const ENV = [
  "JARATE_INBOX_URL",
  "JARATE_INBOX_KEY",
  "JARATE_INBOX_AGENT",
  "JARATE_INBOX_KEY_FILE",
] as const;

const savedEnv = new Map<string, string | undefined>();

function armEnv(over: Partial<Record<(typeof ENV)[number], string>>): void {
  for (const k of ENV) {
    if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) process.env[k] = v;
  }
  // pin the key-file seam: never read a real on-box file
  if (process.env.JARATE_INBOX_KEY_FILE === undefined)
    process.env.JARATE_INBOX_KEY_FILE = "/nonexistent/jarate-test-agent-key";
}

function disarmEnv(): void {
  for (const k of ENV) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    savedEnv.delete(k);
  }
}

// fake liveness event POST: a queue of (status|Error) results per call
function flake(results: Array<number | Error>): {
  calls: Array<{
    url: string;
    init: RequestInit;
  }>;
  impl: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<{ ok: boolean; status: number }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<{ ok: boolean; status: number }> =>
    (async () => {
      const r = results.shift();
      calls.push({ url: String(url), init: init ?? {} });
      if (r instanceof Error) throw r;
      const status = r ?? 200;
      return { ok: status >= 200 && status < 300, status };
    })();
  return { calls, impl };
}

beforeEach(() => {
  disarmEnv();
});

afterEach(() => {
  setLivenessHttp(null);
  disarmEnv();
});

describe("resolveLivenessTarget (hall-monitor#757 leg B)", () => {
  test("env url + env key + env agent = resolved", () => {
    armEnv({
      JARATE_INBOX_URL: "http://hm.example/api",
      JARATE_INBOX_KEY: "k1",
      JARATE_INBOX_AGENT: "agent1",
    });
    expect(resolveLivenessTarget()).toEqual({
      base: "http://hm.example/api",
      key: "k1",
      agent: "agent1",
    });
  });

  test("trailing slashes on the base are stripped", () => {
    armEnv({
      JARATE_INBOX_URL: "http://hm.example/api///",
      JARATE_INBOX_KEY: "k1",
      JARATE_INBOX_AGENT: "agent1",
    });
    expect(resolveLivenessTarget()?.base).toBe("http://hm.example/api");
  });

  test("key falls back to the key file (the X_AGENT_KEY= line wins)", () => {
    const f = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "jarate-liv-")),
      "agent-key",
    );
    fs.writeFileSync(f, "# comment\nX_AGENT_KEY=filekey\nhm_agent_fileagent\n");
    armEnv({
      JARATE_INBOX_URL: "http://hm.example/api",
      JARATE_INBOX_KEY_FILE: f,
      JARATE_INBOX_AGENT: "agent1",
    });
    expect(resolveLivenessTarget()?.key).toBe("filekey");
  });

  test("no url = null (feature off)", () => {
    armEnv({ JARATE_INBOX_KEY: "k1" });
    expect(resolveLivenessTarget()).toBeNull();
  });

  test("no key (env empty + file missing) = null (feature off)", () => {
    armEnv({ JARATE_INBOX_URL: "http://hm.example/api" });
    expect(resolveLivenessTarget()).toBeNull();
  });
});

describe("resolveAgentName (hall-monitor#757 leg B)", () => {
  test("the env name wins", () => {
    armEnv({ JARATE_INBOX_AGENT: "agent1" });
    expect(resolveAgentName()).toBe("agent1");
  });

  test("env unset: the key file's hm_agent_ line", () => {
    const f = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "jarate-liv-")),
      "agent-key",
    );
    fs.writeFileSync(f, "somekey\nhm_agent_fileagent\n");
    armEnv({ JARATE_INBOX_KEY_FILE: f });
    expect(resolveAgentName()).toBe("fileagent");
  });

  test("env unset + no key file: the process's unix user", () => {
    armEnv({});
    expect(resolveAgentName()).toBe(os.userInfo().username);
  });
});

describe("sendLivenessEvent (hall-monitor#757 leg B: fire-and-forget, log-only)", () => {
  test("2xx = true; POST <base>/fleet/liveness/event with X-Agent-Key + {agent, event, detail}", async () => {
    armEnv({
      JARATE_INBOX_URL: "http://hm.example/api",
      JARATE_INBOX_KEY: "k1",
      JARATE_INBOX_AGENT: "agent1",
    });
    const fl = flake([200]);
    setLivenessHttp(fl.impl);
    await expect(
      sendLivenessEvent("back_online", "restart-wake \u00b7 unplanned"),
    ).resolves.toBe(true);
    expect(fl.calls).toHaveLength(1);
    expect(fl.calls[0].url).toBe("http://hm.example/api/fleet/liveness/event");
    expect(fl.calls[0].init.method).toBe("POST");
    const headers = fl.calls[0].init.headers as Record<string, string>;
    expect(headers["X-Agent-Key"]).toBe("k1");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(fl.calls[0].init.body));
    expect(body).toEqual({
      agent: "agent1",
      event: "back_online",
      detail: "restart-wake \u00b7 unplanned",
    });
  });

  test("session_start event shape (the handover self-check leg)", async () => {
    armEnv({
      JARATE_INBOX_URL: "http://hm.example/api",
      JARATE_INBOX_KEY: "k1",
      JARATE_INBOX_AGENT: "agent1",
    });
    const fl = flake([200]);
    setLivenessHttp(fl.impl);
    await sendLivenessEvent("session_start", "session start: the flag line");
    const body = JSON.parse(String(fl.calls[0].init.body));
    expect(body.event).toBe("session_start");
  });

  test("5xx = false (log-only, never throws)", async () => {
    armEnv({
      JARATE_INBOX_URL: "http://hm.example/api",
      JARATE_INBOX_KEY: "k1",
      JARATE_INBOX_AGENT: "agent1",
    });
    const fl = flake([500]);
    setLivenessHttp(fl.impl);
    await expect(sendLivenessEvent("online", "d")).resolves.toBe(false);
    expect(fl.calls).toHaveLength(1);
  });

  test("network failure = false (log-only, never throws)", async () => {
    armEnv({
      JARATE_INBOX_URL: "http://hm.example/api",
      JARATE_INBOX_KEY: "k1",
      JARATE_INBOX_AGENT: "agent1",
    });
    const fl = flake([new Error("network down")]);
    setLivenessHttp(fl.impl);
    await expect(sendLivenessEvent("online", "d")).resolves.toBe(false);
  });

  test("config unset = false with ZERO event calls (one local log line)", async () => {
    armEnv({});
    const fl = flake([200]);
    setLivenessHttp(fl.impl);
    await expect(sendLivenessEvent("online", "d")).resolves.toBe(false);
    expect(fl.calls).toHaveLength(0);
  });
});

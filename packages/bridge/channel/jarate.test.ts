// jarate tool — spawn + JSON discipline. Stub $HOME/bin/jarate per test.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jarateText, registerJarateTool, runJarate } from "./jarate";

function makeJarateHome(script: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-tool-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const jarate = path.join(bin, "jarate");
  fs.writeFileSync(jarate, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(jarate, 0o755);
  return tmp;
}

const envFor = (home: string) =>
  ({ ...process.env, HOME: home }) as NodeJS.ProcessEnv;

describe("runJarate", () => {
  test("spawns $HOME/bin/jarate with cmd + args, keeps stdout", async () => {
    const home = makeJarateHome(
      'printf \'{"ok":true,"cmd":"%s","args":"%s"}\' "$1" "$2"',
    );
    const r = await runJarate("ctx-report", "--profile main", envFor(home));
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    const d = JSON.parse(r.out);
    expect(d.ok).toBe(true);
    expect(d.cmd).toBe("ctx-report");
    expect(d.args).toBe("--profile main");
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("non-zero exit keeps the entrypoint JSON error doc", async () => {
    const home = makeJarateHome(
      'printf \'{"ok":false,"error":"boom"}\'; exit 3',
    );
    const r = await runJarate("ctx-report", "", envFor(home));
    expect(r.code).toBe(3);
    const t = jarateText(r);
    expect(t).toContain('"ok":false');
    expect(t).toContain("boom");
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("non-zero exit without JSON -> synthesized ok:false", async () => {
    const home = makeJarateHome("echo oops; exit 2");
    const r = await runJarate("ctx-report", "", envFor(home));
    const d = JSON.parse(jarateText(r));
    expect(d.ok).toBe(false);
    expect(d.error).toContain("exited 2");
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("missing entrypoint -> spawn failed ok:false", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-tool-"));
    const r = await runJarate("ctx-report", "", envFor(home));
    const d = JSON.parse(jarateText(r));
    expect(d.ok).toBe(false);
    expect(d.error).toContain("spawn failed");
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("timeout -> ok:false timed out", async () => {
    const home = makeJarateHome("sleep 5");
    const old = process.env.JARATE_TOOL_TIMEOUT_MS;
    process.env.JARATE_TOOL_TIMEOUT_MS = "300";
    try {
      const r = await runJarate("rag", "sleep", envFor(home));
      expect(r.timedOut).toBe(true);
      const d = JSON.parse(jarateText(r));
      expect(d.ok).toBe(false);
      expect(d.error).toContain("timed out");
    } finally {
      if (old === undefined) delete process.env.JARATE_TOOL_TIMEOUT_MS;
      else process.env.JARATE_TOOL_TIMEOUT_MS = old;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("registerJarateTool", () => {
  test("registers one tool; execute returns the JSON doc as text", async () => {
    const home = makeJarateHome('printf \'{"ok":true,"cmd":"%s"}\' "$1"');
    const tools: Record<string, any> = {};
    const pi = {
      registerTool: (t: any) => {
        tools[t.name] = t;
      },
    } as any;
    registerJarateTool(pi);
    expect(Object.keys(tools)).toEqual(["jarate"]);
    // subcommands are discoverable from the description
    for (const cmd of ["ctx-report", "journal-errors", "memory-grep", "rag"]) {
      expect(tools.jarate.description).toContain(cmd);
    }
    expect(tools.jarate.parameters.properties.cmd).toBeDefined();

    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const res = await tools.jarate.execute(
        "t1",
        { cmd: "ctx-report", args: "" },
        undefined,
        undefined,
        { cwd: home },
      );
      const d = JSON.parse(res.content[0].text);
      expect(d.ok).toBe(true);
      expect(d.cmd).toBe("ctx-report");
    } finally {
      process.env.HOME = realHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

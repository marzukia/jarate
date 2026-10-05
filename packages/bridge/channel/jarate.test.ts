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

// Stub jarate that echoes back the argv it received, '|' separated, so the
// test asserts the exact word split the bridge performed (#148).
const argvStub =
  's=""; for a in "$@"; do if [ -n "$s" ]; then s="$s|$a"; else s="$a"; fi; done; printf \'{"ok":true,"argv":"%s"}\' "$s"';

describe("runJarate", () => {
  test("spawns $HOME/bin/jarate with cmd + shellWords(args) as separate argv (#148)", async () => {
    const home = makeJarateHome(argvStub);
    const r = await runJarate(
      "journal-errors",
      "--since 2026-10-05T00:00:00Z",
      {
        env: envFor(home),
      },
    );
    expect(r.code).toBe(0);
    const d = JSON.parse(r.out);
    expect(d.ok).toBe(true);
    expect(d.argv).toBe("journal-errors|--since|2026-10-05T00:00:00Z");
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("--flag=value stays one word (CLI desugars it itself)", async () => {
    const home = makeJarateHome(argvStub);
    const r = await runJarate(
      "journal-errors",
      "--since=2026-10-05T00:00:00Z",
      {
        env: envFor(home),
      },
    );
    const d = JSON.parse(r.out);
    expect(d.argv).toBe("journal-errors|--since=2026-10-05T00:00:00Z");
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("quoted two-word value -> ONE argv word (CLI re-joins it)", async () => {
    const home = makeJarateHome(argvStub);
    const r = await runJarate(
      "journal-errors",
      '--since "2026-10-05 00:00:00"',
      {
        env: envFor(home),
      },
    );
    const d = JSON.parse(r.out);
    expect(d.argv).toBe("journal-errors|--since|2026-10-05 00:00:00");
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("unquoted two-word value -> three argv words (CLI re-joins it)", async () => {
    const home = makeJarateHome(argvStub);
    const r = await runJarate("journal-errors", "--since 2026-10-05 00:00:00", {
      env: envFor(home),
    });
    const d = JSON.parse(r.out);
    expect(d.argv).toBe("journal-errors|--since|2026-10-05|00:00:00");
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("empty / whitespace-only args -> no extra argv words", async () => {
    const home = makeJarateHome(argvStub);
    for (const args of ["", "   "]) {
      const r = await runJarate("ctx-report", args, { env: envFor(home) });
      const d = JSON.parse(r.out);
      expect(d.argv).toBe("ctx-report");
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("unbalanced quote -> executable JSON doc, no spawn", async () => {
    const home = makeJarateHome(`touch "$(dirname "$0")/spawned"; ${argvStub}`);
    const r = await runJarate(
      "journal-errors",
      '--since "2026-10-05 00:00:00',
      {
        env: envFor(home),
      },
    );
    const d = JSON.parse(jarateText(r));
    expect(d.ok).toBe(false);
    expect(d.error).toContain("jarate: args not parseable:");
    expect(d.error).toContain("unterminated double quote");
    expect(d.error).toContain('jarate journal-errors --since "<value>"');
    expect(fs.existsSync(path.join(home, "bin", "spawned"))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("memory-grep --root= is reachable (value flag, not swallowed)", async () => {
    const home = makeJarateHome(argvStub);
    const r = await runJarate("memory-grep", "--root=/tmp/somewhere needle", {
      env: envFor(home),
    });
    const d = JSON.parse(r.out);
    expect(d.argv).toBe("memory-grep|--root=/tmp/somewhere|needle");
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("non-zero exit keeps the entrypoint JSON error doc", async () => {
    const home = makeJarateHome(
      'printf \'{"ok":false,"error":"boom"}\'; exit 3',
    );
    const r = await runJarate("ctx-report", "", { env: envFor(home) });
    expect(r.code).toBe(3);
    const t = jarateText(r);
    expect(t).toContain('"ok":false');
    expect(t).toContain("boom");
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("non-zero exit without JSON -> synthesized ok:false", async () => {
    const home = makeJarateHome("echo oops; exit 2");
    const r = await runJarate("ctx-report", "", { env: envFor(home) });
    const d = JSON.parse(jarateText(r));
    expect(d.ok).toBe(false);
    expect(d.error).toContain("exited 2");
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("missing entrypoint -> spawn failed ok:false", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-tool-"));
    const r = await runJarate("ctx-report", "", { env: envFor(home) });
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
      const r = await runJarate("rag", "sleep", { env: envFor(home) });
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
    for (const cmd of [
      "ctx-report",
      "journal-errors",
      "memory-grep",
      "rag",
      "pat-request",
      "pat-run",
      "pat-status",
    ]) {
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

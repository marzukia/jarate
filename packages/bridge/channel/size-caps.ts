/**
 * #384 (op rule 2026-11-25): the deterministic re-injection size caps
 * derive from the max ctx set in pi — NOT fixed constants.
 *
 *   K_tokens = floor(contextWindow * 0.8 * 0.10)
 *   K_bytes  = K_tokens * 4
 *
 * Compaction hits at ~80% of the max ctx; each re-injected file must
 * stay at no more than 10% of that, and the bridge's token estimator
 * is 4 chars per token. contextWindow 262144 -> K_bytes = 83884.
 * The window is resolved AT RUNTIME from the model config the bridge
 * already reads for compaction (pi's ContextUsage.contextWindow, the
 * handoff gate / handover doc stats), so every agent's pi config gets
 * its proportional cap. The formula — not any window or cap number —
 * is the rule.
 *
 * Resolution chain (first hit wins):
 *   1. the explicit argument (tests, the buildHandover ctx usage)
 *   2. the runtime window registered by the bridge extension
 *      (setRuntimeContextWindow, from ctx.getContextUsage())
 *   3. ~/.pi/agent/models.json for the settings.json default model
 *   4. the pi default window (128k) — a fallback for unknown config,
 *      not a rule constant
 */
import fs from "node:fs";
import path from "node:path";

/** The compaction-point fraction of the max ctx (~80%). */
export const CAP_COMPACT_FRACTION = 0.8;
/** The max re-injected-file fraction of the compaction point (10%). */
export const CAP_REINJECT_FRACTION = 0.1;
/** The bridge's token estimator: chars per token. */
export const CAP_CHARS_PER_TOKEN = 4;
/** Fallback window when neither pi usage nor models.json carries one. */
export const FALLBACK_CONTEXT_WINDOW = 131_072;

/** K_bytes for a context window: floor(cw * 0.8 * 0.10) * 4. Null for a
 *  non-positive / non-finite window (the fallback cap stands). */
export function deriveCapBytes(contextWindow: number): number | null {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return (
    Math.floor(contextWindow * CAP_COMPACT_FRACTION * CAP_REINJECT_FRACTION) *
    CAP_CHARS_PER_TOKEN
  );
}

let runtimeContextWindow: number | null = null;

/** Register the live window (the bridge extension calls this from the
 *  compaction gate with ctx.getContextUsage().contextWindow). */
export function setRuntimeContextWindow(cw: number | null): void {
  runtimeContextWindow =
    cw != null && Number.isFinite(cw) && cw > 0 ? cw : null;
}

/** The context window for the default model in ~/.pi/agent/models.json
 *  (settings.json defaultProvider/defaultModel select it). Null when
 *  the files are missing or unparseable — never throws. */
export function modelsJsonContextWindow(home: string): number | null {
  try {
    let provider: string | null = null;
    let model: string | null = null;
    try {
      const s = JSON.parse(
        fs.readFileSync(
          path.join(home, ".pi", "agent", "settings.json"),
          "utf8",
        ),
      );
      provider =
        typeof s?.defaultProvider === "string" ? s.defaultProvider : null;
      model = typeof s?.defaultModel === "string" ? s.defaultModel : null;
    } catch {
      /* no settings: first model of the first provider */
    }
    const m = JSON.parse(
      fs.readFileSync(path.join(home, ".pi", "agent", "models.json"), "utf8"),
    );
    const provs = Object.entries(m?.providers ?? {}) as [string, any][];
    const firstHit = (): number | null => {
      const models = Array.isArray(provs[0]?.[1]?.models)
        ? provs[0][1].models
        : [];
      const hit =
        model == null ? models[0] : models.find((x: any) => x?.id === model);
      return hit && Number.isFinite(hit.contextWindow)
        ? (hit.contextWindow as number)
        : null;
    };
    for (const [key, p] of provs) {
      if (provider && key === provider) {
        const models = Array.isArray(p?.models) ? p.models : [];
        const hit =
          model == null ? models[0] : models.find((x: any) => x?.id === model);
        if (hit && Number.isFinite(hit.contextWindow))
          return hit.contextWindow as number;
        return null; // the settings provider is authoritative
      }
    }
    return firstHit();
  } catch {
    return null;
  }
}

export function resolveContextWindow(home: string): number | null {
  if (runtimeContextWindow != null) return runtimeContextWindow;
  return modelsJsonContextWindow(home);
}

/** The shared cap: K_bytes for the runtime context window (the op rule,
 *  2026-11-25). Explicit window > runtime registration > models.json >
 *  the pi default window. Never a hardcoded cap. */
export function compactionLoopCapBytes(
  contextWindow?: number | null,
  home = process.env.HOME ?? "",
): number {
  const cw = contextWindow ?? resolveContextWindow(home);
  const cap = deriveCapBytes(cw ?? FALLBACK_CONTEXT_WINDOW);
  return cap ?? deriveCapBytes(FALLBACK_CONTEXT_WINDOW)!;
}

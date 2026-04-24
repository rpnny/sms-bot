import { child } from "../logger.js";
import { env } from "../config.js";
import type { FilterResult, StrategyConfig } from "../types.js";

const log = child("filter");

export class SafetyFilter {
  constructor(private cfg: StrategyConfig) {}

  async evaluate(token: string): Promise<FilterResult> {
    const scores: FilterResult["scores"] = {};
    try {
      let report: RugReport | null = null;
      try {
        report = await withTimeout(
          fetchRugcheck(token),
          this.cfg.filter.timeoutMs,
          "rugcheck",
        );
      } catch (err) {
        // RugCheck timeout/unavailable — don't hard-reject in paper mode, let
        // the rest of the pipeline decide. Live mode would be stricter.
        log.warn({ err: (err as Error).message, token }, "rugcheck skipped");
        scores.rugcheck_score = null;
        scores.rugcheck_unavailable = true;
        if (env.runMode === "live") {
          return { passed: false, rejectReason: "rugcheck_unavailable", scores };
        }
        return { passed: true, scores };
      }
      if (!report) {
        scores.rugcheck_unavailable = true;
        if (env.runMode === "live") {
          return { passed: false, rejectReason: "rugcheck_unavailable", scores };
        }
        return { passed: true, scores };
      }

      scores.rugcheck_score = report.score ?? null;
      scores.rugcheck_risks = JSON.stringify(report.risks ?? []);
      scores.mint_authority = report.mintAuthority;
      scores.freeze_authority = report.freezeAuthority;
      scores.top_holders_pct = report.topHoldersPercent ?? null;
      scores.lp_locked = report.lpLocked;
      scores.liquidity_sol = report.liquiditySol ?? null;

      // RugCheck convention: HIGHER score = HIGHER risk. WSOL scores 1.
      if (report.score != null && report.score > this.cfg.filter.rugcheckMaxScore) {
        return { passed: false, rejectReason: `risky_score:${report.score}`, scores };
      }
      const dangerous = report.risks?.find(
        (r) => r.level === "danger" || /honeypot|high_risk/i.test(r.name),
      );
      if (dangerous) {
        return { passed: false, rejectReason: `risk:${dangerous.name}`, scores };
      }
      if (report.mintAuthority) {
        return { passed: false, rejectReason: "mint_authority_live", scores };
      }
      if (report.freezeAuthority) {
        return { passed: false, rejectReason: "freeze_authority_live", scores };
      }
      if (report.lpLocked === false) {
        return { passed: false, rejectReason: "lp_not_locked", scores };
      }
      if (
        report.liquiditySol != null &&
        report.liquiditySol < this.cfg.filter.minPoolLiquiditySol
      ) {
        return {
          passed: false,
          rejectReason: `low_liquidity:${report.liquiditySol.toFixed(2)}`,
          scores,
        };
      }
      if (
        report.topHoldersPercent != null &&
        report.topHoldersPercent > this.cfg.filter.maxTop10Percent
      ) {
        return {
          passed: false,
          rejectReason: `top_concentrated:${report.topHoldersPercent.toFixed(1)}`,
          scores,
        };
      }
      return { passed: true, scores };
    } catch (err) {
      log.warn({ err, token }, "filter error");
      if (env.runMode === "live") {
        return { passed: false, rejectReason: "filter_error", scores };
      }
      return { passed: true, scores };
    }
  }
}

interface RugReport {
  score: number | null;
  risks: Array<{ name: string; level: string }>;
  mintAuthority: boolean;
  freezeAuthority: boolean;
  topHoldersPercent: number | null;
  lpLocked: boolean | null;
  liquiditySol: number | null;
}

async function fetchRugcheck(token: string): Promise<RugReport | null> {
  const url = `${env.rugcheckBaseUrl}/tokens/${token}/report/summary`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      log.debug({ status: res.status, token }, "rugcheck non-200");
      return null;
    }
    const data = (await res.json()) as {
      score?: number;
      score_normalised?: number;
      risks?: Array<{ name: string; level: string }>;
    };
    const score = data.score_normalised ?? data.score ?? null;
    const risks = data.risks ?? [];
    return {
      score,
      risks,
      mintAuthority: risks.some((r) => /mint/i.test(r.name) && /enabled|authority/i.test(r.name)),
      freezeAuthority: risks.some((r) => /freeze/i.test(r.name)),
      topHoldersPercent: extractTopHolders(risks),
      lpLocked: !risks.some((r) => /lp.*unlocked|lp.*not.*locked/i.test(r.name)),
      liquiditySol: null,
    };
  } catch (err) {
    log.warn({ err, token }, "rugcheck fetch failed");
    return null;
  }
}

function extractTopHolders(risks: Array<{ name: string }>): number | null {
  for (const r of risks) {
    const m = r.name.match(/top\s*\d*\s*holders?.*?(\d+(?:\.\d+)?)/i);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms)),
  ]);
}

// Wire contract for `GET /api/unified/usage`.
//
// When OpenDesign runs inside the UnifiedApp desktop host, the daemon proxies
// the signed-in user's account usage from the UnifiedAI gateway
// (unified-api `GET /api/v1/usage`) using its broker token, and forwards the
// payload to the web client wrapped as `{ usage }`.
//
// These shapes intentionally mirror `@unifiedai/sdk`'s `UsageResponse` — the
// gateway is the source of truth. They are re-declared here (rather than
// imported from the SDK) so the pure web/daemon contract layer stays free of
// the SDK dependency, per packages/contracts boundary rules.

export interface UnifiedUsagePlan {
  id: number;
  name: string;
  /** Tokens allowed per `limit_period_seconds` (0 / negative ⇒ unmetered). */
  limit: number;
  limit_period_seconds: number;
  monthly_price: number | null;
  annual_price: number | null;
}

export interface UnifiedUsagePeriod {
  input_tokens: number;
  output_tokens: number;
  request_count: number;
  /** Estimated cost for the current billing period, in USD. */
  cost: number;
  started_at: string | null;
  /** ISO timestamp when the current period's counters reset. */
  resets_at: string;
  days_remaining: number | null;
}

export interface UnifiedUsageDaily {
  used: number;
  /** Daily cap (0 / negative ⇒ no daily limit). */
  limit: number;
  resets_at: string;
}

export interface UnifiedUsageCredits {
  balance: number;
}

export interface UnifiedUsage {
  plan: UnifiedUsagePlan;
  period: UnifiedUsagePeriod;
  daily: UnifiedUsageDaily;
  credits: UnifiedUsageCredits;
}

/** Response envelope for `GET /api/unified/usage`. */
export interface UnifiedUsageResponse {
  usage: UnifiedUsage;
}

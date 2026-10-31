import type { TemporalQuotaPolicy } from "./temporal-quota-policy.js";

/**
 * Provider-published quota pricing, normalized to quota-effect multipliers.
 *
 * Source (accessed 2026-10-30):
 * https://docs.z.ai/devpack/overview#usage-instruction
 *
 * "During off-peak hours, model usage is charged at 50% of the standard credit
 * rate." Peak hours: "Monday to Friday, 14:00-18:00 Singapore Standard Time
 * (UTC+8)." The current plan lists GLM-5.3 and GLM-5.3-Flash. Weekends fall
 * outside that weekday window and therefore remain off-peak all day.
 *
 * The 2026-07-30 "Plan Update Announcement"
 * (https://docs.z.ai/devpack/notice/usage-revision) publishes different values
 * under "Usage Reference for Legacy Plans > Legacy Plan V2" (GLM-5.3: 3x peak /
 * 1x off-peak; GLM-5.3-Flash: 1.2x peak / 0.4x off-peak). Those rates apply
 * only to discontinued Legacy Plan V2 subscriptions, not the current
 * credits-based plan, so they are deliberately not mixed into this policy.
 *
 * These factors are quota consumption, not monetary API prices. Keep them out
 * of the models.dev pricing snapshot: the plan can change independently.
 */
export const TEMPORAL_QUOTA_POLICIES: readonly TemporalQuotaPolicy[] = [
  {
    providerId: "zai",
    providerLabel: "Z.ai",
    aliases: ["zai-coding-plan", "glm"],
    source: "https://docs.z.ai/devpack/overview#usage-instruction",
    sourceAccessedAt: "2026-10-30",
    sourceLabel: "Z.ai current credits-plan usage",
    timeZone: "Asia/Singapore",
    utcOffsetMinutes: 480,
    peak: {
      days: ["mon", "tue", "wed", "thu", "fri"],
      start: "14:00",
      end: "18:00",
    },
    models: {
      "glm-5.3": { peakFactor: 1, offpeakFactor: 0.5 },
      "glm-5.3-flash": { peakFactor: 1, offpeakFactor: 0.5 },
    },
  },
];

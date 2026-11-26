import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSessionSnapshot } from "../src/contracts/dto-guards.js";
import { createUsageAnalytics, type UsageAnalyticsDataset } from "../src/gui/aggregation.js";
import { getRuntimeModelAliasEvidencePath } from "../src/lib/model-alias-evidence.js";
import type {
  OpenCodeProjectInfo,
  OpenCodeRawAssistantRow,
  OpenCodeSessionInfo,
} from "../src/lib/opencode-storage.js";
import { parseSessionSnapshot } from "../src/ui/dashboard-client.js";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const TEMP_ROOTS: string[] = [];

function assistantRow(
  messageID: string,
  createdAtMs: number,
  providerID: string,
  modelID: string,
  variant?: string,
  input = 10,
): OpenCodeRawAssistantRow {
  return {
    sessionID: "ses_root",
    messageID,
    createdAtMs,
    completedAtMs: createdAtMs + 1_000,
    providerID,
    modelID,
    ...(variant === undefined ? {} : { variant }),
    tokens: { input, output: 1, reasoning: 0, cacheRead: 2, cacheWrite: 0 },
  };
}

function makeDataset(messages: OpenCodeRawAssistantRow[]): UsageAnalyticsDataset {
  const sessions: Record<string, OpenCodeSessionInfo> = {
    ses_root: { id: "ses_root", projectID: "p_root", time: { created: NOW - 10_000 } },
  };
  const projects: Record<string, OpenCodeProjectInfo> = {
    p_root: { id: "p_root", directories: [], worktrees: [] },
  };
  return { sessions, projects, messages, compactions: [] };
}

async function writeSidecar(aliases: unknown): Promise<void> {
  const path = getRuntimeModelAliasEvidencePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 2, updatedAt: NOW, aliases }), "utf8");
}

function identityOf(
  snapshot: ReturnType<ReturnType<typeof createUsageAnalytics>["session"]>,
  modelId: string,
) {
  return snapshot.nodes[0]?.models.find((identity) => identity.modelId === modelId);
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-quota-alias-contract-"));
  TEMP_ROOTS.push(root);
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of TEMP_ROOTS.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("session model identity alias provenance", () => {
  it("attaches provenance to claude-agent aliases only and leaves math unchanged", () => {
    const snapshot = createUsageAnalytics(
      makeDataset([
        assistantRow("m1", NOW - 5_000, "claude-agent", "opus", "medium"),
        assistantRow("m2", NOW - 4_000, "claude-agent", "opus", "medium"),
        assistantRow("m3", NOW - 3_000, "claude-agent", "claude-opus-5-5"),
        assistantRow("m4", NOW - 2_000, "openai", "gpt-5"),
        assistantRow("m5", NOW - 1_000, "claude-agent", "fable"),
      ]),
    ).session("ses_root");

    const opus = identityOf(snapshot, "opus");
    expect(opus).toMatchObject({
      providerId: "claude-agent",
      modelId: "opus",
      effort: "medium",
      pricingAlias: {
        alias: "opus",
        state: "static-fallback",
        targetProviderId: "anthropic",
        targetModelId: "claude-opus-5-5",
      },
    });
    expect(identityOf(snapshot, "fable")?.pricingAlias).toEqual({
      alias: "fable",
      state: "unavailable",
      unavailableReason: "missing",
    });
    expect(identityOf(snapshot, "claude-opus-5-5")?.pricingAlias).toBeUndefined();
    expect(identityOf(snapshot, "gpt-5")?.pricingAlias).toBeUndefined();
    expect(snapshot.nodes[0]?.models).toHaveLength(4);

    // Same source identity/settings yield one cached provenance object per
    // build, not one evidence read per step.
    const opusSteps = snapshot.steps.filter((step) => step.model?.modelId === "opus");
    expect(opusSteps).toHaveLength(2);
    expect(opusSteps[0]?.model?.pricingAlias).toBe(opusSteps[1]?.model?.pricingAlias);
    expect(opusSteps[0]?.model?.pricingAlias).toBe(opus?.pricingAlias);

    expect(snapshot.nodes[0]?.stepCount).toBe(5);
    expect(snapshot.nodes[0]?.ownTokens.total).toBe(5 * 13);
    expect(snapshot.steps.map((step) => step.messageId)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("distinguishes a catalog target from last-confirmed evidence", async () => {
    await writeSidecar({
      opus: { name: "Opus 5.6", resolvedModelID: "claude-opus-5-6", catalogObserved: true },
      sonnet: { name: "Sonnet 5.6", resolvedModelID: "claude-sonnet-5-6", catalogObserved: false },
    });
    const snapshot = createUsageAnalytics(
      makeDataset([
        assistantRow("m1", NOW - 2_000, "claude-agent", "opus"),
        assistantRow("m2", NOW - 1_000, "claude-agent", "sonnet"),
      ]),
    ).session("ses_root");

    expect(identityOf(snapshot, "opus")?.pricingAlias).toEqual({
      alias: "opus",
      state: "catalog",
      targetProviderId: "anthropic",
      targetModelId: "claude-opus-5-6",
      targetName: "Opus 5.6",
    });
    expect(identityOf(snapshot, "sonnet")?.pricingAlias).toEqual({
      alias: "sonnet",
      state: "last-confirmed",
      targetProviderId: "anthropic",
      targetModelId: "claude-sonnet-5-6",
      targetName: "Sonnet 5.6",
    });
  });
});

describe("session snapshot contract with alias provenance", () => {
  const sessionSnapshot = () =>
    createUsageAnalytics(
      makeDataset([
        assistantRow("m1", NOW - 2_000, "claude-agent", "opus", "medium"),
        assistantRow("m2", NOW - 1_000, "openai", "gpt-5"),
      ]),
    ).session("ses_root");

  it("accepts and round-trips the optional field", () => {
    const snapshot = sessionSnapshot();
    expect(isSessionSnapshot(snapshot)).toBe(true);

    const wire = JSON.parse(JSON.stringify(snapshot));
    const parsed = parseSessionSnapshot(wire, "/api/v1/session/ses_root");
    expect(parsed.nodes[0]?.models.find((model) => model.modelId === "opus")?.pricingAlias).toEqual(
      {
        alias: "opus",
        state: "static-fallback",
        targetProviderId: "anthropic",
        targetModelId: "claude-opus-5-5",
      },
    );
    expect(
      parsed.nodes[0]?.models.find((model) => model.modelId === "gpt-5")?.pricingAlias,
    ).toBeUndefined();
  });

  it("keeps older payloads without the field working", () => {
    const wire = JSON.parse(JSON.stringify(sessionSnapshot()));
    for (const node of wire.nodes) {
      for (const model of node.models) delete model.pricingAlias;
    }
    for (const step of wire.steps) {
      if (step.model) delete step.model.pricingAlias;
    }
    expect(isSessionSnapshot(wire)).toBe(true);
    const parsed = parseSessionSnapshot(wire, "/api/v1/session/ses_root");
    expect(parsed.nodes[0]?.models.some((model) => "pricingAlias" in model)).toBe(false);
  });

  it("rejects an unknown provenance state", () => {
    const wire = JSON.parse(JSON.stringify(sessionSnapshot()));
    const opus = wire.nodes[0].models.find(
      (model: { modelId: string }) => model.modelId === "opus",
    );
    opus.pricingAlias.state = "guessed";
    expect(isSessionSnapshot(wire)).toBe(false);
  });
});

describe("alias pricing UI boundary", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

  it("keeps alias resolution and network access out of the tooltip components", () => {
    const uiFiles = [
      "src/ui/components/model-identity.tsx",
      "src/ui/components/model-alias-pricing.tsx",
      "src/native/model-identity.tsx",
    ];
    for (const file of uiFiles) {
      const source = read(file);
      for (const forbidden of [
        "CLAUDE_AGENT_PRICING_ALIASES",
        "model-alias-evidence",
        "modelsdev-pricing",
        "resolvePricingKey",
        "resolveAliasPricingProvenance",
        "listModelDisplayNames",
        "hasPricingNameCoverage",
        "claude-opus",
        "Claude Opus",
        "fetch(",
      ]) {
        expect(source, `${file} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }

    // Each surface wraps the shared body in its own Tooltip; neither imports
    // the other surface's tooltip.
    expect(read("src/ui/components/model-identity.tsx")).toContain('from "../opencode-ui"');
    expect(read("src/native/model-identity.tsx")).toContain('from "./ui"');
    expect(read("src/native/model-identity.tsx")).not.toContain("opencode-ui");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    resolveChutesApiKey: vi.fn(),
    resolveDeepSeekApiKey: vi.fn(),
    resolveSyntheticApiKey: vi.fn(),
    resolveNanoGptApiKey: vi.fn(),
    resolveKiloApiKey: vi.fn(),
    fetchWithTimeout: vi.fn(
      async (
        _url: string,
        options: {
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const response = await fetchResponse();
        return await options.consume(response, new AbortController().signal);
      },
    ),
  };
});

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

vi.mock("../src/lib/chutes-config.js", () => ({
  resolveChutesApiKey: mocks.resolveChutesApiKey,
  getChutesKeyDiagnostics: vi.fn(async () => ({
    configured: true,
    source: "env",
    checkedPaths: [],
  })),
  hasChutesApiKey: vi.fn(async () => true),
}));

vi.mock("../src/lib/deepseek-auth.js", () => ({
  resolveDeepSeekApiKey: mocks.resolveDeepSeekApiKey,
  getDeepSeekKeyDiagnostics: vi.fn(async () => ({
    configured: true,
    source: "env",
    checkedPaths: [],
    credentialDatabasePaths: [],
  })),
  hasDeepSeekApiKey: vi.fn(async () => true),
}));

vi.mock("../src/lib/synthetic-config.js", () => ({
  resolveSyntheticApiKey: mocks.resolveSyntheticApiKey,
  getSyntheticKeyDiagnostics: vi.fn(async () => ({
    configured: true,
    source: "env",
    checkedPaths: [],
  })),
  hasSyntheticApiKey: vi.fn(async () => true),
}));

vi.mock("../src/lib/nanogpt-config.js", () => ({
  resolveNanoGptApiKey: mocks.resolveNanoGptApiKey,
  getNanoGptKeyDiagnostics: vi.fn(async () => ({
    configured: true,
    source: "env",
    checkedPaths: [],
    credentialDatabasePaths: [],
  })),
  hasNanoGptApiKey: vi.fn(async () => true),
}));

vi.mock("../src/lib/kilo-config.js", () => ({
  resolveKiloApiKey: mocks.resolveKiloApiKey,
}));

import { queryChutesQuota } from "../src/lib/chutes.js";
import { queryDeepSeekBalance } from "../src/lib/deepseek.js";
import { queryKiloQuota } from "../src/lib/kilo.js";
import { queryNanoGptQuota } from "../src/lib/nanogpt.js";
import { querySyntheticQuota } from "../src/lib/synthetic.js";

function httpResponse(status: number, body = ""): Response {
  return new Response(body, { status });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveChutesApiKey.mockResolvedValue({ key: "chutes-key" });
  mocks.resolveDeepSeekApiKey.mockResolvedValue({ key: "deepseek-key" });
  mocks.resolveSyntheticApiKey.mockResolvedValue({ key: "synthetic-key" });
  mocks.resolveNanoGptApiKey.mockResolvedValue({ key: "nanogpt-key" });
  mocks.resolveKiloApiKey.mockResolvedValue({ key: "kilo-key" });
});

describe("Chutes request provenance", () => {
  it("labels 401 as credentials and other HTTP failures as provider API", async () => {
    mocks.fetchResponse.mockResolvedValueOnce(httpResponse(401, "unauthorized"));
    await expect(queryChutesQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "credentials",
    });

    mocks.fetchResponse.mockResolvedValueOnce(httpResponse(503, "unavailable"));
    await expect(queryChutesQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });
  });

  it("labels transport and invalid-response failures as provider API", async () => {
    mocks.fetchResponse.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(queryChutesQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });

    mocks.fetchResponse.mockResolvedValueOnce(httpResponse(200, "{"));
    await expect(queryChutesQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });

    mocks.fetchResponse.mockResolvedValueOnce(jsonResponse({}));
    await expect(queryChutesQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });
  });
});

describe("DeepSeek request provenance", () => {
  it("labels 401 as credentials and other HTTP failures as provider API", async () => {
    mocks.fetchResponse.mockResolvedValueOnce(httpResponse(401, "unauthorized"));
    await expect(queryDeepSeekBalance()).resolves.toMatchObject({
      success: false,
      failureCategory: "credentials",
    });

    mocks.fetchResponse.mockResolvedValueOnce(httpResponse(500, "unavailable"));
    await expect(queryDeepSeekBalance()).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });
  });

  it("labels invalid response shapes as provider API", async () => {
    mocks.fetchResponse.mockResolvedValueOnce(jsonResponse(null));
    await expect(queryDeepSeekBalance()).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });
  });
});

describe("Synthetic request provenance", () => {
  it("labels 401 as credentials and other HTTP failures as provider API", async () => {
    mocks.fetchResponse.mockResolvedValueOnce(httpResponse(401, "unauthorized"));
    await expect(querySyntheticQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "credentials",
    });

    mocks.fetchResponse.mockResolvedValueOnce(httpResponse(500, "unavailable"));
    await expect(querySyntheticQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });
  });

  it("labels invalid response data as provider API", async () => {
    mocks.fetchResponse.mockResolvedValueOnce(jsonResponse({}));
    await expect(querySyntheticQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });
  });
});

describe("NanoGPT request provenance", () => {
  it("labels 401 responses as credentials and other HTTP failures as provider API", async () => {
    mocks.fetchResponse
      .mockResolvedValueOnce(httpResponse(401, "unauthorized"))
      .mockResolvedValueOnce(httpResponse(401, "unauthorized"));
    await expect(queryNanoGptQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "credentials",
    });

    mocks.fetchResponse
      .mockResolvedValueOnce(httpResponse(500, "unavailable"))
      .mockResolvedValueOnce(httpResponse(500, "unavailable"));
    await expect(queryNanoGptQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });
  });

  it("labels invalid response shapes as provider API", async () => {
    mocks.fetchResponse
      .mockResolvedValueOnce(jsonResponse({ unexpected: true }))
      .mockResolvedValueOnce(jsonResponse({ unexpected: true }));
    await expect(queryNanoGptQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });
  });
});

describe("Kilo request provenance", () => {
  it("labels 401 as credentials and other HTTP failures as provider API", async () => {
    mocks.fetchResponse.mockResolvedValueOnce(httpResponse(401, "unauthorized"));
    await expect(queryKiloQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "credentials",
    });

    mocks.fetchResponse.mockResolvedValueOnce(httpResponse(500, "unavailable"));
    await expect(queryKiloQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });
  });

  it("labels invalid state data and balance fallback failures as provider API", async () => {
    mocks.fetchResponse.mockResolvedValueOnce(jsonResponse([]));
    await expect(queryKiloQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });

    mocks.fetchResponse
      .mockResolvedValueOnce(jsonResponse([{ result: { data: { json: { subscription: null } } } }]))
      .mockResolvedValueOnce(httpResponse(500, "unavailable"));
    await expect(queryKiloQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });
  });
});

function erroredBodyResponse(status: number): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("body stream failed"));
      },
    }),
    { status },
  );
}

const BODY_READ_PROVENANCE = [
  [401, "credentials"],
  [403, "credentials"],
  [500, "provider_api"],
] as const;

describe("HTTP provenance when the error body cannot be read", () => {
  it.each(
    BODY_READ_PROVENANCE,
  )("keeps Chutes HTTP %i classified as %s", async (status, category) => {
    mocks.fetchResponse.mockResolvedValueOnce(erroredBodyResponse(status));

    await expect(queryChutesQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: category,
    });
  });

  it.each(
    BODY_READ_PROVENANCE,
  )("keeps DeepSeek HTTP %i classified as %s", async (status, category) => {
    mocks.fetchResponse.mockResolvedValueOnce(erroredBodyResponse(status));

    await expect(queryDeepSeekBalance()).resolves.toMatchObject({
      success: false,
      failureCategory: category,
    });
  });

  it.each(
    BODY_READ_PROVENANCE,
  )("keeps Synthetic HTTP %i classified as %s", async (status, category) => {
    mocks.fetchResponse.mockResolvedValueOnce(erroredBodyResponse(status));

    await expect(querySyntheticQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: category,
    });
  });

  it.each(BODY_READ_PROVENANCE)("keeps Kilo HTTP %i classified as %s", async (status, category) => {
    mocks.fetchResponse.mockResolvedValueOnce(erroredBodyResponse(status));

    await expect(queryKiloQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: category,
    });
  });
});

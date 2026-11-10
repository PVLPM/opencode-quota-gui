import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createSafeAgentProviderFetch } from "./agent-custom-provider-network.js";
import { agentCustomProviderTrustFingerprint } from "./agent-custom-provider-trust.js";
import { withCanonicalConfigLock } from "./canonical-config-lock.js";
import { getGuiConfigPath } from "./config.js";
import type { EditableConfigPath } from "./config-file-utils.js";
import { resolveConfigWriteTarget } from "./config-write-target.js";
import { assertGuiConfigTargetIsIndependent } from "./gui-config-target.js";
import {
  applyConfigDocumentEdit,
  type ConfigDocumentEdit,
  ConfigDocumentError,
  parseConfigDocument,
  planConfigDocumentEdit,
  validateConfigDocumentEdit,
} from "./opencode-config-editor.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { type QuotaProviderDefinition, validateQuotaProviders } from "./quota-providers.js";
import {
  fetchRemoteQuotaProvider,
  type RemoteQuotaProviderResult,
} from "./quota-providers-remote.js";

export { agentCustomProviderTrustFingerprint } from "./agent-custom-provider-trust.js";

const AGENT_CUSTOM_PROVIDERS_KEY = "agentCustomProviders";
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TRUST_HASH_PATTERN = /^[0-9a-f]{64}$/;

export type AgentCustomProviderErrorCode =
  | "invalid-id"
  | "invalid-definition"
  | "duplicate-id"
  | "not-found"
  | "config-invalid"
  | "config-changed"
  | "config-read-error"
  | "config-write-error"
  | "unsafe-config-target"
  | "approval-required"
  | "provider-enabled";

export class AgentCustomProviderError extends Error {
  constructor(
    readonly code: AgentCustomProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentCustomProviderError";
  }
}

export interface AgentCustomProviderSummary {
  id: string;
  providerId: string;
  mode: QuotaProviderDefinition["mode"];
  trusted: boolean;
  /** Agent tools never receive activation state or an activation capability. */
  enabled: false;
}

export interface AgentCustomProviderReadResult extends AgentCustomProviderSummary {
  /** Complete normalized configuration metadata; credential values are never resolved. */
  definition: QuotaProviderDefinition;
}

export interface AgentCustomProviderTestResult {
  id: string;
  status: "passed" | "failed" | "not-applicable";
  reason: "provider-responded" | "provider-rejected" | "unsafe-endpoint" | "local-estimate";
  trusted: boolean;
  enabled: boolean;
}

export interface AgentCustomProviderUserProposal {
  id: string;
  definition: QuotaProviderDefinition;
  approved: boolean;
  enabled: boolean;
}

export interface AgentCustomProviderUserSnapshot {
  revision: string;
  providers: AgentCustomProviderUserProposal[];
}

export interface AgentCustomProviderRecord {
  definition: QuotaProviderDefinition;
  /** Human approval is tied to the material definition, never to an agent test. */
  trustedDefinitionHash: string | null;
  /** User-controlled runtime activation; missing values in older records default off. */
  enabled: boolean;
}

export interface AgentCustomProviderStoreOptions {
  configDir?: string;
  /** Test seam for external API calls. Production uses the pinned safe transport. */
  testProvider?: (
    definition: Extract<QuotaProviderDefinition, { mode: "remote-api" }>,
    apiKey: string | undefined,
  ) => Promise<RemoteQuotaProviderResult>;
  /** Test seam; production reads only the explicitly configured environment variable. */
  getEnv?: (name: string) => string | undefined;
}

export interface AgentCustomProviderStore {
  list(): Promise<AgentCustomProviderSummary[]>;
  read(id: string): Promise<AgentCustomProviderReadResult>;
  add(definition: unknown): Promise<AgentCustomProviderSummary>;
  test(id: string): Promise<AgentCustomProviderTestResult>;
  remove(id: string): Promise<{ id: string; removed: true }>;
  /** User-only surface; deliberately not exposed through agent tools. */
  listForUser(): Promise<AgentCustomProviderUserSnapshot>;
  approve(id: string, expectedRevision: string): Promise<AgentCustomProviderUserSnapshot>;
  setEnabled(
    id: string,
    enabled: boolean,
    expectedRevision: string,
  ): Promise<AgentCustomProviderUserSnapshot>;
  testApproved(id: string, expectedRevision: string): Promise<AgentCustomProviderTestResult>;
}

interface CanonicalSnapshot {
  raw: Buffer | null;
  revision: string;
  data: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function controlledError(code: AgentCustomProviderErrorCode): AgentCustomProviderError {
  switch (code) {
    case "invalid-id":
      return new AgentCustomProviderError(code, "Provider id is invalid");
    case "invalid-definition":
      return new AgentCustomProviderError(code, "Provider definition is invalid");
    case "duplicate-id":
      return new AgentCustomProviderError(code, "A provider with this id already exists");
    case "not-found":
      return new AgentCustomProviderError(code, "Provider proposal was not found");
    case "config-invalid":
      return new AgentCustomProviderError(code, "Canonical provider settings are invalid");
    case "config-changed":
      return new AgentCustomProviderError(code, "Canonical settings changed during the operation");
    case "config-read-error":
      return new AgentCustomProviderError(code, "Canonical provider settings could not be read");
    case "config-write-error":
      return new AgentCustomProviderError(
        code,
        "Canonical provider settings could not be safely updated",
      );
    case "unsafe-config-target":
      return new AgentCustomProviderError(code, "Canonical settings target is not safe to update");
    case "approval-required":
      return new AgentCustomProviderError(
        code,
        "Current user approval is required for this action",
      );
    case "provider-enabled":
      return new AgentCustomProviderError(code, "Disable the provider before removing it");
  }
}

function recordIsTrusted(record: AgentCustomProviderRecord): boolean {
  return (
    record.trustedDefinitionHash !== null &&
    record.trustedDefinitionHash === agentCustomProviderTrustFingerprint(record.definition)
  );
}

function validateDefinition(value: unknown): QuotaProviderDefinition {
  const validation = validateQuotaProviders([value]);
  if (!validation.value || validation.value.length !== 1) {
    throw controlledError("invalid-definition");
  }
  return validation.value[0]!;
}

function parseStoredRecords(value: unknown): AgentCustomProviderRecord[] {
  if (!Array.isArray(value)) throw controlledError("config-invalid");
  const records: AgentCustomProviderRecord[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (
      !isPlainObject(raw) ||
      Object.keys(raw).some(
        (key) => !["definition", "trustedDefinitionHash", "enabled"].includes(key),
      ) ||
      !Object.hasOwn(raw, "definition") ||
      !Object.hasOwn(raw, "trustedDefinitionHash")
    ) {
      throw controlledError("config-invalid");
    }
    const definition = validateDefinition(raw.definition);
    const trustedDefinitionHash = raw.trustedDefinitionHash;
    const enabled = raw.enabled === undefined ? false : raw.enabled;
    if (
      trustedDefinitionHash !== null &&
      (typeof trustedDefinitionHash !== "string" || !TRUST_HASH_PATTERN.test(trustedDefinitionHash))
    ) {
      throw controlledError("config-invalid");
    }
    if (typeof enabled !== "boolean") throw controlledError("config-invalid");
    if (ids.has(definition.id)) throw controlledError("config-invalid");
    ids.add(definition.id);
    records.push({ definition, trustedDefinitionHash, enabled });
  }
  return records;
}

function summarize(record: AgentCustomProviderRecord): AgentCustomProviderSummary {
  const trusted = recordIsTrusted(record);
  return {
    id: record.definition.id,
    providerId: record.definition.providerId,
    mode: record.definition.mode,
    trusted,
    enabled: false,
  };
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function safeConfigError(error: unknown): AgentCustomProviderError {
  if (error instanceof AgentCustomProviderError) return error;
  if (error instanceof ConfigDocumentError && /changed|appeared/i.test(error.message)) {
    return controlledError("config-changed");
  }
  return controlledError("config-write-error");
}

export function createAgentCustomProviderStore(
  options: AgentCustomProviderStoreOptions = {},
): AgentCustomProviderStore {
  const configDir = resolve(options.configDir ?? getOpencodeRuntimeDirs().configDir);
  const canonicalPath = getGuiConfigPath(configDir);
  let lockTail: Promise<unknown> = Promise.resolve();
  const safeFetch = createSafeAgentProviderFetch();
  const getEnv = options.getEnv ?? ((name: string) => process.env[name]);
  const testProvider =
    options.testProvider ??
    ((definition, apiKey) => fetchRemoteQuotaProvider(definition, apiKey, undefined, safeFetch));

  function withLock<T>(run: () => Promise<T>): Promise<T> {
    const next = lockTail.then(run, run);
    lockTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function assertCanonicalTargetIsSafe(): Promise<void> {
    try {
      await assertGuiConfigTargetIsIndependent(canonicalPath, configDir);
      const target = await resolveConfigWriteTarget(canonicalPath);
      // Unlike normal user settings writes, proposal operations do not follow a
      // canonical-file symlink: it could point at opencode.json or a legacy file.
      if (target.hops.length > 0) throw new Error("linked-target");
    } catch {
      throw controlledError("unsafe-config-target");
    }
  }

  async function captureCanonical(): Promise<CanonicalSnapshot> {
    await assertCanonicalTargetIsSafe();
    let raw: Buffer | null;
    try {
      raw = await readFile(canonicalPath);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") raw = null;
      else throw controlledError("config-read-error");
    }
    const revision = createHash("sha256")
      .update(raw ?? Buffer.from("missing canonical config"))
      .digest("hex");
    if (raw === null) return { raw, revision, data: {} };
    try {
      const data = parseConfigDocument(raw.toString("utf8"), "jsonc", canonicalPath);
      return { raw, revision, data };
    } catch {
      throw controlledError("config-invalid");
    }
  }

  function recordsFrom(data: Record<string, unknown>): AgentCustomProviderRecord[] {
    const value = data[AGENT_CUSTOM_PROVIDERS_KEY];
    return value === undefined ? [] : parseStoredRecords(value);
  }

  async function writeCapturedDocument(
    captured: CanonicalSnapshot,
    desired: Record<string, unknown>,
  ): Promise<void> {
    try {
      await assertCanonicalTargetIsSafe();
      const target: EditableConfigPath = {
        path: canonicalPath,
        sourcePath: canonicalPath,
        format: "jsonc",
        existed: captured.raw !== null,
      };
      const edit = await planConfigDocumentEdit({ target, desiredData: desired });
      if (edit.writeTarget.hops.length > 0) throw controlledError("unsafe-config-target");
      if (!sameBytes(edit.originalBytes, captured.raw)) throw controlledError("config-changed");
      const expectedRevision = createHash("sha256")
        .update(edit.originalBytes ?? Buffer.from("missing canonical config"))
        .digest("hex");
      if (expectedRevision !== captured.revision) throw controlledError("config-changed");
      await validateConfigDocumentEdit(edit);
      await assertCanonicalTargetIsSafe();
      await applyConfigDocumentEdit(edit);
    } catch (error) {
      throw safeConfigError(error);
    }
  }

  async function mutateRecords<T>(
    mutate: (
      data: Record<string, unknown>,
      records: AgentCustomProviderRecord[],
    ) => {
      records: AgentCustomProviderRecord[];
      result: T;
    },
    expectedRevision?: string,
  ): Promise<T> {
    // Capture before entering the queue. A queued mutation must not rebase onto
    // bytes written by another operation while it waited.
    const captured = await captureCanonical();
    return withLock(() =>
      withCanonicalConfigLock(canonicalPath, async () => {
        const current = await captureCanonical();
        if (!sameBytes(captured.raw, current.raw) || captured.revision !== current.revision) {
          throw controlledError("config-changed");
        }
        if (expectedRevision !== undefined && captured.revision !== expectedRevision) {
          throw controlledError("config-changed");
        }
        const records = recordsFrom(captured.data);
        const mutation = mutate(captured.data, records);
        const desired = structuredClone(captured.data);
        desired[AGENT_CUSTOM_PROVIDERS_KEY] = mutation.records;
        await writeCapturedDocument(captured, desired);
        return mutation.result;
      }),
    );
  }

  async function findRecord(id: string): Promise<AgentCustomProviderRecord> {
    if (!ID_PATTERN.test(id)) throw controlledError("invalid-id");
    const snapshot = await captureCanonical();
    const record = recordsFrom(snapshot.data).find((entry) => entry.definition.id === id);
    if (!record) throw controlledError("not-found");
    return record;
  }

  async function listForUser(): Promise<AgentCustomProviderUserSnapshot> {
    const snapshot = await captureCanonical();
    const providers = recordsFrom(snapshot.data)
      .map((record) => {
        const summary = summarize(record);
        return {
          id: summary.id,
          definition: structuredClone(record.definition),
          approved: summary.trusted,
          enabled: summary.trusted && record.enabled,
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    return { revision: snapshot.revision, providers };
  }

  return {
    async list() {
      const snapshot = await captureCanonical();
      return recordsFrom(snapshot.data)
        .map(summarize)
        .sort((left, right) => left.id.localeCompare(right.id));
    },

    async read(id) {
      const record = await findRecord(id);
      return { ...summarize(record), definition: structuredClone(record.definition) };
    },

    async add(value) {
      const definition = validateDefinition(value);
      return mutateRecords((data, records) => {
        if (
          records.some((record) => record.definition.id === definition.id) ||
          (Array.isArray(data.quotaProviders) &&
            data.quotaProviders.some(
              (record) => isPlainObject(record) && record.id === definition.id,
            ))
        ) {
          throw controlledError("duplicate-id");
        }
        const record: AgentCustomProviderRecord = {
          definition,
          trustedDefinitionHash: null,
          enabled: false,
        };
        return { records: [...records, record], result: summarize(record) };
      });
    },

    async test(id) {
      const record = await findRecord(id);
      const summary = summarize(record);
      if (record.definition.mode === "local-estimate") {
        return {
          id,
          status: "not-applicable",
          reason: "local-estimate",
          trusted: summary.trusted,
          enabled: summary.enabled,
        };
      }

      let result: RemoteQuotaProviderResult;
      try {
        // Agent-triggered tests never consult the environment and never send a
        // credential, regardless of the proposed apiKeyEnv or endpoint.
        result = await testProvider(record.definition, undefined);
      } catch {
        result = { success: false, error: "Provider request failed" };
      }
      return {
        id,
        status: result.success ? "passed" : "failed",
        reason: result.success
          ? "provider-responded"
          : result.error === "Unsafe provider endpoint"
            ? "unsafe-endpoint"
            : "provider-rejected",
        trusted: summary.trusted,
        enabled: summary.enabled,
      };
    },

    listForUser,

    async approve(id, expectedRevision) {
      if (!ID_PATTERN.test(id)) throw controlledError("invalid-id");
      await mutateRecords((_, records) => {
        const current = records.find((record) => record.definition.id === id);
        if (!current) throw controlledError("not-found");
        const trustedDefinitionHash = agentCustomProviderTrustFingerprint(current.definition);
        const alreadyApproved = current.trustedDefinitionHash === trustedDefinitionHash;
        return {
          records: records.map((record) =>
            record.definition.id === id
              ? {
                  ...record,
                  trustedDefinitionHash,
                  // A material edit revokes activation; approval itself never
                  // silently enables the endpoint.
                  enabled: alreadyApproved ? record.enabled : false,
                }
              : record,
          ),
          result: undefined,
        };
      }, expectedRevision);
      return listForUser();
    },

    async setEnabled(id, enabled, expectedRevision) {
      if (!ID_PATTERN.test(id)) throw controlledError("invalid-id");
      await mutateRecords((_, records) => {
        const current = records.find((record) => record.definition.id === id);
        if (!current) throw controlledError("not-found");
        if (enabled && !recordIsTrusted(current)) throw controlledError("approval-required");
        return {
          records: records.map((record) =>
            record.definition.id === id ? { ...record, enabled } : record,
          ),
          result: undefined,
        };
      }, expectedRevision);
      return listForUser();
    },

    async testApproved(id, expectedRevision) {
      if (!ID_PATTERN.test(id)) throw controlledError("invalid-id");
      const snapshot = await captureCanonical();
      if (snapshot.revision !== expectedRevision) throw controlledError("config-changed");
      const record = recordsFrom(snapshot.data).find((entry) => entry.definition.id === id);
      if (!record) throw controlledError("not-found");
      if (!recordIsTrusted(record)) throw controlledError("approval-required");
      if (record.definition.mode === "local-estimate") {
        return {
          id,
          status: "not-applicable",
          reason: "local-estimate",
          trusted: true,
          enabled: record.enabled,
        };
      }

      // This credential-bearing path is reachable only through the user-owned
      // UI seam after an explicit, current fingerprint approval.
      const apiKey = record.definition.apiKeyEnv
        ? getEnv(record.definition.apiKeyEnv)?.trim() || undefined
        : undefined;
      let result: RemoteQuotaProviderResult;
      try {
        result = await testProvider(record.definition, apiKey);
      } catch {
        result = { success: false, error: "Provider request failed" };
      }
      return {
        id,
        status: result.success ? "passed" : "failed",
        reason: result.success
          ? "provider-responded"
          : result.error === "Unsafe provider endpoint"
            ? "unsafe-endpoint"
            : "provider-rejected",
        trusted: true,
        enabled: record.enabled,
      };
    },

    async remove(id) {
      if (!ID_PATTERN.test(id)) throw controlledError("invalid-id");
      return mutateRecords((_, records) => {
        const record = records.find((entry) => entry.definition.id === id);
        if (!record) {
          throw controlledError("not-found");
        }
        if (record.enabled) throw controlledError("provider-enabled");
        return {
          records: records.filter((record) => record.definition.id !== id),
          result: { id, removed: true },
        };
      });
    },
  };
}

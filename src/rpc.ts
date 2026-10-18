/**
 * The plugin RPC between OpenCode Quota's server plugin and its clients. The server
 * registers it in its setup and computes quota there; clients call it by this definition.
 * Imports from `@opencode/*` stay type-only, so loading this file loads no OpenCode package.
 */
import type { Rpc } from "@opencode/plugin";
import {
  isQuotaDialogCommand,
  type QuotaDialogCommandId,
  type QuotaDialogCommandOutputResult,
} from "./lib/quota-dialog-command-specs.js";

export const QUOTA_RPC_ID = "opencode-quota-gui";

export type QuotaRpcSurfaceInput = {
  surface: "sidebar" | "idle" | "compacted" | "question";
  sessionID: string;
};
export type QuotaRpcSurfaceOutput = {
  quota: {
    message: string;
    duration: number;
    activeProviderCount: number;
    resetNotification?: string;
  } | null;
};
export type QuotaRpcFooterInput = { surface: "prompt" | "home"; sessionID?: string };
export type QuotaRpcFooterOutput = { lines: string[] };
export type QuotaRpcWriteExportInput = Record<string, never>;
export type QuotaRpcWriteExportOutput = { written: boolean };
export type QuotaRpcCommandInput = {
  command: QuotaDialogCommandId;
  arguments?: string;
  sessionID?: string;
};
export type QuotaRpcCommandOutput = QuotaDialogCommandOutputResult;

type StandardValueSchema = Extract<Rpc.PortableValueSchema, { "~standard": unknown }>;
type QuotaRpcSchema<T> = StandardValueSchema & { "~standard": { types?: { input: T; output: T } } };

/**
 * A Standard Schema that runs `check` and passes the value through unchanged. OpenCode
 * validates every input and output with it. `types` only carries T for TypeScript.
 */
function schema<T>(check: (value: unknown) => string | null): QuotaRpcSchema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "opencode-quota",
      validate: (value) => {
        const issue = check(value);
        return issue ? { issues: [{ message: issue }] } : { value: value as T };
      },
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkOutput(value: unknown): string | null {
  return isObject(value) ? null : "output must be an object";
}

function checkOptionalString(input: Record<string, unknown>, field: string): string | null {
  return input[field] === undefined || typeof input[field] === "string"
    ? null
    : `${field} must be a string`;
}

const SURFACES = ["sidebar", "idle", "compacted", "question"];
const FOOTER_SURFACES = ["prompt", "home"];

export const QuotaRpc = {
  id: QUOTA_RPC_ID,
  events: {},
  methods: {
    surface: {
      input: schema<QuotaRpcSurfaceInput>((value) => {
        if (!isObject(value)) return "input must be an object";
        if (typeof value.surface !== "string" || !SURFACES.includes(value.surface)) {
          return `surface must be one of ${SURFACES.join(", ")}`;
        }
        if (typeof value.sessionID !== "string") return "sessionID must be a string";
        return null;
      }),
      output: schema<QuotaRpcSurfaceOutput>(checkOutput),
    },
    footer: {
      input: schema<QuotaRpcFooterInput>((value) => {
        if (!isObject(value)) return "input must be an object";
        if (typeof value.surface !== "string" || !FOOTER_SURFACES.includes(value.surface)) {
          return `surface must be one of ${FOOTER_SURFACES.join(", ")}`;
        }
        return checkOptionalString(value, "sessionID");
      }),
      output: schema<QuotaRpcFooterOutput>(checkOutput),
    },
    writeExport: {
      input: schema<QuotaRpcWriteExportInput>((value) =>
        isObject(value) ? null : "input must be an object",
      ),
      output: schema<QuotaRpcWriteExportOutput>(checkOutput),
    },
    command: {
      input: schema<QuotaRpcCommandInput>((value) => {
        if (!isObject(value)) return "input must be an object";
        if (typeof value.command !== "string" || !isQuotaDialogCommand(value.command)) {
          return "command must be a quota command id";
        }
        return checkOptionalString(value, "arguments") ?? checkOptionalString(value, "sessionID");
      }),
      output: schema<QuotaRpcCommandOutput>(checkOutput),
    },
  },
} satisfies Rpc.PortableDefinition;

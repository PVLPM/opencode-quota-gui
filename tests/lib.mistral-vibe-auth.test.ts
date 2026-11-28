/**
 * Mistral Vibe credential discovery.
 *
 * Every test uses temporary directories and injected environment/stored rows, so
 * no test reads the real home directory, the real Vibe dotenv or OpenCode's real
 * credential store. A credential value is asserted only where the test must
 * prove discovery worked; it never reaches an error, a status detail or a log.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  getVibeEnvFilePath,
  getVibeHomeDir,
  MISTRAL_API_KEY_ENV_VAR,
  mistralVibeIdentityKey,
  parseDotenvValue,
  resolveMistralVibeCredentials,
} from "../src/lib/mistral-vibe-auth.js";
import type { CredentialRow } from "../src/lib/opencode-auth.js";
import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "../src/lib/provider-registration.js";

const temporaryRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mistral-vibe-auth-"));
  temporaryRoots.push(root);
  return root;
}

async function writeDotenv(dir: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, ".env");
  await writeFile(filePath, content, "utf8");
  return filePath;
}

function storedRow(overrides: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: "credential-row-1",
    integrationId: "mistral",
    label: "",
    active: true,
    value: { type: "api", key: "stored-key" },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("Vibe home resolution", () => {
  it("uses VIBE_HOME when set and the documented default otherwise", async () => {
    const root = await makeRoot();
    expect(getVibeHomeDir({ VIBE_HOME: root }, "/unused-home")).toBe(root);
    expect(getVibeHomeDir({ VIBE_HOME: `  ${root}  ` }, "/unused-home")).toBe(root);
    // No VIBE_HOME: `~/.vibe` under the injected home, never the real one.
    expect(getVibeHomeDir({}, root)).toBe(path.join(root, ".vibe"));
    expect(getVibeEnvFilePath({}, root)).toBe(path.join(root, ".vibe", ".env"));
  });
});

describe("dotenv value parsing", () => {
  it("reads the Vibe key through comments, export and quoting", () => {
    const content = [
      "# Vibe configuration",
      "OTHER=1",
      "export MISTRAL_API_KEY=plain-value",
      "TRAILING=space",
    ].join("\n");
    expect(parseDotenvValue(content, MISTRAL_API_KEY_ENV_VAR)).toBe("plain-value");
    expect(parseDotenvValue(`MISTRAL_API_KEY="double-quoted"`, MISTRAL_API_KEY_ENV_VAR)).toBe(
      "double-quoted",
    );
    expect(parseDotenvValue("MISTRAL_API_KEY='single-quoted'", MISTRAL_API_KEY_ENV_VAR)).toBe(
      "single-quoted",
    );
    expect(parseDotenvValue("MISTRAL_API_KEY=value # comment", MISTRAL_API_KEY_ENV_VAR)).toBe(
      "value",
    );
    expect(
      parseDotenvValue("# MISTRAL_API_KEY=commented", MISTRAL_API_KEY_ENV_VAR),
    ).toBeUndefined();
    expect(parseDotenvValue("MISTRAL_API_KEY=", MISTRAL_API_KEY_ENV_VAR)).toBeUndefined();
    expect(parseDotenvValue("", MISTRAL_API_KEY_ENV_VAR)).toBeUndefined();
  });

  it("strips an inline comment from an unquoted value only", () => {
    expect(parseDotenvValue("MISTRAL_API_KEY=unquoted # note", MISTRAL_API_KEY_ENV_VAR)).toBe(
      "unquoted",
    );
    // A `#` inside the quotes belongs to the value; what follows the closing
    // quote is a comment.
    expect(
      parseDotenvValue('MISTRAL_API_KEY="double # kept" # note', MISTRAL_API_KEY_ENV_VAR),
    ).toBe("double # kept");
    expect(
      parseDotenvValue("MISTRAL_API_KEY='single # kept' # note", MISTRAL_API_KEY_ENV_VAR),
    ).toBe("single # kept");
    // A `#` glued to the value is not a comment, matching the dotenv grammar.
    expect(parseDotenvValue("MISTRAL_API_KEY=value#glued", MISTRAL_API_KEY_ENV_VAR)).toBe(
      "value#glued",
    );
  });

  it("keeps the last assignment of a duplicated key, as python-dotenv does", () => {
    expect(
      parseDotenvValue(
        "MISTRAL_API_KEY=first\nOTHER=1\nMISTRAL_API_KEY=second",
        MISTRAL_API_KEY_ENV_VAR,
      ),
    ).toBe("second");
    // An empty assignment never clears a value set later in the file.
    expect(
      parseDotenvValue("MISTRAL_API_KEY=\nMISTRAL_API_KEY=set-later", MISTRAL_API_KEY_ENV_VAR),
    ).toBe("set-later");
    // A trailing empty assignment leaves no key at all, which is how the Vibe
    // CLI reads the merged mapping.
    expect(
      parseDotenvValue("MISTRAL_API_KEY=set\nMISTRAL_API_KEY=", MISTRAL_API_KEY_ENV_VAR),
    ).toBeUndefined();
    expect(
      parseDotenvValue("MISTRAL_API_KEY= # only a comment", MISTRAL_API_KEY_ENV_VAR),
    ).toBeUndefined();
  });

  it("ignores a comment after a quoted value inside a larger file", () => {
    const content = [
      "# generated by the Vibe CLI",
      'export MISTRAL_API_KEY="quoted-key" # managed',
      "OTHER=value",
    ].join("\r\n");
    expect(parseDotenvValue(content, MISTRAL_API_KEY_ENV_VAR)).toBe("quoted-key");
  });
});

describe("Mistral Vibe credential discovery", () => {
  it("reads MISTRAL_API_KEY from <VIBE_HOME>/.env", async () => {
    const vibeHome = path.join(await makeRoot(), "vibe-home");
    const envPath = await writeDotenv(vibeHome, "MISTRAL_API_KEY=dotenv-key\n");
    const resolution = await resolveMistralVibeCredentials({
      env: { VIBE_HOME: vibeHome },
      readStoredRows: async () => [],
    });

    expect(resolution.credentials).toHaveLength(1);
    expect(resolution.credentials[0]?.source).toBe("vibe_dotenv");
    expect(resolution.credentials[0]?.sourceId).toBe("vibe-dotenv");
    expect(resolution.credentials[0]?.identityKey).toBe(mistralVibeIdentityKey("dotenv-key"));
    expect(resolution.checkedPaths).toEqual([envPath]);
  });

  it("defaults to <home>/.vibe without VIBE_HOME", async () => {
    const home = await makeRoot();
    await writeDotenv(path.join(home, ".vibe"), "MISTRAL_API_KEY=default-home-key\n");
    const resolution = await resolveMistralVibeCredentials({
      env: {},
      homeDir: home,
      readStoredRows: async () => [],
    });

    expect(resolution.credentials.map((credential) => credential.source)).toEqual(["vibe_dotenv"]);
    expect(resolution.checkedPaths).toEqual([path.join(home, ".vibe", ".env")]);
  });

  it("honours the MISTRAL_API_KEY environment variable", async () => {
    const vibeHome = await makeRoot();
    const resolution = await resolveMistralVibeCredentials({
      env: { VIBE_HOME: vibeHome, MISTRAL_API_KEY: "env-key" },
      readStoredRows: async () => [],
    });

    expect(resolution.credentials[0]?.source).toBe("env");
    expect(resolution.credentials[0]?.sourceId).toBe("vibe-env");
  });

  it("collapses the same key from every source into one account", async () => {
    const vibeHome = await makeRoot();
    await writeDotenv(vibeHome, "MISTRAL_API_KEY=shared-key\n");
    const resolution = await resolveMistralVibeCredentials({
      env: { VIBE_HOME: vibeHome, MISTRAL_API_KEY: "shared-key" },
      readStoredRows: async () => [storedRow({ value: { type: "api", key: "shared-key" } })],
    });

    expect(resolution.credentials).toHaveLength(1);
    expect(resolution.credentials[0]?.source).toBe("env");
  });

  it("keeps different keys as separate accounts and never invents identity", async () => {
    const vibeHome = await makeRoot();
    await writeDotenv(vibeHome, "MISTRAL_API_KEY=second-key\n");
    const resolution = await resolveMistralVibeCredentials({
      env: { VIBE_HOME: vibeHome, MISTRAL_API_KEY: "first-key" },
      readStoredRows: async () => [storedRow({ value: { type: "api", key: "third-key" } })],
    });

    expect(resolution.credentials.map((credential) => credential.sourceId)).toEqual([
      "vibe-env",
      "vibe-dotenv",
      "credential-row-1",
    ]);
    const identities = resolution.credentials.map((credential) => credential.identityKey);
    expect(new Set(identities).size).toBe(3);
    for (const identity of identities) {
      expect(identity).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(mistralVibeIdentityKey("first-key")).toBe(identities[0]);
  });

  it("uses OpenCode's stored Mistral login when no environment key exists", async () => {
    const vibeHome = await makeRoot();
    const resolution = await resolveMistralVibeCredentials({
      env: { VIBE_HOME: vibeHome },
      readStoredRows: async () => [
        storedRow(),
        // A failed connection keeps its id but carries no key.
        storedRow({ id: "failed-row", value: { type: "api" }, active: false }),
      ],
    });

    expect(resolution.credentials).toHaveLength(1);
    expect(resolution.credentials[0]?.source).toBe("opencode.db");
    expect(resolution.credentials[0]?.sourceId).toBe("credential-row-1");
    expect(resolution.credentials[0]?.active).toBe(true);
  });

  it("never returns a credential value in its diagnostics-shaped output", async () => {
    const vibeHome = path.join(await makeRoot(), "vibe-home");
    await writeDotenv(vibeHome, "MISTRAL_API_KEY=secret-value-that-must-not-leak\n");
    const resolution = await resolveMistralVibeCredentials({
      env: { VIBE_HOME: vibeHome },
      readStoredRows: async () => [],
    });

    const serialized = JSON.stringify({
      checkedPaths: resolution.checkedPaths,
      sources: resolution.credentials.map((credential) => credential.source),
      sourceIds: resolution.credentials.map((credential) => credential.sourceId),
      identityKeys: resolution.credentials.map((credential) => credential.identityKey),
    });
    expect(serialized).not.toContain("secret-value-that-must-not-leak");
  });

  it("declares only the credential sources the resolver actually reads", async () => {
    const mistral = QUOTA_PROVIDER_REGISTRATION_SOURCE.find((entry) => entry.id === "mistral");
    expect(mistral?.shape.authFallbacks).toEqual(["env_api_key"]);

    // The resolver reads the environment variable, the Vibe dotenv and
    // OpenCode's stored Mistral logins, and nothing else: the registration must
    // not advertise a source this resolver never reads.
    const vibeHome = await makeRoot();
    await writeDotenv(vibeHome, "MISTRAL_API_KEY=dotenv-key\n");
    const resolution = await resolveMistralVibeCredentials({
      env: { VIBE_HOME: vibeHome, MISTRAL_API_KEY: "env-key" },
      readStoredRows: async () => [storedRow()],
    });
    expect(resolution.credentials.map((credential) => credential.source)).toEqual([
      "env",
      "vibe_dotenv",
      "opencode.db",
    ]);
  });
});

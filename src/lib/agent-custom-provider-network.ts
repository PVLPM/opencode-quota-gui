import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const MAX_PROVIDER_URL_LENGTH = 2048;
type ProviderFetchInput = Parameters<typeof fetch>[0];

const BLOCKED_IPV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_IPV4.addSubnet(address, prefix, "ipv4");
}

const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet("2000::", 3, "ipv6");

const BLOCKED_IPV6 = new BlockList();
for (const [address, prefix] of [
  ["2000::", 23],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  BLOCKED_IPV6.addSubnet(address, prefix, "ipv6");
}

export type SafeProviderAddress = {
  address: string;
  family: 4 | 6;
};

export type SafeProviderRequest = {
  address: string;
  family: 4 | 6;
  hostname: string;
  authority: string;
  port: number;
  path: string;
  method: "GET";
  headers: Record<string, string>;
  signal?: AbortSignal;
  /** Private trust root used only by the loopback transport test. */
  ca?: string;
};

export interface SafeProviderFetchDependencies {
  /** Test seam for DNS answers; production resolves once before pinning the connection. */
  resolveHost?: (hostname: string) => Promise<readonly SafeProviderAddress[]>;
  /** Test seam for the pinned socket operation; production connects to the literal address. */
  requestPinned?: (request: SafeProviderRequest) => Promise<Response>;
}

export class AgentProviderNetworkError extends Error {
  readonly code: "unsafe-endpoint" | "request-failed";

  constructor(code: AgentProviderNetworkError["code"]) {
    super(code === "unsafe-endpoint" ? "Unsafe provider endpoint" : "Provider request failed");
    this.name = "AgentProviderNetworkError";
    this.code = code;
  }
}

function withoutIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isPublicAddress(address: string, family: number): address is string {
  try {
    if (family === 4 && isIP(address) === 4) {
      return !BLOCKED_IPV4.check(address, "ipv4");
    }
    if (family === 6 && isIP(address) === 6) {
      return GLOBAL_IPV6.check(address, "ipv6") && !BLOCKED_IPV6.check(address, "ipv6");
    }
  } catch {
    return false;
  }
  return false;
}

function isPublicHostname(hostname: string): boolean {
  const normalized = withoutIpv6Brackets(hostname).toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.includes("%")) return false;
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return false;
  }
  return true;
}

async function resolveProviderHost(hostname: string): Promise<readonly SafeProviderAddress[]> {
  const literal = withoutIpv6Brackets(hostname);
  const literalFamily = isIP(literal);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: literal, family: literalFamily }];
  }
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.flatMap((answer) =>
    answer.family === 4 || answer.family === 6
      ? [{ address: answer.address, family: answer.family }]
      : [],
  );
}

function headersForRequest(input: ProviderFetchInput, init?: RequestInit): Record<string, string> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
  const result: Record<string, string> = { host: "" };
  const authorization = headers.get("authorization");
  if (authorization) {
    if (authorization.length > 8192) throw new AgentProviderNetworkError("unsafe-endpoint");
    result.authorization = authorization;
  }
  result.accept = headers.get("accept") ?? "application/json";
  return result;
}

function requestPinnedAddress(request: SafeProviderRequest): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const resolveOnce = (response: Response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const isLiteral = isIP(request.hostname) !== 0;
    const responseChunks: Buffer[] = [];
    let responseBytes = 0;
    const outgoing = httpsRequest(
      {
        hostname: request.address,
        family: request.family,
        port: request.port,
        path: request.path,
        method: request.method,
        agent: false,
        ...(isLiteral ? {} : { servername: request.hostname }),
        headers: { ...request.headers, host: request.authority },
        ...(request.ca ? { ca: request.ca } : {}),
        ...(isLiteral
          ? {
              checkServerIdentity: (
                _hostname: string,
                certificate: Parameters<typeof checkServerIdentity>[1],
              ) => checkServerIdentity(request.hostname, certificate),
            }
          : {
              checkServerIdentity: (
                _hostname: string,
                certificate: Parameters<typeof checkServerIdentity>[1],
              ) => checkServerIdentity(request.hostname, certificate),
            }),
        ...(request.signal ? { signal: request.signal } : {}),
      },
      (incoming) => {
        incoming.once("aborted", () => rejectOnce(new Error("response-aborted")));
        incoming.once("error", rejectOnce);
        incoming.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += bytes.byteLength;
          if (responseBytes > MAX_PROVIDER_RESPONSE_BYTES) {
            outgoing.destroy(new Error("response-too-large"));
            return;
          }
          responseChunks.push(bytes);
        });
        incoming.once("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (typeof value === "string") responseHeaders.set(name, value);
            else if (Array.isArray(value)) responseHeaders.set(name, value.join(", "));
          }
          const status = incoming.statusCode ?? 502;
          const body =
            status === 204 || status === 205 || status === 304
              ? null
              : Buffer.concat(responseChunks);
          try {
            resolveOnce(
              new Response(body, {
                status,
                statusText: incoming.statusMessage,
                headers: responseHeaders,
              }),
            );
          } catch (error) {
            rejectOnce(error);
          }
        });
      },
    );
    outgoing.once("error", rejectOnce);
    outgoing.end();
  });
}

/** @internal Exercises the actual pinned HTTPS socket with a local test server. */
export function requestPinnedAddressForTest(request: SafeProviderRequest): Promise<Response> {
  return requestPinnedAddress(request);
}

function parseProviderRequest(
  input: ProviderFetchInput,
  init?: RequestInit,
): {
  url: URL;
  signal?: AbortSignal;
} {
  try {
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (typeof rawUrl !== "string" || rawUrl.length > MAX_PROVIDER_URL_LENGTH) {
      throw new AgentProviderNetworkError("unsafe-endpoint");
    }
    const url = new URL(rawUrl);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const hasBody = init?.body !== undefined || (input instanceof Request && input.body !== null);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !isPublicHostname(url.hostname) ||
      (url.port !== "" && url.port !== "443") ||
      method.toUpperCase() !== "GET" ||
      hasBody
    ) {
      throw new AgentProviderNetworkError("unsafe-endpoint");
    }
    return {
      url,
      ...((init?.signal ?? (input instanceof Request ? input.signal : undefined))
        ? { signal: init?.signal ?? (input instanceof Request ? input.signal : undefined) }
        : {}),
    };
  } catch (error) {
    if (error instanceof AgentProviderNetworkError) throw error;
    throw new AgentProviderNetworkError("unsafe-endpoint");
  }
}

/**
 * A fetch-compatible, HTTPS-only transport for agent-triggered tests. DNS is
 * resolved once, every returned address must be globally routable, and the
 * socket connects to that literal address while TLS verifies the original host.
 * Redirects are returned to the caller and are never followed.
 */
export function createSafeAgentProviderFetch(
  dependencies: SafeProviderFetchDependencies = {},
): typeof fetch {
  const resolveHost = dependencies.resolveHost ?? resolveProviderHost;
  const requestPinned = dependencies.requestPinned ?? requestPinnedAddress;

  return async (input, init) => {
    const { url, signal } = parseProviderRequest(input, init);
    const hostname = withoutIpv6Brackets(url.hostname);
    const literalFamily = isIP(hostname);
    let addresses: readonly SafeProviderAddress[];
    try {
      addresses = await resolveHost(hostname);
    } catch {
      throw new AgentProviderNetworkError("unsafe-endpoint");
    }
    if (
      addresses.length === 0 ||
      addresses.some((address) => !isPublicAddress(address.address, address.family))
    ) {
      throw new AgentProviderNetworkError("unsafe-endpoint");
    }

    // Using a literal destination here closes the DNS-rebinding window: the
    // socket never performs another lookup after this validation.
    const address = addresses[0]!;
    if (literalFamily !== 0 && address.address !== hostname) {
      throw new AgentProviderNetworkError("unsafe-endpoint");
    }
    if (signal?.aborted) throw new AgentProviderNetworkError("request-failed");

    const headers = headersForRequest(input, init);
    headers.host = url.host;
    try {
      return await requestPinned({
        address: address.address,
        family: address.family,
        hostname,
        authority: url.host,
        port: url.port ? Number(url.port) : 443,
        path: url.pathname,
        method: "GET",
        headers,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof AgentProviderNetworkError) throw error;
      throw new AgentProviderNetworkError("request-failed");
    }
  };
}

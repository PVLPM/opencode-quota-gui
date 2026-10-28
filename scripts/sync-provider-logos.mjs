import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

/**
 * Deterministic provider-logo sync.
 *
 * models.dev is the upstream source of the monochrome provider marks. The
 * revision is pinned, the archive is read directly, and every SVG is checked for
 * active content or an external resource reference before it is written. The
 * browser catalog is generated from the same pass, so a raw analytics id is
 * never used to build a file path at runtime: the catalog contains only
 * precomputed, allowlisted `/assets/providers/<safe-id>.svg` strings.
 *
 * `--check` is offline: it re-hashes every vendored file, re-validates each SVG,
 * and proves the generated catalog and notices are exactly what this script
 * would write. CI and focused tests use it; only an explicit sync fetches the
 * pinned archive.
 */

export const MODELS_DEV_REPOSITORY = "https://github.com/anomalyco/models.dev";
export const MODELS_DEV_REVISION = "30a8b13a5a5507979ddbf8d339c7746cf7e4f442";
export const EXPECTED_LOGO_COUNT = 222;
export const EXPECTED_UPSTREAM_BYTES = 623_957;
/**
 * SHA-256 over every normalized file path and byte in the codeload archive for
 * MODELS_DEV_REVISION. Computed from the pinned upstream archive; change only
 * with a deliberate revision bump, never to accommodate an unverified file.
 */
export const EXPECTED_ARCHIVE_CONTENT_SHA256 =
  "b6c75b60a9d81c75e6ea2ce2b13a14116cf572dcdd8e08c8d950f0e099953267";
export const PROVIDER_LOGO_DIR = "src/ui/assets/provider-logos";
export const GENERATED_CATALOG_PATH = "src/ui/provider-logos.generated.json";
export const GENERIC_LOGO_FILE = "generic.svg";
export const MAX_LOGO_BYTES = 128 * 1024;
export const LOCAL_OVERRIDES_FILE = "local-overrides.json";
export const OPENCODE_REPOSITORY = "https://github.com/anomalyco/opencode";
export const OPENCODE_COMMIT = "86976449c40d48f2731553a024f74552593d1764";
export const OPENCODE_SOURCE_PATH = "packages/ui/src/components/provider-icons/sprite.svg";
export const OPENCODE_LICENSE_FILE = "OPENCODE-MIT.txt";
export const OPENCODE_NOTICE_FILE = "OPENCODE-NOTICE.md";
export const OPENCODE_SPRITE_SHA256 =
  "90c22219a2aeff3ea489625156530ea0fa8a072a1b934a52a9192074d39237df";
export const OPENCODE_LICENSE_SHA256 =
  "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b";
export const EXPECTED_LOCAL_LOGO_COUNT = 1;

const SAFE_PROVIDER_ID = /^[a-z0-9][a-z0-9.-]*$/u;
const SAFE_LOGO_URL = /^\/assets\/providers\/[a-z0-9][a-z0-9.-]*\.svg$/u;
const PROVIDER_LABEL_FALLBACKS = new Map([
  ["fluence", "Fluence"],
  ["teamorouter", "TeamRouter"],
]);

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function parseTarNumber(buffer, offset, length) {
  const raw = cString(buffer, offset, length).trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/u.test(raw)) throw new Error(`Unsupported tar number: ${raw}`);
  return Number.parseInt(raw, 8);
}

function tarChecksum(header) {
  let total = 0;
  for (let index = 0; index < header.length; index += 1) {
    total += index >= 148 && index < 156 ? 32 : header[index];
  }
  return total;
}

function paxPath(data) {
  for (const line of data.toString("utf8").split("\n")) {
    const match = /^\d+ path=(.*)$/u.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** Reads the target files out of a gzipped tar without a tar dependency. */
export function readTarFiles(archive) {
  const buffer = gunzipSync(archive);
  const files = new Map();
  let offset = 0;
  let pendingPath;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const storedChecksum = parseTarNumber(header, 148, 8);
    if (storedChecksum !== tarChecksum(header)) {
      throw new Error("The pinned models.dev archive has a corrupt tar header");
    }

    const name = cString(header, 0, 100);
    const size = parseTarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] === 0 ? 48 : header[156]);
    const prefix = cString(header, 345, 155);
    const dataStart = offset + 512;
    const data = buffer.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new Error(`Truncated tar entry: ${name}`);

    if (type === "x" || type === "L") {
      pendingPath = type === "L" ? data.toString("utf8").replace(/\0+$/u, "") : paxPath(data);
    } else if (type === "g") {
      pendingPath = undefined;
    } else if (type === "0" || type === "\0" || type === "7") {
      const entryPath = pendingPath ?? (prefix === "" ? name : `${prefix}/${name}`);
      pendingPath = undefined;
      files.set(entryPath.replace(/^\.\//u, ""), data);
    } else {
      pendingPath = undefined;
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function tagLocalName(tag) {
  const match = /^<\s*\/?\s*(?:[A-Za-z_][-A-Za-z0-9_.]*:)?([A-Za-z_][-A-Za-z0-9_.]*)/u.exec(tag);
  return match?.[1] ?? "";
}

function preservesWhitespace(name) {
  const local = name.toLowerCase();
  return (
    local === "text" ||
    local === "tspan" ||
    local === "textpath" ||
    local === "title" ||
    local === "desc" ||
    local === "metadata" ||
    local === "style"
  );
}

/** Content ranges whose trailing whitespace is semantically meaningful. */
function protectedWhitespaceRanges(source) {
  const ranges = [];
  const stack = [];
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf("<", index);
    if (start === -1) break;
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", start)) {
      const end = source.indexOf("]]>", start + 9);
      index = end === -1 ? source.length : end + 3;
      continue;
    }

    const tag = readTag(source, start);
    if (/^<\//u.test(tag.text)) {
      const name = tagLocalName(tag.text);
      let match = -1;
      for (let stackIndex = stack.length - 1; stackIndex >= 0; stackIndex -= 1) {
        if (stack[stackIndex].name === name) {
          match = stackIndex;
          break;
        }
      }
      if (match !== -1) {
        const entry = stack[match];
        stack.length = match;
        if (entry.protect && !stack.some((item) => item.protect)) {
          ranges.push([entry.contentStart, start]);
        }
      }
    } else if (!/^<[!?]/u.test(tag.text) && !/\/>\s*$/u.test(tag.text)) {
      const name = tagLocalName(tag.text);
      const protect =
        preservesWhitespace(name) || /\bxml:space\s*=\s*(["'])preserve\1/u.test(tag.text);
      stack.push({ name, protect, contentStart: tag.end });
    }
    index = tag.end;
  }

  const unclosed = stack.find((entry) => entry.protect);
  if (unclosed !== undefined) ranges.push([unclosed.contentStart, source.length]);
  return ranges;
}

/**
 * Removes trailing horizontal whitespace outside whitespace-sensitive SVG text
 * content. Path data, attribute lists and markup separators are safe to trim;
 * inside <text>/<tspan>/<textPath>, <title>/<desc>, metadata/style content or an
 * xml:space="preserve" subtree it is preserved.
 */
function stripTrailingWhitespace(source) {
  const ranges = protectedWhitespaceRanges(source);
  return source.replace(/[ \t]+(?=\r?\n|$)/gu, (match, offset) => {
    const end = offset + match.length;
    return ranges.some(([rangeStart, rangeEnd]) => offset < rangeEnd && end > rangeStart)
      ? match
      : "";
  });
}

export function normalizedSvg(bytes, id) {
  if (bytes.length > MAX_LOGO_BYTES) {
    throw new Error(`${id}: logo exceeds ${MAX_LOGO_BYTES} bytes`);
  }
  let source = bytes.toString("utf8");
  if (source.includes("\0")) throw new Error(`${id}: logo contains a NUL byte`);
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  source = source.replace(/^\s*<\?xml[^>]*\?>\s*/iu, "");
  // A browser does not need the XML declaration or a DTD; dropping the DTD
  // also removes the only external reference in the pinned archive.
  source = source.replace(/^\s*<!DOCTYPE[^>]*(?:\[[\s\S]*?\]\s*)?>\s*/iu, "");
  source = stripTrailingWhitespace(source);
  if (!source.endsWith("\n")) source += "\n";
  return source;
}

/**
 * Rejects active content and any resource that would be fetched from outside the
 * package. Namespace declarations, comments and local `data:image` payloads are
 * not resource loads.
 *
 * Browsers decode XML character references and CSS escapes before they parse a
 * URL, so the inspector projects those contexts first. Otherwise
 * `fill:u\72l(https\3a//evil.example/x.svg#id)` would read as harmless text.
 */
function codePointToText(codePoint) {
  if (
    !Number.isInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return "\uFFFD";
  }
  return String.fromCodePoint(codePoint);
}

function decodeXmlCharacterReferences(value) {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/giu,
    (match, hex, decimal, named) => {
      if (named !== undefined) {
        switch (named.toLowerCase()) {
          case "amp":
            return "&";
          case "lt":
            return "<";
          case "gt":
            return ">";
          case "quot":
            return '"';
          case "apos":
            return "'";
        }
      }
      const numeric = hex ?? decimal;
      if (numeric === undefined) return match;
      return codePointToText(Number.parseInt(numeric, hex === undefined ? 10 : 16));
    },
  );
}

function decodeCssEscapes(value) {
  return value.replace(
    /\\(?:([0-9a-f]{1,6})(?:[ \t\r\n\f])?|(\r\n|[\n\r\f])|([\s\S]))/giu,
    (_match, hex, newline, character) => {
      if (hex !== undefined) return codePointToText(Number.parseInt(hex, 16));
      if (newline !== undefined) return "";
      return character ?? "";
    },
  );
}

/** XML entities decode first (markup), then CSS comments, then CSS escapes. */
function cssInspectionValue(value) {
  return decodeCssEscapes(decodeXmlCharacterReferences(value).replace(/\/\*[\s\S]*?\*\//gu, ""));
}

function readTag(source, start) {
  let index = start + 1;
  let quote;
  while (index < source.length) {
    const character = source[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return { end: index + 1, text: source.slice(start, index + 1) };
    }
    index += 1;
  }
  return { end: source.length, text: source.slice(start) };
}

/**
 * Decodes CSS/XML escapes inside attribute values and drops namespace
 * declarations. A real attribute walk is used so a style value such as
 * `style="fill:url(#ok); xmlns='x'; background:url(...)"` cannot hide the
 * trailing URL from the inspector.
 */
function transformTag(tag) {
  if (/^<\//u.test(tag) || /^<[!?]/u.test(tag)) return tag;
  const selfClosing = /\/>\s*$/u.test(tag);
  let index = 1;
  while (index < tag.length && /[ \t\n\f\r]/u.test(tag[index])) index += 1;
  const nameStart = index;
  while (index < tag.length && !/[ \t\n\f\r/>]/u.test(tag[index])) index += 1;
  const tagName = tag.slice(nameStart, index);
  let output = `<${tagName}`;

  while (index < tag.length) {
    while (index < tag.length && /[ \t\n\f\r]/u.test(tag[index])) index += 1;
    if (index >= tag.length || tag[index] === ">") break;
    if (tag[index] === "/" && tag[index + 1] === ">") break;

    const attributeStart = index;
    while (index < tag.length && !/[ \t\n\f\r=/>]/u.test(tag[index])) index += 1;
    const attributeName = tag.slice(attributeStart, index);
    if (attributeName === "") {
      index += 1;
      continue;
    }
    while (index < tag.length && /[ \t\n\f\r]/u.test(tag[index])) index += 1;
    if (tag[index] !== "=") {
      output += ` ${attributeName}`;
      continue;
    }
    index += 1;
    while (index < tag.length && /[ \t\n\f\r]/u.test(tag[index])) index += 1;
    const quote = tag[index] === '"' || tag[index] === "'" ? tag[index] : "";
    if (quote !== "") index += 1;
    const valueStart = index;
    if (quote !== "") {
      while (index < tag.length && tag[index] !== quote) index += 1;
    } else {
      while (index < tag.length && !/[ \t\n\f\r>]/u.test(tag[index])) index += 1;
    }
    const value = tag.slice(valueStart, index);
    if (quote !== "") index += 1;

    if (attributeName === "xmlns" || attributeName.startsWith("xmlns:")) {
      output += ` ${attributeName}=""`;
    } else {
      // Quotes decoded from entities or escapes must not break the projection.
      const safeValue = cssInspectionValue(value).replace(/["']/gu, " ");
      output +=
        quote === ""
          ? ` ${attributeName}=${safeValue}`
          : ` ${attributeName}=${quote}${safeValue}${quote}`;
    }
  }

  return `${output}${selfClosing ? "/>" : ">"}`;
}

function inspectionProjection(source) {
  let output = "";
  let index = 0;
  const lowerSource = source.toLowerCase();
  while (index < source.length) {
    const start = source.indexOf("<", index);
    if (start === -1) {
      output += source.slice(index);
      break;
    }
    output += source.slice(index, start);

    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", start)) {
      const end = source.indexOf("]]>", start + 9);
      output += source.slice(start + 9, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end + 3;
      continue;
    }

    const tag = readTag(source, start);
    output += transformTag(tag.text);
    index = tag.end;

    if (/^<style\b/iu.test(tag.text) && !/\/>\s*$/u.test(tag.text)) {
      const closeStart = lowerSource.indexOf("</style", index);
      if (closeStart !== -1) {
        output += cssInspectionValue(source.slice(index, closeStart));
        const closeTag = readTag(source, closeStart);
        output += closeTag.text;
        index = closeTag.end;
      }
    }
  }
  return output;
}

function cssUrlReferences(source) {
  const references = [];
  const pattern = /(?<![-\w])url\s*\(/giu;
  for (const match of source.matchAll(pattern)) {
    let index = (match.index ?? 0) + match[0].length;
    while (index < source.length && /[ \t\n\f\r]/u.test(source[index])) index += 1;
    const quote = source[index];
    let value;
    if (quote === '"' || quote === "'") {
      index += 1;
      const start = index;
      while (index < source.length && source[index] !== quote) index += 1;
      value = source.slice(start, index);
    } else {
      const start = index;
      while (index < source.length && source[index] !== ")") index += 1;
      value = source.slice(start, index);
    }
    references.push(value.trim());
  }
  return references;
}

const LOCAL_RASTER_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/iu;

export function inspectSvgSafety(source, id) {
  const problems = [];
  const withoutComments = source.replace(/<!--[\s\S]*?-->/gu, "");
  const projection = inspectionProjection(source);
  if (!/^\s*<svg\b/iu.test(withoutComments)) problems.push("missing svg root");
  if (/<(?:[A-Za-z_][-A-Za-z0-9_.]*:)?script\b/iu.test(projection)) {
    problems.push("script element");
  }
  if (/\son[a-z]+\s*=/iu.test(projection)) problems.push("event handler");
  if (/<(?:[A-Za-z_][-A-Za-z0-9_.]*:)?foreignObject\b/iu.test(projection)) {
    problems.push("foreignObject");
  }
  if (/<!ENTITY\b/iu.test(projection)) problems.push("entity declaration");
  if (/<!DOCTYPE\b/iu.test(projection)) problems.push("DOCTYPE");
  if (/<\?/u.test(projection)) problems.push("processing instruction");
  if (/javascript:/iu.test(projection)) problems.push("javascript url");

  for (const match of projection.matchAll(/\b(?:xlink:)?href\s*=\s*(["'])([\s\S]*?)\1/giu)) {
    const href = (match[2] ?? "").trim();
    const local = href.startsWith("#") || LOCAL_RASTER_DATA_URL.test(href);
    if (!local) problems.push(`external href ${href.slice(0, 80)}`);
  }
  for (const url of cssUrlReferences(projection)) {
    const local = url.startsWith("#") || LOCAL_RASTER_DATA_URL.test(url);
    if (!local) problems.push(`external url(${url.slice(0, 80)})`);
  }
  if (/@import\b/iu.test(projection)) problems.push("@import");
  if (/(?<![-\w])image(?:-set)?\s*\(/iu.test(projection)) {
    problems.push("CSS image function");
  }
  if (/(?<![-\w])src\s*\(/iu.test(projection)) problems.push("CSS src function");
  if (/https?:\/\//iu.test(projection)) problems.push("external URL outside a namespace");
  if (problems.length > 0) throw new Error(`${id}: unsafe SVG: ${problems.join(", ")}`);
  return problems;
}

function labelFor(id, toml) {
  const match = toml === undefined ? null : /^name\s*=\s*"((?:[^"\\]|\\.)*)"/mu.exec(toml);
  if (!match) return PROVIDER_LABEL_FALLBACKS.get(id) ?? id;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return PROVIDER_LABEL_FALLBACKS.get(id) ?? id;
  }
}

function buildNotice(logoCount) {
  return `# Provider logo attribution and brand notice

Provider logo assets in this directory are vendored from [models.dev](${MODELS_DEV_REPOSITORY}), pinned to commit \`${MODELS_DEV_REVISION}\`.

- **Upstream license:** MIT. The copyright and permission notice is preserved verbatim in \`UPSTREAM-MIT.txt\`.
- **Source path:** \`providers/<provider-id>/logo.svg\` in the pinned models.dev archive.
- **Normalization:** each SVG is stored as UTF-8 with XML/DTD declarations removed, trailing horizontal whitespace outside whitespace-sensitive text content stripped, and a final newline added; the artwork itself is unchanged.
- **Local use:** ${logoCount} upstream provider logos, the local neutral \`${GENERIC_LOGO_FILE}\` fallback and the local OpenCode Go G mark are copied into the package at build time and served from same-origin \`/assets/providers/\`. The dashboard never hotlinks a remote logo.
- **OpenCode identities:** the upstream \`opencode\` and \`opencode-go\` entries in models.dev both contain the O artwork and remain vendored unchanged. Presentation overrides only \`opencode-go\` with a dedicated G mark extracted from [OpenCode](${OPENCODE_REPOSITORY}) at \`${OPENCODE_COMMIT}\`; see \`${OPENCODE_NOTICE_FILE}\` and \`${OPENCODE_LICENSE_FILE}\`. \`opencode\` and OpenCode Zen keep the O mark. Raw analytics identities are never rewritten.
- **Brand rights:** the MIT license covers the models.dev repository and the assets as distributed there. It does not establish or grant rights in any provider's name, logo, or other trademark, and individual brand-use terms may still apply. The logos identify the corresponding providers in a local dashboard; no affiliation or endorsement is implied.
- **Mask-incompatible marks:** a small number of upstream marks use an opaque raster or full-bleed background and would collapse to a solid block under a one-colour mask. The catalog shows the local neutral fallback for those while keeping the vendored file and attribution.
- **Fallback:** providers with no specific upstream logo or no catalog entry use the local neutral fallback, not an upstream placeholder mark.
`;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compareProviderIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function buildRuntimeCatalog(entries) {
  return {
    source: "models.dev",
    revision: MODELS_DEV_REVISION,
    logos: Object.fromEntries(
      [...entries]
        .sort(([left], [right]) => compareProviderIds(left, right))
        .map(([id, entry]) => [id, { label: entry.label, url: `/assets/providers/${id}.svg` }]),
    ),
  };
}

function buildIntegrityManifest(entries, upstreamBytes, logoBytes) {
  return {
    source: "models.dev",
    repository: MODELS_DEV_REPOSITORY,
    revision: MODELS_DEV_REVISION,
    license: "MIT",
    logoCount: entries.size,
    logoBytes,
    upstreamBytes,
    logos: Object.fromEntries(
      [...entries]
        .sort(([left], [right]) => compareProviderIds(left, right))
        .map(([id, entry]) => [
          id,
          {
            label: entry.label,
            url: `/assets/providers/${id}.svg`,
            bytes: entry.bytes,
            sha256: entry.sha256,
          },
        ]),
    ),
  };
}

async function fetchPinnedArchive() {
  const url = `https://codeload.github.com/anomalyco/models.dev/tar.gz/${MODELS_DEV_REVISION}`;
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "opencode-quota-gui-provider-logo-sync" },
  });
  if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function readArchiveFrom(path) {
  return readFileSync(path);
}

function idsFromArchive(files) {
  const logos = new Map();
  const tomls = new Map();
  for (const [filePath, data] of files) {
    const logoMatch = /^[^/]+\/providers\/([^/]+)\/logo\.svg$/u.exec(filePath);
    if (logoMatch) {
      logos.set(logoMatch[1], data);
      continue;
    }
    const tomlMatch = /^[^/]+\/providers\/([^/]+)\/provider\.toml$/u.exec(filePath);
    if (tomlMatch) tomls.set(tomlMatch[1], data.toString("utf8"));
  }
  return { logos, tomls };
}

function upstreamLicense(files) {
  for (const [filePath, data] of files) {
    if (/^[^/]+\/LICENSE$/u.test(filePath)) return data;
  }
  throw new Error("The pinned models.dev archive has no LICENSE file");
}

function hashField(hash, label, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  hash.update(`${label}\0${bytes.length}\0`);
  hash.update(bytes);
}

/**
 * A content digest of the archive, independent of tar/gzip container bytes.
 * Manual `--archive` inputs are checked against this pin before anything is
 * written, so a same-count/same-byte tampered archive cannot slip through.
 */
export function archiveContentDigest(files) {
  const hash = createHash("sha256");
  const entries = [...files].sort(([left], [right]) => compareProviderIds(left, right));
  hash.update(`models.dev\0${MODELS_DEV_REVISION}\0${entries.length}\0`);
  for (const [filePath, data] of entries) {
    // codeload wraps every file in one `<repo>-<revision>/` directory; drop it
    // so the digest describes content, not the archive container.
    hashField(hash, filePath.replace(/^[^/]+\//u, ""), data);
  }
  upstreamLicense(files);
  return hash.digest("hex");
}

export function verifyArchiveContent(files, expected = EXPECTED_ARCHIVE_CONTENT_SHA256) {
  const actual = archiveContentDigest(files);
  if (actual !== expected) {
    throw new Error(
      `The archive content does not match the pinned models.dev snapshot at ${MODELS_DEV_REVISION}; refusing to sync.`,
    );
  }
  return actual;
}

export async function removeStaleLogoFiles(assetDir, expectedFiles) {
  for (const file of readdirSync(assetDir)) {
    if (file.endsWith(".svg") && !expectedFiles.has(file)) {
      await rm(join(assetDir, file));
    }
  }
}

/**
 * Validates the explicitly authored local marks (currently the OpenCode Go G
 * artwork). They are not regenerated from models.dev; provenance, byte count,
 * hash and SVG safety are pinned here so a drift fails `--check`.
 */
function validateLocalOverrides(assetDir) {
  const overridesPath = join(assetDir, LOCAL_OVERRIDES_FILE);
  if (!existsSync(overridesPath)) throw new Error(`Missing local overrides ${overridesPath}`);
  const metadata = JSON.parse(readFileSync(overridesPath, "utf8"));
  if (metadata.repository !== OPENCODE_REPOSITORY) {
    throw new Error("The local OpenCode artwork repository is not pinned");
  }
  if (metadata.commit !== OPENCODE_COMMIT) {
    throw new Error("The local OpenCode artwork commit is not pinned");
  }
  if (metadata.license !== "MIT") throw new Error("The local OpenCode artwork license is not MIT");
  if (metadata.sourceSpriteSha256 !== OPENCODE_SPRITE_SHA256) {
    throw new Error("The local OpenCode sprite hash is not pinned");
  }

  const logos = new Map();
  for (const [id, entry] of Object.entries(metadata.logos ?? {})) {
    if (!SAFE_PROVIDER_ID.test(id) || id.includes("..") || id === GENERIC_LOGO_FILE) {
      throw new Error(`Unsafe local provider logo id: ${id}`);
    }
    if (entry.url !== `/assets/providers/${id}.svg` || !SAFE_LOGO_URL.test(entry.url)) {
      throw new Error(`${id}: local logo URL is not the allowlisted local path`);
    }
    if (entry.sourcePath !== OPENCODE_SOURCE_PATH || entry.sourceSymbol !== "opencode-go") {
      throw new Error(`${id}: local artwork provenance is not the pinned OpenCode symbol`);
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) {
      throw new Error(`${id}: local logo byte count is invalid`);
    }
    if (typeof entry.label !== "string" || entry.label.trim() === "") {
      throw new Error(`${id}: local logo label is empty`);
    }
    const file = join(assetDir, `${id}.svg`);
    if (!existsSync(file)) throw new Error(`${id}: local logo is missing`);
    const bytes = readFileSync(file);
    if (bytes.length !== entry.bytes) throw new Error(`${id}: local logo byte count changed`);
    if (sha256(bytes) !== entry.sha256) throw new Error(`${id}: local logo hash changed`);
    inspectSvgSafety(bytes.toString("utf8"), id);
    logos.set(id, entry);
  }

  if (logos.size !== EXPECTED_LOCAL_LOGO_COUNT || !logos.has("opencode-go-g")) {
    throw new Error(`Expected the local OpenCode Go mark, found ${logos.size} local logos`);
  }

  const licensePath = join(assetDir, OPENCODE_LICENSE_FILE);
  if (!existsSync(licensePath)) throw new Error(`Missing OpenCode license ${licensePath}`);
  const license = readFileSync(licensePath);
  if (sha256(license) !== OPENCODE_LICENSE_SHA256) {
    throw new Error("The OpenCode MIT license text is missing or altered");
  }
  const noticePath = join(assetDir, OPENCODE_NOTICE_FILE);
  if (!existsSync(noticePath)) throw new Error(`Missing OpenCode artwork notice ${noticePath}`);
  const notice = readFileSync(noticePath, "utf8");
  if (!notice.includes(OPENCODE_COMMIT) || !notice.includes(OPENCODE_SOURCE_PATH)) {
    throw new Error("The OpenCode artwork notice is missing its pinned provenance");
  }
  return { logos, metadata };
}

async function writeIfChanged(file, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (existsSync(file) && readFileSync(file).equals(bytes)) return false;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return true;
}

async function sync(archivePath) {
  const archive = archivePath ? readArchiveFrom(archivePath) : await fetchPinnedArchive();
  const files = readTarFiles(archive);
  verifyArchiveContent(files);
  const { logos, tomls } = idsFromArchive(files);
  if (logos.size !== EXPECTED_LOGO_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_LOGO_COUNT} upstream logos at ${MODELS_DEV_REVISION}, found ${logos.size}`,
    );
  }
  const upstreamBytes = [...logos.values()].reduce((total, bytes) => total + bytes.length, 0);
  if (upstreamBytes !== EXPECTED_UPSTREAM_BYTES) {
    throw new Error(
      `Expected ${EXPECTED_UPSTREAM_BYTES} upstream logo bytes, found ${upstreamBytes}`,
    );
  }

  const assetDir = join(scriptRoot, PROVIDER_LOGO_DIR);
  await mkdir(assetDir, { recursive: true });
  const localOverrides = validateLocalOverrides(assetDir);
  for (const id of localOverrides.logos.keys()) {
    if (logos.has(id) || id === GENERIC_LOGO_FILE) {
      throw new Error(`Local provider logo collides with upstream/generic id: ${id}`);
    }
  }
  const entries = new Map();
  let logoBytes = 0;
  for (const [id, bytes] of [...logos].sort(([left], [right]) => left.localeCompare(right))) {
    if (!SAFE_PROVIDER_ID.test(id) || id.includes("..")) {
      throw new Error(`Refusing an unsafe upstream provider id: ${id}`);
    }
    const source = normalizedSvg(bytes, id);
    inspectSvgSafety(source, id);
    const written = Buffer.from(source, "utf8");
    await writeIfChanged(join(assetDir, `${id}.svg`), written);
    logoBytes += written.length;
    entries.set(id, {
      label: labelFor(id, tomls.get(id)),
      bytes: written.length,
      sha256: sha256(written),
    });
  }

  const genericPath = join(assetDir, GENERIC_LOGO_FILE);
  if (!existsSync(genericPath)) throw new Error(`Missing local fallback ${genericPath}`);
  inspectSvgSafety(readFileSync(genericPath, "utf8"), GENERIC_LOGO_FILE);

  const expectedFiles = new Set([...entries.keys()].map((id) => `${id}.svg`));
  expectedFiles.add(GENERIC_LOGO_FILE);
  for (const id of localOverrides.logos.keys()) expectedFiles.add(`${id}.svg`);
  await removeStaleLogoFiles(assetDir, expectedFiles);

  const runtimeCatalog = buildRuntimeCatalog(entries);
  const integrityManifest = buildIntegrityManifest(entries, upstreamBytes, logoBytes);
  for (const entry of Object.values(runtimeCatalog.logos)) {
    if (!SAFE_LOGO_URL.test(entry.url)) throw new Error(`Unsafe catalog URL ${entry.url}`);
  }
  await writeIfChanged(join(scriptRoot, GENERATED_CATALOG_PATH), canonicalJson(runtimeCatalog));
  await writeIfChanged(join(assetDir, "manifest.json"), canonicalJson(integrityManifest));
  await writeIfChanged(join(assetDir, "UPSTREAM-MIT.txt"), upstreamLicense(files));
  await writeIfChanged(join(assetDir, "NOTICE.md"), buildNotice(entries.size));

  console.log(
    `Provider logos synced: ${entries.size} SVGs (${logoBytes} vendored bytes; ${upstreamBytes} upstream bytes) from models.dev@${MODELS_DEV_REVISION}, plus ${GENERIC_LOGO_FILE}, ${localOverrides.logos.size} local override(s), MIT notice and brand notice.`,
  );
}

async function check() {
  const assetDir = join(scriptRoot, PROVIDER_LOGO_DIR);
  const manifest = JSON.parse(await readFile(join(assetDir, "manifest.json"), "utf8"));
  const runtimeCatalog = JSON.parse(
    await readFile(join(scriptRoot, GENERATED_CATALOG_PATH), "utf8"),
  );
  if (
    manifest.revision !== MODELS_DEV_REVISION ||
    runtimeCatalog.revision !== MODELS_DEV_REVISION
  ) {
    throw new Error("Provider logo manifests are not pinned to the expected models.dev revision");
  }
  if (manifest.source !== "models.dev" || runtimeCatalog.source !== "models.dev") {
    throw new Error("Provider logo manifests do not name models.dev as their source");
  }
  if (manifest.repository !== MODELS_DEV_REPOSITORY) {
    throw new Error("Provider logo manifest repository is not the pinned models.dev repository");
  }
  if (manifest.logoCount !== EXPECTED_LOGO_COUNT) {
    throw new Error(`Expected ${EXPECTED_LOGO_COUNT} vendored logos, found ${manifest.logoCount}`);
  }
  const ids = Object.keys(manifest.logos).sort();
  const runtimeIds = Object.keys(runtimeCatalog.logos).sort();
  if (JSON.stringify(ids) !== JSON.stringify(runtimeIds)) {
    throw new Error("The runtime catalog and the integrity manifest list different providers");
  }
  const localOverrides = validateLocalOverrides(assetDir);
  for (const id of localOverrides.logos.keys()) {
    if (manifest.logos[id] !== undefined || runtimeCatalog.logos[id] !== undefined) {
      throw new Error(`Local provider logo collides with upstream id: ${id}`);
    }
  }

  let logoBytes = 0;
  for (const id of ids) {
    const entry = manifest.logos[id];
    const file = join(assetDir, `${id}.svg`);
    if (!SAFE_PROVIDER_ID.test(id) || !SAFE_LOGO_URL.test(entry.url)) {
      throw new Error(`${id}: unsafe provider id or catalog URL`);
    }
    if (entry.url !== `/assets/providers/${id}.svg`) {
      throw new Error(`${id}: catalog URL is not the allowlisted local path`);
    }
    if (!existsSync(file)) throw new Error(`${id}: vendored logo is missing`);
    const bytes = readFileSync(file);
    if (bytes.length !== entry.bytes) throw new Error(`${id}: vendored logo byte count changed`);
    if (sha256(bytes) !== entry.sha256) throw new Error(`${id}: vendored logo hash changed`);
    inspectSvgSafety(bytes.toString("utf8"), id);
    if (runtimeCatalog.logos[id].label !== entry.label) {
      throw new Error(`${id}: runtime label differs from the integrity manifest`);
    }
    logoBytes += bytes.length;
  }
  if (logoBytes !== manifest.logoBytes) throw new Error("Provider logo byte total changed");
  if (manifest.upstreamBytes !== EXPECTED_UPSTREAM_BYTES) {
    throw new Error("Provider logo upstream byte total is not the pinned value");
  }

  const files = readdirSync(assetDir);
  const actualSvg = files.filter((file) => file.endsWith(".svg")).sort();
  const expectedSvg = [
    ...ids.map((id) => `${id}.svg`),
    ...localOverrides.logos.keys().map((id) => `${id}.svg`),
    GENERIC_LOGO_FILE,
  ].sort();
  if (JSON.stringify(actualSvg) !== JSON.stringify(expectedSvg)) {
    throw new Error("The provider logo directory has missing or stale SVG files");
  }
  inspectSvgSafety(readFileSync(join(assetDir, GENERIC_LOGO_FILE), "utf8"), GENERIC_LOGO_FILE);

  const license = await readFile(join(assetDir, "UPSTREAM-MIT.txt"), "utf8");
  if (
    !license.includes("MIT License") ||
    !license.includes("Copyright (c) 2025 models.dev") ||
    !license.includes("Permission is hereby granted, free of charge") ||
    !license.includes("THE SOFTWARE IS PROVIDED")
  ) {
    throw new Error("The upstream MIT notice is missing or altered");
  }
  const notice = await readFile(join(assetDir, "NOTICE.md"), "utf8");
  if (notice !== buildNotice(ids.length)) {
    throw new Error("The brand-rights notice is not the deterministic output of the sync");
  }

  const expectedRuntime = canonicalJson(
    buildRuntimeCatalog(
      new Map(
        ids.map((id) => [id, { label: manifest.logos[id].label, url: manifest.logos[id].url }]),
      ),
    ),
  );
  if (canonicalJson(runtimeCatalog) !== expectedRuntime) {
    throw new Error("The generated runtime catalog is not the deterministic output of the sync");
  }
  console.log(
    `Provider logos verified: ${ids.length} upstream SVGs (${logoBytes} vendored bytes) plus ${GENERIC_LOGO_FILE} and ${localOverrides.logos.size} local override(s); safe SVG checks, local URLs, MIT notice and brand notice all match models.dev@${MODELS_DEV_REVISION}.`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const archiveIndex = args.indexOf("--archive");
  const archivePath = archiveIndex === -1 ? undefined : args[archiveIndex + 1];
  if (archiveIndex !== -1 && archivePath === undefined) {
    throw new Error("--archive needs a path");
  }
  if (checkOnly) {
    await check();
    return;
  }
  await sync(archivePath);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

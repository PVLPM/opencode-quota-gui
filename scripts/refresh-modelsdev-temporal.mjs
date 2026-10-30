import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

/**
 * Build-time extractor for models.dev schema v2 temporal pricing metadata.
 * Runtime code reads the bundled JSON only; this script performs the only
 * upstream network access. Refreshes resolve the current upstream revision and
 * discover every provider model TOML from that revision's source archive.
 */

export const TEMPORAL_REPOSITORY = "anomalyco/models.dev";
export const TEMPORAL_REVISION = "74ea3010646df6952827998d7b7b74bf062f3a00";
export const TEMPORAL_REVISION_GENERATED_AT = 1_793_381_149_000;
export const TEMPORAL_SOURCE = temporalSourceUrl(TEMPORAL_REVISION);
export const TEMPORAL_COMMITS_ATOM_URL = `https://github.com/${TEMPORAL_REPOSITORY}/commits.atom`;
const ARCHIVE_ROOT = `https://codeload.github.com/${TEMPORAL_REPOSITORY}/tar.gz`;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const CN_SOURCE = "https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html";
const CN_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const RUNTIME_MODULE_URL = new URL("../src/lib/modelsdev-temporal.ts", import.meta.url);
const execFileAsync = promisify(execFile);

export function temporalSourceUrl(revision) {
  return `https://github.com/${TEMPORAL_REPOSITORY}/tree/${revision}`;
}

export function temporalArchiveUrl(revision) {
  return `${ARCHIVE_ROOT}/${revision}`;
}

const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const HOLIDAYS = ["CN", "US", "CA"];
const HOUR_OPERATORS = new Set(["equals", "in", "gt", "gte", "lt", "lte"]);
const CHOICE_OPERATORS = new Set(["equals", "in"]);
const CONDITION_KEYS = new Set(["all", "any", "not", "utc_hours", "utc_days", "holiday"]);
const UNSUPPORTED_TEMPORAL_KEYS = new Set(["date"]);

function civilMidnight(date, label) {
  if (!DATE_PATTERN.test(date)) throw new Error(`${label} must be YYYY-MM-DD`);
  const parsed = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid date`);
  const roundTrip = new Date(parsed + CN_UTC_OFFSET_MS).toISOString().slice(0, 10);
  if (roundTrip !== date) throw new Error(`${label} is not a valid date`);
  return parsed;
}

function cnInterval(id, localStart, localEnd) {
  return {
    id,
    localStart,
    localEnd,
    startMs: civilMidnight(localStart, `${id}.localStart`),
    endMs: civilMidnight(localEnd, `${id}.localEnd`),
  };
}

// State Council of the People's Republic of China, Guoban Fadian [2025] No. 7.
// National (full-jurisdiction) 2026 public-holiday intervals and make-up workdays.
const CN_2026 = {
  timeZone: "Asia/Shanghai",
  source: CN_SOURCE,
  published: "2025-11-04",
  intervals: [
    cnInterval("new-year", "2026-01-01", "2026-01-04"),
    cnInterval("spring-festival", "2026-02-15", "2026-02-24"),
    cnInterval("qingming", "2026-04-04", "2026-04-07"),
    cnInterval("labour-day", "2026-05-01", "2026-05-06"),
    cnInterval("dragon-boat-festival", "2026-06-19", "2026-06-22"),
    cnInterval("mid-autumn-festival", "2026-09-25", "2026-09-28"),
    cnInterval("national-day", "2026-10-01", "2026-10-08"),
  ],
  makeupWorkdays: [
    "2026-01-04",
    "2026-02-14",
    "2026-02-28",
    "2026-05-09",
    "2026-09-20",
    "2026-10-10",
  ],
};

function stripComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function splitKeyValue(line, lineNumber) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "=") {
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }
  }
  throw new Error(`TOML line ${lineNumber} is missing '='`);
}

function parseQuotedString(text, start) {
  const quote = text[start];
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (quote === "'") {
      if (character === "'") return [value, index + 1];
      value += character;
      index += 1;
      continue;
    }
    if (character === '"') return [value, index + 1];
    if (character !== "\\") {
      value += character;
      index += 1;
      continue;
    }
    const escapeCode = text[index + 1];
    const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (escapeCode in simple) {
      value += simple[escapeCode];
      index += 2;
      continue;
    }
    if (escapeCode === "u" || escapeCode === "U") {
      const length = escapeCode === "u" ? 4 : 8;
      const hex = text.slice(index + 2, index + 2 + length);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== length) {
        throw new Error("Invalid TOML unicode escape");
      }
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      index += 2 + length;
      continue;
    }
    throw new Error(`Unsupported TOML escape \\${escapeCode}`);
  }
  throw new Error("Unterminated TOML string");
}

function skipWhitespace(text, start) {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

function parseKeyAt(text, start) {
  const index = skipWhitespace(text, start);
  if (text[index] === '"' || text[index] === "'") {
    return parseQuotedString(text, index);
  }
  let end = index;
  while (end < text.length && /[A-Za-z0-9_.-]/.test(text[end])) end += 1;
  if (end === index) throw new Error("TOML key is empty");
  return [text.slice(index, end), end];
}

function parseNumberAt(text, start) {
  const match = /^[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/.exec(text.slice(start));
  if (!match) throw new Error(`Invalid TOML number at ${start}`);
  return [Number(match[0].replaceAll("_", "")), start + match[0].length];
}

function parseValueAt(text, start) {
  const index = skipWhitespace(text, start);
  const character = text[index];
  if (character === '"' || character === "'") return parseQuotedString(text, index);
  if (character === "[") {
    const values = [];
    let cursor = skipWhitespace(text, index + 1);
    while (cursor < text.length && text[cursor] !== "]") {
      const [value, next] = parseValueAt(text, cursor);
      values.push(value);
      cursor = skipWhitespace(text, next);
      if (text[cursor] === ",") cursor = skipWhitespace(text, cursor + 1);
      else if (text[cursor] !== "]") throw new Error("Invalid TOML array");
    }
    if (text[cursor] !== "]") throw new Error("Unterminated TOML array");
    return [values, cursor + 1];
  }
  if (character === "{") {
    const value = {};
    let cursor = skipWhitespace(text, index + 1);
    while (cursor < text.length && text[cursor] !== "}") {
      const [rawKey, afterKey] = parseKeyAt(text, cursor);
      const equals = skipWhitespace(text, afterKey);
      if (text[equals] !== "=") throw new Error("Invalid TOML inline table");
      const [fieldValue, afterValue] = parseValueAt(text, equals + 1);
      value[rawKey] = fieldValue;
      cursor = skipWhitespace(text, afterValue);
      if (text[cursor] === ",") cursor = skipWhitespace(text, cursor + 1);
      else if (text[cursor] !== "}") throw new Error("Invalid TOML inline table");
    }
    if (text[cursor] !== "}") throw new Error("Unterminated TOML inline table");
    return [value, cursor + 1];
  }
  if (text.startsWith("true", index)) return [true, index + 4];
  if (text.startsWith("false", index)) return [false, index + 5];
  return parseNumberAt(text, index);
}

function parseValue(text, lineNumber) {
  const [value, end] = parseValueAt(text, 0);
  if (skipWhitespace(text, end) !== text.length) {
    throw new Error(`TOML line ${lineNumber} has trailing content`);
  }
  return value;
}

function ensureObject(parent, key, lineNumber) {
  if (parent[key] === undefined) parent[key] = {};
  if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) {
    throw new Error(`TOML line ${lineNumber} conflicts with ${key}`);
  }
  return parent[key];
}

function setTablePath(root, path, arrayItem, lineNumber) {
  const segments = path.split(".");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) throw new Error(`TOML line ${lineNumber} has an empty table segment`);
    if (index === segments.length - 1) {
      if (arrayItem) {
        if (current[segment] === undefined) current[segment] = [];
        if (!Array.isArray(current[segment])) {
          throw new Error(`TOML line ${lineNumber} conflicts with ${segment}`);
        }
        const item = {};
        current[segment].push(item);
        return item;
      }
      return ensureObject(current, segment, lineNumber);
    }
    current = ensureObject(current, segment, lineNumber);
  }
  throw new Error(`TOML line ${lineNumber} has an empty table path`);
}

function hasUnclosedValue(text) {
  let quote = null;
  let escaped = false;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
  }
  return quote !== null || square > 0 || curly > 0;
}

export function parseTomlSubset(text) {
  const root = {};
  let current = root;
  const lines = text.split(/\r?\n/);
  let logical = "";
  let logicalStart = 0;

  const processLine = (line, lineNumber) => {
    if (line.startsWith("[[")) {
      if (!line.endsWith("]]")) throw new Error(`TOML line ${lineNumber} has a bad table header`);
      current = setTablePath(root, line.slice(2, -2).trim(), true, lineNumber);
      return;
    }
    if (line.startsWith("[")) {
      if (!line.endsWith("]")) throw new Error(`TOML line ${lineNumber} has a bad table header`);
      current = setTablePath(root, line.slice(1, -1).trim(), false, lineNumber);
      return;
    }
    const [rawKey, rawValue] = splitKeyValue(line, lineNumber);
    const [key, end] = parseKeyAt(rawKey, 0);
    if (end !== rawKey.length) {
      throw new Error(`TOML line ${lineNumber} has a bad key`);
    }
    current[key] = parseValue(rawValue, lineNumber);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const stripped = stripComment(lines[index]).trim();
    if (stripped.length === 0) continue;
    if (logical.length === 0) logicalStart = lineNumber;
    logical = logical.length === 0 ? stripped : `${logical} ${stripped}`;
    if (hasUnclosedValue(logical)) continue;
    processLine(logical, logicalStart);
    logical = "";
  }
  if (logical.length > 0) throw new Error(`TOML line ${logicalStart} is incomplete`);
  return root;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseClock(value, label) {
  if (typeof value !== "string" || !CLOCK_PATTERN.test(value)) {
    throw new Error(`${label} must be a UTC HH:MM clock`);
  }
  const [hours, minutes] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText);
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function conditionRank(condition) {
  switch (condition.type) {
    case "utc_days":
      return 0;
    case "utc_hours":
      return 1;
    case "holiday":
      return 2;
    case "not":
      return 3;
    case "all":
      return 4;
    case "any":
      return 5;
    default:
      return 6;
  }
}

function canonicalConditions(conditions) {
  return [...conditions].sort((a, b) => {
    const rank = conditionRank(a) - conditionRank(b);
    if (rank !== 0) return rank;
    return JSON.stringify(a) === JSON.stringify(b)
      ? 0
      : compareText(JSON.stringify(a), JSON.stringify(b));
  });
}

function parseChoice(raw, allowed, label, type) {
  if (!isObject(raw)) throw new Error(`${label} must be an object`);
  const keys = Object.keys(raw);
  if (keys.length !== 1 || !CHOICE_OPERATORS.has(keys[0])) {
    throw new Error(`${label} must use exactly one of equals or in`);
  }
  const operator = keys[0];
  if (operator === "equals") {
    if (typeof raw.equals !== "string" || !allowed.includes(raw.equals)) {
      throw new Error(`${label}.equals is not a supported value`);
    }
    return { type, op: "equals", value: raw.equals };
  }
  if (!Array.isArray(raw.in) || raw.in.length === 0) {
    throw new Error(`${label}.in must be a non-empty array`);
  }
  for (const value of raw.in) {
    if (typeof value !== "string" || !allowed.includes(value)) {
      throw new Error(`${label}.in contains an unsupported value`);
    }
  }
  return { type, op: "in", value: sortedUnique(raw.in) };
}

function parseHours(raw, label) {
  if (!isObject(raw)) throw new Error(`${label} must be an object`);
  const keys = Object.keys(raw);
  if (keys.length !== 1 || !HOUR_OPERATORS.has(keys[0])) {
    throw new Error(`${label} must use exactly one supported UTC hour operator`);
  }
  const operator = keys[0];
  if (operator === "in") {
    if (!Array.isArray(raw.in) || raw.in.length === 0) {
      throw new Error(`${label}.in must be a non-empty array`);
    }
    for (const value of raw.in) parseClock(value, `${label}.in`);
    return { type: "utc_hours", op: "in", value: sortedUnique(raw.in) };
  }
  parseClock(raw[operator], `${label}.${operator}`);
  return { type: "utc_hours", op: operator, value: raw[operator] };
}

function analyzeNode(raw, label, depth) {
  if (depth > 8) {
    return { temporal: false, reason: `${label} is nested too deeply` };
  }
  if (!isObject(raw)) {
    return { temporal: false, reason: `${label} must be an object` };
  }
  const parts = [];
  let temporal = false;
  let reason = null;

  for (const [key, value] of Object.entries(raw)) {
    if (key === "all" || key === "any") {
      if (!Array.isArray(value) || value.length === 0) {
        return { temporal: false, reason: `${label}.${key} must be a non-empty array` };
      }
      const children = value.map((child, index) =>
        analyzeNode(child, `${label}.${key}[${index}]`, depth + 1),
      );
      const childReason = children.find((child) => child.reason);
      if (childReason) reason = reason ?? childReason.reason;
      const temporalChildren = children.filter((child) => child.temporal);
      const supportedChildren = temporalChildren.filter((child) => child.condition !== undefined);
      if (temporalChildren.length > 0) {
        temporal = true;
        if (temporalChildren.length !== children.length) {
          reason = reason ?? `${label}.${key} mixes temporal and non-temporal conditions`;
        }
        if (supportedChildren.length > 0) {
          parts.push({
            type: key,
            of: canonicalConditions(supportedChildren.map((child) => child.condition)),
          });
        }
      } else if (childReason === undefined) {
        reason = reason ?? `${label}.${key} has no temporal condition`;
      }
      continue;
    }
    if (key === "not") {
      const child = analyzeNode(value, `${label}.not`, depth + 1);
      if (child.temporal) {
        temporal = true;
        if (child.reason) reason = reason ?? child.reason;
        parts.push({ type: "not", of: child.condition });
      } else if (child.reason) {
        reason = reason ?? child.reason;
      } else {
        reason = reason ?? `${label}.not has no temporal condition`;
      }
      continue;
    }
    if (UNSUPPORTED_TEMPORAL_KEYS.has(key)) {
      temporal = true;
      reason = reason ?? `unsupported temporal condition key: ${key}`;
      continue;
    }
    if (key === "utc_hours") {
      temporal = true;
      try {
        parts.push(parseHours(value, `${label}.utc_hours`));
      } catch (error) {
        reason = reason ?? error.message;
      }
      continue;
    }
    if (key === "utc_days") {
      temporal = true;
      try {
        parts.push(parseChoice(value, DAYS, `${label}.utc_days`, "utc_days"));
      } catch (error) {
        reason = reason ?? error.message;
      }
      continue;
    }
    if (key === "holiday") {
      temporal = true;
      try {
        parts.push(parseChoice(value, HOLIDAYS, `${label}.holiday`, "holiday"));
      } catch (error) {
        reason = reason ?? error.message;
      }
      continue;
    }
    if (!CONDITION_KEYS.has(key)) {
      reason = reason ?? `unsupported condition key: ${key}`;
    }
  }

  if (!temporal) return { temporal: false, reason };
  if (reason) return { temporal: true, reason };
  if (parts.length === 0) return { temporal: true, reason: `${label} has no temporal condition` };
  return {
    temporal: true,
    condition: parts.length === 1 ? parts[0] : { type: "all", of: canonicalConditions(parts) },
  };
}

function analyzeWhen(raw) {
  const result = analyzeNode(raw, "when", 0);
  if (!result.temporal) return { temporal: false };
  if (result.reason) return { temporal: true, reason: result.reason };
  return { temporal: true, condition: result.condition };
}

function parseRate(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function parseOverrideRates(raw, field, label) {
  if (!isObject(raw)) throw new Error(`${label} must be an object`);
  const allowed = field === "input" ? ["when", "price", "cache"] : ["when", "price", "reasoning"];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is not supported`);
  }
  const rates = {};
  if ("price" in raw) rates[field] = parseRate(raw.price, `${label}.price`);
  if (field === "input" && "cache" in raw) {
    if (!isObject(raw.cache)) throw new Error(`${label}.cache must be an object`);
    for (const key of Object.keys(raw.cache)) {
      if (key !== "read" && key !== "write") {
        throw new Error(`${label}.cache.${key} is not supported`);
      }
    }
    if ("read" in raw.cache) {
      rates.cache_read = parseRate(raw.cache.read, `${label}.cache.read`);
    }
    if ("write" in raw.cache) {
      rates.cache_write = parseRate(raw.cache.write, `${label}.cache.write`);
    }
  }
  if (field === "output" && "reasoning" in raw) {
    rates.reasoning = parseRate(raw.reasoning, `${label}.reasoning`);
  }
  if (Object.keys(rates).length === 0) throw new Error(`${label} must set at least one rate`);
  return rates;
}

function parseFactor(raw, label) {
  if (typeof raw === "number") return parseRate(raw, label);
  if (!isObject(raw)) throw new Error(`${label} must be a number or { text = number }`);
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "text") {
    throw new Error(`${label} only supports the text factor`);
  }
  return { text: parseRate(raw.text, `${label}.text`) };
}

function sortedRates(rates) {
  const out = {};
  for (const key of ["input", "output", "cache_read", "cache_write", "reasoning"]) {
    if (key in rates) out[key] = rates[key];
  }
  return out;
}

export function extractTemporalModel(providerId, modelId, sourcePath, text) {
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw new Error("providerId is required");
  }
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new Error("modelId is required");
  }
  const expectedSource = `providers/${providerId}/models/${modelId}.toml`;
  if (sourcePath !== expectedSource) {
    throw new Error(`${sourcePath} does not match ${expectedSource}`);
  }
  const parsed = parseTomlSubset(text);
  const overrides = [];
  const multipliers = [];
  let unsupportedReason = null;
  let sawNonTemporalRule = false;

  for (const field of ["input", "output"]) {
    const rawOverrides = parsed.cost?.text?.[field]?.overrides;
    if (rawOverrides === undefined) continue;
    if (!Array.isArray(rawOverrides)) {
      unsupportedReason = unsupportedReason ?? `cost.text.${field}.overrides must be an array`;
      continue;
    }
    for (let index = 0; index < rawOverrides.length; index += 1) {
      const raw = rawOverrides[index];
      const label = `cost.text.${field}.overrides[${index}]`;
      if (!isObject(raw)) {
        unsupportedReason = unsupportedReason ?? `${label} must be an object`;
        continue;
      }
      const when = analyzeWhen(raw.when);
      if (!when.temporal) {
        if (when.reason) unsupportedReason = unsupportedReason ?? when.reason;
        else sawNonTemporalRule = true;
        continue;
      }
      if (when.reason) {
        unsupportedReason = unsupportedReason ?? when.reason;
        continue;
      }
      try {
        const rates = parseOverrideRates(raw, field, label);
        overrides.push({
          id: `text.${field}.overrides[${index}]`,
          field,
          when: when.condition,
          rates: sortedRates(rates),
        });
      } catch (error) {
        unsupportedReason = unsupportedReason ?? error.message;
      }
    }
  }

  const rawMultipliers = parsed.cost?.multipliers;
  if (rawMultipliers !== undefined) {
    if (!Array.isArray(rawMultipliers)) {
      unsupportedReason = unsupportedReason ?? "cost.multipliers must be an array";
    } else {
      for (let index = 0; index < rawMultipliers.length; index += 1) {
        const raw = rawMultipliers[index];
        const label = `cost.multipliers[${index}]`;
        if (!isObject(raw)) {
          unsupportedReason = unsupportedReason ?? `${label} must be an object`;
          continue;
        }
        const when = analyzeWhen(raw.when);
        if (!when.temporal) {
          if (when.reason) unsupportedReason = unsupportedReason ?? when.reason;
          else sawNonTemporalRule = true;
          continue;
        }
        if (when.reason) {
          unsupportedReason = unsupportedReason ?? when.reason;
          continue;
        }
        try {
          multipliers.push({
            id: `multipliers[${index}]`,
            when: when.condition,
            factor: parseFactor(raw.factor, `${label}.factor`),
          });
        } catch (error) {
          unsupportedReason = unsupportedReason ?? error.message;
        }
      }
    }
  }

  if (overrides.length === 0 && multipliers.length === 0 && unsupportedReason === null) {
    return null;
  }
  if (
    unsupportedReason === null &&
    sawNonTemporalRule &&
    (overrides.length > 0 || multipliers.length > 0)
  ) {
    unsupportedReason = "model mixes temporal and non-temporal cost rules";
  }
  if (unsupportedReason !== null) {
    return { status: "unsupported", source: sourcePath, reason: unsupportedReason };
  }
  return { status: "supported", source: sourcePath, overrides, multipliers };
}

function sortObject(record) {
  const out = {};
  for (const key of Object.keys(record).sort(compareText)) {
    out[key] = record[key];
  }
  return out;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseSourceRoute(path) {
  if (typeof path !== "string") return null;
  const match = /^providers\/([^/]+)\/models\/(.+)\.toml$/.exec(path);
  if (!match) return null;
  const provider = match[1];
  const modelId = match[2];
  if (
    provider.length === 0 ||
    provider === "." ||
    provider === ".." ||
    modelId.includes("\\") ||
    modelId.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  return { provider, modelId };
}

function assertSnapshotForWrite(snapshot) {
  if (snapshot?.version !== 1) throw new Error("temporal snapshot version must be 1");
  if (!REVISION_PATTERN.test(snapshot.revision)) {
    throw new Error(`temporal snapshot revision must be a full git revision`);
  }
  if (snapshot.source !== temporalSourceUrl(snapshot.revision)) {
    throw new Error("temporal snapshot source must match its revision");
  }
  if (!Number.isSafeInteger(snapshot.generatedAt) || snapshot.generatedAt <= 0) {
    throw new Error("temporal snapshot generatedAt must be a positive safe integer");
  }
  if (!snapshot.jurisdictions?.CN?.["2026"]) {
    throw new Error("temporal snapshot must bundle CN 2026");
  }
  const providers = Object.keys(snapshot.providers ?? {});
  if (providers.length === 0) throw new Error("temporal snapshot has no providers");
  const serialized = JSON.stringify(snapshot);
  if (JSON.stringify(JSON.parse(serialized)) !== serialized) {
    throw new Error("temporal snapshot is not deterministically serializable");
  }
  return snapshot;
}

/**
 * Validate a candidate with the exact same schema the runtime uses before it can
 * replace the bundled snapshot. The runtime module is TypeScript, so the check
 * runs in a child Node process with type stripping enabled.
 */
export async function assertRuntimeTemporalSnapshot(snapshot) {
  const directory = await mkdtemp(join(tmpdir(), "modelsdev-temporal-runtime-"));
  const candidatePath = join(directory, "snapshot.json");
  try {
    await writeFile(candidatePath, JSON.stringify(snapshot), "utf8");
    const script = [
      'import { readFileSync } from "node:fs";',
      `import { normalizeTemporalSnapshot } from ${JSON.stringify(RUNTIME_MODULE_URL.href)};`,
      'const raw = JSON.parse(readFileSync(process.argv[1], "utf8"));',
      "normalizeTemporalSnapshot(raw);",
    ].join("\n");
    try {
      await execFileAsync(
        process.execPath,
        [
          "--no-warnings",
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          script,
          candidatePath,
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (error) {
      const detail =
        error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
          ? error.stderr.trim() || error.message
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(`temporal snapshot rejected by the full runtime schema: ${detail}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function buildTemporalSnapshot(files, options = {}) {
  const revision = options.revision;
  if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) {
    throw new Error(`revision must be a full 40-character git commit, got ${revision}`);
  }
  const generatedAt = options.generatedAt;
  if (!Number.isSafeInteger(generatedAt) || generatedAt <= 0) {
    throw new Error("generatedAt is required when building a temporal snapshot");
  }
  if (!Array.isArray(files)) throw new Error("files must be an array");
  const providers = {};
  const seen = new Set();

  for (const file of files) {
    if (!isObject(file)) throw new Error("each source file must be an object");
    const providerId = file.provider;
    const path = file.path;
    const text = file.text;
    if (typeof providerId !== "string" || typeof path !== "string" || typeof text !== "string") {
      throw new Error("each source file needs provider, path and text");
    }
    const route = parseSourceRoute(path);
    if (!route || route.provider !== providerId) {
      throw new Error(`${path} is not under provider ${providerId}`);
    }
    const modelId = route.modelId;
    const key = `${providerId}/${modelId}`;
    if (seen.has(key)) throw new Error(`duplicate temporal source route: ${key}`);
    seen.add(key);
    let entry;
    try {
      entry = extractTemporalModel(providerId, modelId, path, text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${path}: ${detail}`);
    }
    if (!entry) continue;
    if (providers[providerId] === undefined) providers[providerId] = {};
    providers[providerId][modelId] = entry;
  }

  const sortedProviders = {};
  for (const providerId of Object.keys(providers).sort(compareText)) {
    sortedProviders[providerId] = sortObject(providers[providerId]);
  }

  const snapshot = assertSnapshotForWrite({
    version: 1,
    revision,
    source: temporalSourceUrl(revision),
    generatedAt,
    jurisdictions: { CN: { 2026: cloneJson(CN_2026) } },
    providers: sortedProviders,
  });
  await assertRuntimeTemporalSnapshot(snapshot);
  return snapshot;
}

async function fetchResponse(url, fetchImpl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "user-agent": "opencode-quota-gui-modelsdev-temporal" },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchText(url, fetchImpl = fetch) {
  return await (await fetchResponse(url, fetchImpl)).text();
}

async function fetchBuffer(url, fetchImpl = fetch) {
  return Buffer.from(await (await fetchResponse(url, fetchImpl)).arrayBuffer());
}

export async function resolveCurrentSourceRevision(fetchImpl = fetch) {
  const atom = await fetchText(TEMPORAL_COMMITS_ATOM_URL, fetchImpl);
  const entryStart = atom.indexOf("<entry>");
  const entryEnd = atom.indexOf("</entry>", entryStart);
  if (entryStart < 0 || entryEnd < 0) {
    throw new Error("Upstream commits feed did not contain a commit entry");
  }
  const entry = atom.slice(entryStart, entryEnd + "</entry>".length);
  const revision = /Grit::Commit\/([0-9a-f]{40})/.exec(entry)?.[1];
  if (!revision) throw new Error("Upstream commits feed did not contain a full git revision");
  const updated = /<updated>([^<]+)<\/updated>/.exec(entry)?.[1];
  const generatedAt = updated ? Date.parse(updated) : Number.NaN;
  if (!Number.isSafeInteger(generatedAt) || generatedAt <= 0) {
    throw new Error("Upstream commits feed did not contain a valid commit timestamp");
  }
  return { revision, generatedAt };
}

export async function resolveRevisionGeneratedAt(revision, fetchImpl = fetch) {
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error(`revision must be a full 40-character git commit, got ${revision}`);
  }
  const patch = await fetchText(
    `https://github.com/${TEMPORAL_REPOSITORY}/commit/${revision}.patch`,
    fetchImpl,
  );
  const date = /^Date: (.+)$/m.exec(patch)?.[1];
  const generatedAt = date ? Date.parse(date) : Number.NaN;
  if (!Number.isSafeInteger(generatedAt) || generatedAt <= 0) {
    throw new Error(`Commit ${revision} did not contain a valid commit timestamp`);
  }
  return generatedAt;
}

export async function discoverLocalSourceRoutes(sourceDir) {
  if (typeof sourceDir !== "string" || sourceDir.length === 0) {
    throw new Error("sourceDir is required");
  }
  const root = resolve(sourceDir);
  const routes = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const routePath = relative(root, fullPath).split(sep).join("/");
      if (parseSourceRoute(routePath)) routes.push(routePath);
    }
  }
  await walk(join(root, "providers"));
  return routes.sort(compareText);
}

async function readLocalSourceFiles(sourceDir, routes) {
  const files = [];
  for (const path of routes) {
    const route = parseSourceRoute(path);
    if (!route) throw new Error(`Invalid temporal source route ${path}`);
    files.push({
      provider: route.provider,
      path,
      text: await readFile(resolve(sourceDir, path), "utf8"),
    });
  }
  return files;
}

function readCString(buffer, start, length) {
  const limit = Math.min(buffer.length, start + length);
  let end = start;
  while (end < limit && buffer[end] !== 0) end += 1;
  return buffer.subarray(start, end).toString("utf8");
}

function parsePaxPath(content) {
  let index = 0;
  while (index < content.length) {
    const space = content.indexOf(0x20, index);
    if (space < 0) return null;
    const length = Number.parseInt(content.subarray(index, space).toString("utf8"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || index + length > content.length) {
      return null;
    }
    const record = content.subarray(index, index + length);
    const payload = record.subarray(space - index + 1);
    const separator = payload.indexOf("=");
    if (separator >= 0) {
      const key = payload.subarray(0, separator).toString("utf8");
      const value = payload
        .subarray(separator + 1)
        .toString("utf8")
        .replace(/\n$/, "");
      if (key === "path") return value;
    }
    index += length;
  }
  return null;
}

function parseTarEntries(buffer) {
  const entries = [];
  let offset = 0;
  let pendingPath = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = readCString(header, 0, 100);
    const sizeText = readCString(header, 124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid tar entry size for ${rawName || "<unnamed>"}`);
    }
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = readCString(header, 345, 155);
    const ustarName = prefix ? `${prefix}/${rawName}` : rawName;
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > buffer.length || contentEnd < contentStart) {
      throw new Error(`Truncated tar entry ${ustarName || "<unnamed>"}`);
    }
    const content = buffer.subarray(contentStart, contentEnd);
    if (type === "x") {
      const path = parsePaxPath(content);
      if (path) pendingPath = path;
    } else if (type === "g") {
      // Global pax headers do not name the following file.
    } else if (type === "L") {
      pendingPath = readCString(content, 0, size);
    } else {
      const name = pendingPath ?? ustarName;
      pendingPath = null;
      if (type === "0" || type === "\0" || type === "7") {
        entries.push({ name, data: content });
      }
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function readSourceArchive(gzBuffer) {
  const entries = parseTarEntries(gunzipSync(gzBuffer));
  if (entries.length === 0) throw new Error("Source archive is empty");
  const root = entries[0].name.split("/")[0];
  const revision = /(?:^|-)([0-9a-f]{40})$/.exec(root)?.[1];
  if (!revision) throw new Error("Source archive root does not contain a full git revision");
  const byPath = new Map();
  for (const entry of entries) {
    if (!entry.name.startsWith(`${root}/`)) continue;
    const path = entry.name.slice(root.length + 1);
    const route = parseSourceRoute(path);
    if (!route) continue;
    if (byPath.has(path)) throw new Error(`Duplicate source archive route: ${path}`);
    byPath.set(path, entry.data.toString("utf8"));
  }
  const files = [...byPath.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([path, text]) => ({ provider: parseSourceRoute(path).provider, path, text }));
  return { revision, files };
}

function isMissingGitRepository(error) {
  if (!error || typeof error !== "object") return false;
  if (error.code === "ENOENT") return true;
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  return /not a git repository/i.test(stderr);
}

function sameFilesystemPath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function runGit(sourceDir, args) {
  return await execFileAsync("git", ["-C", sourceDir, ...args], { maxBuffer: 1024 * 1024 });
}

/**
 * Derive provenance from a git checkout only when `sourceDir` is that checkout's
 * root. A plain directory (or a subdirectory of another repository) returns null
 * so the caller must declare an explicit revision and timestamp.
 */
export async function resolveGitSourceMetadata(sourceDir) {
  let topLevel;
  try {
    topLevel = (await runGit(sourceDir, ["rev-parse", "--show-toplevel"])).stdout.trim();
  } catch (error) {
    if (isMissingGitRepository(error)) return null;
    throw error;
  }
  if (topLevel.length === 0 || !sameFilesystemPath(topLevel, sourceDir)) return null;

  const revision = (await runGit(sourceDir, ["rev-parse", "HEAD"])).stdout.trim();
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error(`sourceDir HEAD is not a full git revision: ${revision}`);
  }
  const timestampText = (
    await runGit(sourceDir, ["show", "-s", "--format=%ct", "HEAD"])
  ).stdout.trim();
  const seconds = Number.parseInt(timestampText, 10);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`sourceDir HEAD timestamp is invalid: ${timestampText}`);
  }
  const status = (
    await runGit(sourceDir, ["status", "--porcelain", "--untracked-files=all", "--", "providers"])
  ).stdout.trim();
  if (status.length > 0) {
    throw new Error(
      "sourceDir providers tree has uncommitted changes; commit them or use an archive",
    );
  }
  return { revision, generatedAt: seconds * 1000 };
}

/**
 * Refresh modes:
 * - no source: resolve the current upstream revision from the commits feed and
 *   download that exact revision's source archive.
 * - `revision`: fetch one pinned remote revision and derive its commit timestamp.
 * - `archivePath`: read a pinned `.tar.gz` offline; the revision is read from the
 *   archive root and must match `revision` when both are supplied.
 * - `sourceDir`: discover routes in an extracted offline tree. Git checkouts
 *   derive and verify HEAD provenance; other trees require an explicit revision
 *   and generatedAt.
 */
export async function refreshTemporalSnapshot(options = {}) {
  const { sourceDir, archivePath, fetchImpl = fetch } = options;
  let revision = options.revision;
  let generatedAt = options.generatedAt;
  let files;

  if (archivePath && sourceDir) {
    throw new Error("Use either archivePath or sourceDir, not both");
  }
  if (archivePath) {
    const archive = readSourceArchive(await readFile(archivePath));
    if (revision !== undefined && revision !== archive.revision) {
      throw new Error(
        `Source archive revision ${archive.revision} does not match requested ${revision}`,
      );
    }
    revision = archive.revision;
    if (generatedAt === undefined && revision === TEMPORAL_REVISION) {
      generatedAt = TEMPORAL_REVISION_GENERATED_AT;
    }
    files = archive.files;
  } else if (sourceDir) {
    const gitMetadata = await resolveGitSourceMetadata(sourceDir);
    if (gitMetadata) {
      if (revision !== undefined && revision !== gitMetadata.revision) {
        throw new Error(
          `sourceDir revision ${gitMetadata.revision} does not match requested ${revision}`,
        );
      }
      if (generatedAt !== undefined && generatedAt !== gitMetadata.generatedAt) {
        throw new Error(
          `sourceDir commit timestamp ${gitMetadata.generatedAt} does not match requested ${generatedAt}`,
        );
      }
      revision = gitMetadata.revision;
      generatedAt = gitMetadata.generatedAt;
    } else {
      if (revision === undefined) {
        throw new Error(
          "sourceDir is not a git checkout; pass revision=<full sha> and generatedAt=<epoch ms> to declare its provenance",
        );
      }
      if (!REVISION_PATTERN.test(revision)) {
        throw new Error(`revision must be a full 40-character git commit, got ${revision}`);
      }
      if (generatedAt === undefined) {
        throw new Error("generatedAt is required when sourceDir is not a git checkout");
      }
    }
    const routes = await discoverLocalSourceRoutes(sourceDir);
    files = await readLocalSourceFiles(sourceDir, routes);
  } else {
    if (revision === undefined) {
      const current = await resolveCurrentSourceRevision(fetchImpl);
      revision = current.revision;
      generatedAt ??= current.generatedAt;
    } else if (!REVISION_PATTERN.test(revision)) {
      throw new Error(`revision must be a full 40-character git commit, got ${revision}`);
    }
    generatedAt ??= await resolveRevisionGeneratedAt(revision, fetchImpl);
    const archive = readSourceArchive(await fetchBuffer(temporalArchiveUrl(revision), fetchImpl));
    if (archive.revision !== revision) {
      throw new Error(
        `Source archive revision ${archive.revision} does not match requested ${revision}`,
      );
    }
    files = archive.files;
  }

  return buildTemporalSnapshot(files, { revision, generatedAt });
}

async function writeFileAtomic(path, content) {
  const dir = dirname(path);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, content, "utf8");
  const safeRm = async (target) => {
    try {
      await rm(target, { force: true });
    } catch {
      // best-effort cleanup
    }
  };
  try {
    await rename(tmp, path);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (!["EPERM", "EEXIST", "EACCES", "ENOTEMPTY"].includes(code)) {
      await safeRm(tmp);
      throw error;
    }
    await safeRm(path);
    await rename(tmp, path);
  }
}

function parseArgs(argv) {
  const value = (name) =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
  const generatedAtRaw = value("generated-at");
  const generatedAt =
    generatedAtRaw === undefined ? undefined : Number.parseInt(generatedAtRaw, 10);
  if (generatedAtRaw !== undefined && (!Number.isSafeInteger(generatedAt) || generatedAt <= 0)) {
    throw new Error("--generated-at must be a positive epoch millisecond");
  }
  return {
    sourceDir: value("source-dir"),
    archivePath: value("archive"),
    revision: value("revision"),
    generatedAt,
    out: value("out"),
  };
}

async function main() {
  const { sourceDir, archivePath, revision, generatedAt, out } = parseArgs(process.argv.slice(2));
  const snapshot = await refreshTemporalSnapshot({
    sourceDir,
    archivePath,
    revision,
    generatedAt,
  });
  const outPath =
    out ?? fileURLToPath(new URL("../src/data/modelsdev-temporal.min.json", import.meta.url));
  await writeFileAtomic(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  let modelCount = 0;
  for (const models of Object.values(snapshot.providers)) modelCount += Object.keys(models).length;
  console.log(
    `Wrote ${outPath} with ${Object.keys(snapshot.providers).length} providers, ${modelCount} temporal models, revision ${snapshot.revision}.`,
  );
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

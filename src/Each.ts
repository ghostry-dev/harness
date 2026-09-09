import { HarnessError } from "./Error";
import { isPollutionKey } from "./Utility";

/**
 * The one context key this library writes itself: `.each` assigns the row onto
 * the context of every test it expands. Named here rather than written inline
 * so `initialize` can reject an integration that also contributes it —
 * otherwise `context.row` would mean one thing inside a `.each` test and
 * another outside one.
 */
export const ROW_KEY = "row";

/**
 * A table row's place in `.each`, closed over at registration so the identity
 * and the body's `row` property agree without asking the runner.
 */
export type EachRow = { readonly index: number; readonly value: unknown };

/**
 * Tagged templates are arrays with a `raw` field. A table array is also an
 * array, so the `raw` own property is the discriminator — not `Array.isArray`.
 */
export function isTaggedTable(value: unknown): value is TemplateStringsArray {
  if (typeof value !== "object" || value === null) return false;
  if (!Array.isArray(value)) return false;
  return Array.isArray((value as { raw?: unknown }).raw);
}

/**
 * Headings from the first non-empty line; values fill cells in heading order.
 * Literal (non-`${}`) cells are not reconstructed — the common form is every
 * cell interpolated, and string-splitting the template would stringify values.
 *
 * A template that yields no rows, or a trailing row with fewer values than
 * headings, is rejected rather than silently truncated: both are the table the
 * author meant to write, mistyped.
 */
export function parseTaggedTable(
  strings: TemplateStringsArray,
  values: ReadonlyArray<unknown>,
): Array<Record<string, unknown>> {
  const headerLine =
    strings[0]?.split("\n").find((line) => line.trim().length > 0) ?? "";

  const headings = headerLine
    .split("|")
    .map((heading) => heading.trim())
    .filter((heading) => heading.length > 0);

  if (headings.length === 0) {
    throw new HarnessError.EachTableError(
      "empty",
      "a tagged template with no headings on its first line",
    );
  }
  if (values.length === 0) {
    throw new HarnessError.EachTableError(
      "empty",
      `a tagged template with headings (${headings.join(" | ")}) but no ` +
        `\${} values`,
    );
  }
  if (values.length % headings.length !== 0) {
    throw new HarnessError.EachTableError(
      "incomplete",
      `${headings.length} headings (${headings.join(" | ")}) but ` +
        `${values.length} values`,
    );
  }

  const rows: Array<Record<string, unknown>> = [];

  for (let offset = 0; offset < values.length; offset += headings.length) {
    const row: Record<string, unknown> = {};

    for (let column = 0; column < headings.length; column++) {
      assignOwn(row, headings[column]!, values[offset + column]);
    }

    rows.push(row);
  }

  return rows;
}

/**
 * A table that resolves to no rows registers no tests, and a suite that ran
 * nothing still reports green — the one failure this package cannot let pass
 * quietly. Rejected here, at the `.each(table)` call, rather than when the
 * registrar is invoked: the table is a setup mistake and is already known.
 */
export function rowsFrom(
  first: unknown,
  rest: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> {
  if (isTaggedTable(first)) return parseTaggedTable(first, rest);
  if (Array.isArray(first)) {
    if (first.length === 0) {
      throw new HarnessError.EachTableError("empty", "an empty array");
    }
    return first;
  }
  throw new HarnessError.EachTableError(
    "shape",
    `${describeValue(first)}, where an array of rows or a tagged template was ` +
      `expected`,
  );
}

/**
 * Jest/vitest-style title interpolation. Both index tokens are **0-based**, as
 * they are in those runners, so `$#` and `%#` agree with `identity.row`; `%$`
 * is vitest's 1-based counterpart. Printf codes run before `$key` substitution
 * so a row value that happens to contain `%s` is not re-read as a placeholder,
 * and `$key` substitutes through a replacer function so a value containing `$&`
 * or `$1` is inserted rather than interpreted.
 */
export function interpolateTitle(
  title: string,
  row: unknown,
  index: number,
): string {
  const indexed = title
    .replace(/\$#/g, String(index))
    .replace(/%#/g, String(index))
    .replace(/%\$/g, String(index + 1));

  const object = isObjectRow(row);
  const formatted = formatPlaceholders(
    indexed,
    object || !Array.isArray(row) ? [row] : row,
  );

  if (!object) return formatted;

  let result = formatted;

  for (const key of Object.keys(row)) {
    if (isPollutionKey(key)) continue;
    const token = new RegExp(`\\$${escapeRegExp(key)}\\b`, "g");
    const replacement = stringify((row as Record<string, unknown>)[key]);
    result = result.replace(token, () => replacement);
  }

  return result;
}

export function assignOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

/**
 * `%%` is the escape, so it consumes no argument. A code with no argument left
 * to consume is left standing rather than rendered as `undefined` — the title
 * asked for a cell this row does not have, and saying so is more useful than
 * inventing one.
 */
function formatPlaceholders(
  title: string,
  args: ReadonlyArray<unknown>,
): string {
  let cursor = 0;

  return title.replace(/%([sdfijpo%])/g, (match, code: string) => {
    if (code === "%") return "%";

    const value = args[cursor];
    cursor += 1;

    if (typeof value === "undefined" && cursor > args.length) return match;

    if (code === "j" || code === "p" || code === "o") {
      try {
        return JSON.stringify(value) ?? String(value);
      } catch {
        return String(value);
      }
    }

    if (code === "i") return String(Math.trunc(Number(value)));

    if (code === "d" || code === "f") return String(Number(value));

    return stringify(value);
  });
}

function isObjectRow(row: unknown): row is Record<string, unknown> {
  return typeof row === "object" && row !== null && !Array.isArray(row);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "undefined") return "undefined";
  if (Array.isArray(value)) return "an array";

  const type = typeof value;
  return type === "object" ? "an object" : `a ${type}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return "null";
  if (typeof value === "undefined") return "undefined";

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const kinds = ["added", "changed", "fixed", "removed", "none"] as const;
const fieldsList = [
  "kind",
  "breaking",
  "affects",
  "summary",
  "action",
] as const;
const allowedFieldSet = new Set<string>(fieldsList);
const surfacePattern = /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const noteFilePattern =
  /^(\d{4})-(\d{2})-(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;

export const changeNoteKinds = kinds;

type ChangeNote = {
  readonly kind: "added" | "changed" | "fixed" | "removed" | "none";
  readonly breaking: boolean;
  readonly affects: readonly string[];
  readonly summary: string;
  readonly action: string | null;
};

type ChangeNoteKind = ChangeNote["kind"];

export type ChangeNoteEntry = {
  readonly file: string;
  readonly note: ChangeNote;
};

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

function fail(problem: string): {
  readonly ok: false;
  readonly problem: string;
} {
  return { ok: false, problem };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isValidSurfaceWord(value: string): boolean {
  return surfacePattern.test(value);
}

export function isValidSlug(value: string): boolean {
  return slugPattern.test(value);
}

export function todayLocalIsoDate(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isValidIsoDate(raw: string): boolean {
  const match = isoDatePattern.exec(raw);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isChangeNoteFile(file: string): boolean {
  const match = noteFilePattern.exec(file);
  if (match === null) return false;
  return isValidIsoDate(`${match[1]}-${match[2]}-${match[3]}`);
}

function parseJsonObject(file: string, raw: string): Parsed<object> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(
      `${file}: invalid JSON (${reason}). Repair: fix the JSON syntax in ${file}.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return fail(
      `${file}: expected a JSON object. Repair: write an object with ${fieldsList.join(", ")}.`,
    );
  return { ok: true, value: parsed };
}

function readJsonFields(
  file: string,
  raw: string,
): Parsed<Map<string, unknown>> {
  const objectResult = parseJsonObject(file, raw);
  if (!objectResult.ok) return objectResult;
  const fields = new Map<string, unknown>(Object.entries(objectResult.value));
  const unknown = [...fields.keys()].find((key) => !allowedFieldSet.has(key));
  if (unknown !== undefined)
    return fail(
      `${file}: unknown field "${unknown}". Repair: keep only ${fieldsList.join(", ")}.`,
    );
  const missing = fieldsList.find((key) => !fields.has(key));
  if (missing !== undefined)
    return fail(
      `${file}: missing required field "${missing}". Repair: set ${fieldsList.join(", ")}.`,
    );
  return { ok: true, value: fields };
}

function parseKindAndBreaking(
  file: string,
  fields: ReadonlyMap<string, unknown>,
): Parsed<{ readonly kind: ChangeNoteKind; readonly breaking: boolean }> {
  const kind = kinds.find((value) => value === fields.get("kind"));
  if (kind === undefined)
    return fail(
      `${file}: kind must be one of ${kinds.join(", ")}. Repair: set kind to a valid value.`,
    );
  const breaking = fields.get("breaking");
  if (typeof breaking !== "boolean")
    return fail(
      `${file}: breaking must be true or false. Repair: set breaking to a boolean.`,
    );
  if (kind === "none" && breaking)
    return fail(
      `${file}: a "none" note cannot set breaking to true. Repair: set breaking to false or pick added, changed, fixed or removed.`,
    );
  return { ok: true, value: { kind, breaking } };
}

function parseAffects(
  file: string,
  raw: unknown,
  kind: ChangeNoteKind,
  allowedAffects: ReadonlySet<string>,
): Parsed<readonly string[]> {
  const allowedList = [...allowedAffects].sort(compareText).join(", ");
  if (!Array.isArray(raw))
    return fail(
      `${file}: affects must be an array of lowercase words. Repair: use one or more of ${allowedList} (or [] when kind is "none").`,
    );
  const affects: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !surfacePattern.test(item))
      return fail(
        `${file}: invalid affects entry "${String(item)}". Repair: use one of ${allowedList}.`,
      );
    affects.push(item);
  }
  const invalid = affects.find((item) => !allowedAffects.has(item));
  if (invalid !== undefined)
    return fail(
      `${file}: unknown affects entry "${invalid}". Repair: use one of ${allowedList}.`,
    );
  if (kind !== "none" && affects.length === 0)
    return fail(
      `${file}: affects must name at least one word when kind is "${kind}". Repair: use one or more of ${allowedList}.`,
    );
  return { ok: true, value: Object.freeze(affects) };
}

function parseAction(
  file: string,
  raw: unknown,
  breaking: boolean,
): Parsed<string | null> {
  if (raw !== null && (typeof raw !== "string" || raw.trim() === ""))
    return fail(
      `${file}: action must be a non-empty string or null. Repair: set action to null or write what the reader must do.`,
    );
  if (breaking && raw === null)
    return fail(
      `${file}: breaking is true so action must explain what the reader must do. Repair: set action to a non-empty step.`,
    );
  return { ok: true, value: raw === null ? null : raw.trim() };
}

export function parseChangeNote(
  file: string,
  raw: string,
  allowedAffects: ReadonlySet<string>,
):
  | { readonly ok: true; readonly note: ChangeNote }
  | { readonly ok: false; readonly problem: string } {
  const fieldsResult = readJsonFields(file, raw);
  if (!fieldsResult.ok) return fieldsResult;
  const fields = fieldsResult.value;
  const header = parseKindAndBreaking(file, fields);
  if (!header.ok) return header;
  const { kind, breaking } = header.value;
  const affects = parseAffects(
    file,
    fields.get("affects"),
    kind,
    allowedAffects,
  );
  if (!affects.ok) return affects;
  const summary = fields.get("summary");
  if (typeof summary !== "string" || summary.trim() === "")
    return fail(
      `${file}: summary must be a non-empty string. Repair: describe what changed for readers.`,
    );
  const action = parseAction(file, fields.get("action"), breaking);
  if (!action.ok) return action;
  return {
    ok: true,
    note: Object.freeze({
      kind,
      breaking,
      affects: affects.value,
      summary: summary.trim(),
      action: action.value,
    }),
  };
}

export function formatChangeNoteJson(note: ChangeNote): string {
  const inlineAffects = `  "affects": [${note.affects.map((item) => JSON.stringify(item)).join(", ")}],`;
  const affectsLines =
    inlineAffects.length <= 80
      ? [inlineAffects]
      : [
          '  "affects": [',
          ...note.affects.map(
            (item, index) =>
              `    ${JSON.stringify(item)}${index + 1 < note.affects.length ? "," : ""}`,
          ),
          "  ],",
        ];
  return `${[
    "{",
    `  "kind": ${JSON.stringify(note.kind)},`,
    `  "breaking": ${String(note.breaking)},`,
    ...affectsLines,
    `  "summary": ${JSON.stringify(note.summary)},`,
    `  "action": ${JSON.stringify(note.action)}`,
    "}",
    "",
  ].join("\n")}`;
}

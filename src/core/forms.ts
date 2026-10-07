// OpenCode form (question) helpers: parsing, conditional visibility and answer
// validation against the field schema OpenCode sent.

import type {
  FormAnswer,
  FormCondition,
  FormField,
  FormOption,
  FormRequest,
  FormValue,
} from "../shared/model";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

function options(v: unknown): FormOption[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: FormOption[] = [];
  for (const o of v) {
    const r = rec(o);
    const value = str(r?.value);
    if (value === undefined) continue;
    out.push({
      value,
      label: str(r?.label) ?? value,
      ...(str(r?.description) ? { description: str(r?.description) } : {}),
    });
  }
  return out;
}

function conditions(v: unknown): FormCondition[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: FormCondition[] = [];
  for (const c of v) {
    const r = rec(c);
    const key = str(r?.key);
    const value = r?.value;
    if (!key || (r?.op !== "eq" && r?.op !== "neq")) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    out.push({ key, op: r.op, value });
  }
  return out;
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

/** Parses one OpenCode Form.Field; unknown field types are dropped (never invented). */
export function parseField(raw: unknown): FormField | null {
  const r = rec(raw);
  const key = str(r?.key);
  if (!r || !key) return null;
  const base = clean({
    key,
    title: str(r.title),
    description: str(r.description),
    required: bool(r.required),
    hidden: bool(r.hidden),
    when: conditions(r.when),
  });
  switch (r.type) {
    case "string": {
      const formats = ["email", "uri", "date", "date-time"] as const;
      const format = formats.find((f) => f === r.format);
      return clean({
        ...base,
        type: "string" as const,
        format,
        minLength: num(r.minLength),
        maxLength: num(r.maxLength),
        pattern: str(r.pattern),
        placeholder: str(r.placeholder),
        default: str(r.default),
        options: options(r.options),
        custom: bool(r.custom),
      });
    }
    case "number":
    case "integer":
      return clean({
        ...base,
        type: r.type,
        minimum: num(r.minimum),
        maximum: num(r.maximum),
        default: num(r.default),
      });
    case "boolean":
      return clean({ ...base, type: "boolean" as const, default: bool(r.default) });
    case "multiselect": {
      const opts = options(r.options);
      if (!opts) return null;
      const def = Array.isArray(r.default)
        ? r.default.filter((x): x is string => typeof x === "string")
        : undefined;
      return clean({
        ...base,
        type: "multiselect" as const,
        options: opts,
        minItems: num(r.minItems),
        maxItems: num(r.maxItems),
        custom: bool(r.custom),
        default: def,
      });
    }
    case "external": {
      const url = str(r.url);
      if (!url) return null;
      return clean({
        key,
        type: "external" as const,
        url,
        title: str(r.title),
        description: str(r.description),
      });
    }
    default:
      return null;
  }
}

export function parseForm(raw: unknown): FormRequest | null {
  const r = rec(raw);
  const id = str(r?.id);
  const sessionID = str(r?.sessionID);
  if (!r || !id || !sessionID || !Array.isArray(r.fields)) return null;
  const fields = r.fields.map(parseField).filter((f): f is FormField => f !== null);
  if (fields.length === 0) return null;
  const tool = rec(rec(r.metadata)?.tool);
  return { id, sessionID, title: str(r.title) ?? "Question", fields, toolId: str(tool?.id) ?? null };
}

function conditionHolds(c: FormCondition, answers: FormAnswer): boolean {
  const v = answers[c.key];
  if (v === undefined || v === "") return false;
  const eq = Array.isArray(v) ? v.includes(String(c.value)) : v === c.value;
  return c.op === "eq" ? eq : !eq;
}

/** A field is active when all its `when` conditions hold against the current answers. */
export function isFieldActive(field: FormField, answers: FormAnswer): boolean {
  if (field.type === "external") return true;
  return (field.when ?? []).every((c) => conditionHolds(c, answers));
}

export function defaultAnswer(field: FormField): FormValue | undefined {
  if (field.type === "external") return undefined;
  return field.default;
}

/**
 * Validates an answer against the form. Returns the cleaned answer (only active,
 * known fields; hidden fields fall back to their default) or an error message.
 */
export function validateAnswer(
  form: FormRequest,
  input: FormAnswer,
): { ok: true; answer: FormAnswer } | { ok: false; error: string } {
  const answer: FormAnswer = {};
  for (const field of form.fields) {
    if (field.type === "external") continue;
    if (!isFieldActive(field, answer)) continue;
    const label = field.title ?? field.key;
    let v: FormValue | undefined = input[field.key];
    if (field.hidden && v === undefined) v = defaultAnswer(field);
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) {
      if (field.required) return { ok: false, error: `“${label}” is required.` };
      continue;
    }
    switch (field.type) {
      case "string": {
        if (typeof v !== "string") return { ok: false, error: `“${label}” must be text.` };
        if (field.options?.length && !field.custom && !field.options.some((o) => o.value === v)) {
          return { ok: false, error: `Choose one of the options for “${label}”.` };
        }
        if (field.minLength !== undefined && v.length < field.minLength)
          return { ok: false, error: `“${label}” is too short.` };
        if (field.maxLength !== undefined && v.length > field.maxLength)
          return { ok: false, error: `“${label}” is too long.` };
        if (field.pattern) {
          let re: RegExp | null;
          try {
            re = new RegExp(`^(?:${field.pattern})$`, "u");
          } catch {
            re = null; // an invalid pattern from the server is not enforced locally
          }
          if (re && !re.test(v)) return { ok: false, error: `“${label}” has an invalid format.` };
        }
        break;
      }
      case "number":
      case "integer": {
        if (typeof v !== "number" || !Number.isFinite(v))
          return { ok: false, error: `“${label}” must be a number.` };
        if (field.type === "integer" && !Number.isInteger(v))
          return { ok: false, error: `“${label}” must be a whole number.` };
        if (field.minimum !== undefined && v < field.minimum)
          return { ok: false, error: `“${label}” must be at least ${field.minimum}.` };
        if (field.maximum !== undefined && v > field.maximum)
          return { ok: false, error: `“${label}” must be at most ${field.maximum}.` };
        break;
      }
      case "boolean":
        if (typeof v !== "boolean") return { ok: false, error: `“${label}” must be yes or no.` };
        break;
      case "multiselect": {
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
          return { ok: false, error: `“${label}” must be a list.` };
        if (!field.custom && v.some((x) => !field.options.some((o) => o.value === x))) {
          return { ok: false, error: `Choose only listed options for “${label}”.` };
        }
        if (field.minItems !== undefined && v.length < field.minItems)
          return { ok: false, error: `Choose at least ${field.minItems} for “${label}”.` };
        if (field.maxItems !== undefined && v.length > field.maxItems)
          return { ok: false, error: `Choose at most ${field.maxItems} for “${label}”.` };
        break;
      }
    }
    answer[field.key] = v;
  }
  return { ok: true, answer };
}

/** Human summary of an answer for the transcript, e.g. "Preferred color: Blue". */
export function summarizeAnswer(form: FormRequest, answer: FormAnswer): string {
  return form.fields
    .filter((f) => f.type !== "external" && answer[f.key] !== undefined)
    .map((f) => {
      const v = answer[f.key];
      const shown = Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
      return `${f.title ?? f.key}: ${shown}`;
    })
    .join("\n");
}

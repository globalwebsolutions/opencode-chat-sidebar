import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFieldActive, parseForm, summarizeAnswer, validateAnswer } from "../src/core/forms";

// Captured from a live OpenCode 2.0.24 `form.created` event (question tool).
export const QUESTION = {
  id: "frm_118030afb001S2uG6cWQVB5gBq",
  sessionID: "ses_ee7fd0b11ffegWx60vmIWqtiYP",
  title: "Questions",
  metadata: { kind: "question", tool: { messageID: "msg_1", id: "question_1_91a5f39a" } },
  fields: [
    {
      key: "q0",
      title: "Preferred color",
      description: "Which color do you prefer?",
      type: "string",
      options: [
        { value: "Red", label: "Red", description: "The color red" },
        { value: "Blue", label: "Blue", description: "The color blue" },
      ],
      custom: true,
    },
  ],
};

describe("OpenCode forms", () => {
  it("parses a real question form", () => {
    const f = parseForm(QUESTION);
    assert.ok(f);
    assert.equal(f.toolId, "question_1_91a5f39a");
    assert.equal(f.fields[0].type, "string");
    assert.equal(f.fields.length, 1);
  });

  it("drops unknown field types instead of inventing controls", () => {
    const f = parseForm({ ...QUESTION, fields: [...QUESTION.fields, { key: "x", type: "color-wheel" }] });
    assert.equal(f?.fields.length, 1);
    assert.equal(parseForm({ ...QUESTION, fields: [{ key: "x", type: "weird" }] }), null);
  });

  it("validates choices, custom answers and required fields", () => {
    const f = parseForm(QUESTION)!;
    assert.deepEqual(validateAnswer(f, { q0: "Blue" }), { ok: true, answer: { q0: "Blue" } });
    assert.deepEqual(
      validateAnswer(f, { q0: "Green" }),
      { ok: true, answer: { q0: "Green" } },
      "custom allowed",
    );
    const strict = parseForm({
      ...QUESTION,
      fields: [{ ...QUESTION.fields[0], custom: false, required: true }],
    })!;
    assert.equal(validateAnswer(strict, { q0: "Green" }).ok, false);
    assert.equal(validateAnswer(strict, {}).ok, false);
  });

  it("supports boolean, number, integer and multiselect fields with limits", () => {
    const f = parseForm({
      id: "frm_2",
      sessionID: "ses_1",
      title: "Setup",
      fields: [
        { key: "ok", type: "boolean", required: true },
        { key: "n", type: "integer", minimum: 1, maximum: 5 },
        {
          key: "tags",
          type: "multiselect",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
          maxItems: 1,
        },
      ],
    })!;
    assert.equal(validateAnswer(f, { ok: true, n: 3, tags: ["a"] }).ok, true);
    assert.equal(validateAnswer(f, { ok: true, n: 3.5 }).ok, false);
    assert.equal(validateAnswer(f, { ok: true, n: 9 }).ok, false);
    assert.equal(validateAnswer(f, { ok: true, tags: ["a", "b"] }).ok, false);
    assert.equal(validateAnswer(f, { ok: true, tags: ["zzz"] }).ok, false);
    assert.equal(validateAnswer(f, { ok: "yes" }).ok, false);
  });

  it("applies `when` conditions and ignores inactive fields", () => {
    const f = parseForm({
      id: "frm_3",
      sessionID: "s",
      title: "T",
      fields: [
        {
          key: "mode",
          type: "string",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
        { key: "detail", type: "string", required: true, when: [{ key: "mode", op: "eq", value: "b" }] },
      ],
    })!;
    assert.equal(isFieldActive(f.fields[1], { mode: "a" }), false);
    assert.deepEqual(validateAnswer(f, { mode: "a", detail: "ignored" }), {
      ok: true,
      answer: { mode: "a" },
    });
    assert.equal(validateAnswer(f, { mode: "b" }).ok, false, "required when active");
  });

  it("summarizes answers for the transcript", () => {
    assert.equal(summarizeAnswer(parseForm(QUESTION)!, { q0: "Blue" }), "Preferred color: Blue");
  });
});

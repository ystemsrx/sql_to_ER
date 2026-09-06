import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readEditorDraft, writeEditorDraft } from "../sessionDraft";
import { SESSION_RESTORE_MAX_AGE_MS } from "../snapshots";

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("reads legacy drafts and migrates new edits to one atomic value", () => {
  const now = Date.now();
  storage.set("sql2er-draft", "new SQL draft");
  storage.set("sql2er-draft-updated-at", String(now));
  expect(readEditorDraft()).toEqual({ text: "new SQL draft", updatedAt: now });
  writeEditorDraft({ text: "", updatedAt: now + 1 });
  expect(readEditorDraft()?.text).toBe("");
});

it("does not resurrect a stale legacy draft after the new draft expires", () => {
  storage.set("sql2er-draft", "legacy");
  storage.set("sql2er-draft-updated-at", String(Date.now()));
  writeEditorDraft({ text: "expired", updatedAt: Date.now() - SESSION_RESTORE_MAX_AGE_MS - 10 });
  expect(readEditorDraft()).toBeNull();
});

it("survives malformed and unavailable storage", () => {
  storage.set("sql2er-editor-draft-v2", "{");
  expect(readEditorDraft()).toBeNull();
  vi.stubGlobal("window", {
    get localStorage() {
      throw new DOMException("denied", "SecurityError");
    },
  });
  expect(readEditorDraft()).toBeNull();
  expect(() => writeEditorDraft({ text: "draft", updatedAt: Date.now() })).not.toThrow();
});

import { isWithinSessionRestoreWindow } from "./snapshots";

const KEY = "sql2er-editor-draft-v2";
export interface EditorDraft {
  text: string;
  updatedAt: number;
}

export function readEditorDraft(): EditorDraft | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw !== null) {
      const value = JSON.parse(raw);
      return typeof value?.text === "string" && isWithinSessionRestoreWindow(value.updatedAt)
        ? value
        : null;
    }
    // Previous versions wrote text and timestamp separately.
    const text = window.localStorage.getItem("sql2er-draft");
    const updatedAt = Number(window.localStorage.getItem("sql2er-draft-updated-at"));
    return text !== null && isWithinSessionRestoreWindow(updatedAt) ? { text, updatedAt } : null;
  } catch {
    return null;
  }
}

export function writeEditorDraft(draft: EditorDraft): void {
  try {
    // One atomic storage value prevents text/timestamp pairs from diverging.
    window.localStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    /* Editing remains available when storage is denied. */
  }
}

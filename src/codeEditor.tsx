/**
 * CodeEditor Module - CodeMirror 6 编辑器组件
 *
 * 与 G6 节点双击编辑逻辑分文件维护，避免浏览器编辑器和图节点编辑职责耦合。
 * App 与 EmbeddedApp 都静态导入本组件，首次渲染即可直接初始化 CodeMirror。
 */
import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { placeholder as placeholderExtension } from "@codemirror/view";
import { sql, PostgreSQL } from "@codemirror/lang-sql";

export interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}

const externalValueSync = Annotation.define<boolean>();

/**
 * SQL/DBML 编辑器。CodeMirror 6 用 EditorView + EditorState 模型，
 * 一次性挂载，外部 value 变化通过 dispatch 同步进 doc。
 */
export const CodeEditor = ({ value, onChange, placeholder, readOnly = false }: CodeEditorProps) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 把最新的 onChange 装进 ref，避免在外部回调变化时重建 EditorView。
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // 用 Compartment 包装 placeholder 扩展，便于语言切换时通过 reconfigure 热更新。
  const placeholderCompartmentRef = useRef(new Compartment());

  useEffect(() => {
    if (!hostRef.current) return;

    const startState = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        sql({ dialect: PostgreSQL, upperCaseKeywords: false }),
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        placeholderCompartmentRef.current.of(placeholderExtension(placeholder ?? "")),
        EditorView.updateListener.of((update) => {
          if (
            update.docChanged &&
            !update.transactions.every((tr) => tr.annotation(externalValueSync))
          ) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state: startState, parent: hostRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 仅初次挂载初始化；后续 value / placeholder 变化由下方 effect 同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // placeholder 变化（如语言切换）时通过 Compartment 热替换扩展，避免重建编辑器。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: placeholderCompartmentRef.current.reconfigure(
        placeholderExtension(placeholder ?? ""),
      ),
    });
  }, [placeholder]);

  // 外部 value 变化时同步进 doc。等值则跳过，避免 dispatch 把光标重置。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: externalValueSync.of(true),
    });
  }, [value]);

  return <div ref={hostRef} className="cm-host" />;
};

export default CodeEditor;

import { Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { MarkdownView } from "obsidian";
import { yCollab, ySyncAnnotation, yRemoteSelections, yRemoteSelectionsTheme } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { remoteSelections } from "./remoteSelections";

/**
 * Every markdown editor gets this (empty) compartment via
 * `plugin.registerEditorExtension(collabCompartment.of([]))`. While a note is
 * being co-edited we reconfigure the compartment of that one editor to the Yjs
 * binding, and back to `[]` when the session ends - so notes that nobody else
 * has open pay nothing and behave exactly like before.
 */
export const collabCompartment = new Compartment();

/**
 * Changes that arrive from other devices must not land on the local undo
 * stack: otherwise Ctrl+Z would revert somebody else's typing (and push that
 * revert back to them). CodeMirror's history maps its stack through untracked
 * changes, so undo only ever touches this device's own edits.
 */
const keepRemoteChangesOutOfUndoHistory = EditorState.transactionExtender.of((tr) =>
  tr.annotation(ySyncAnnotation) ? { annotations: Transaction.addToHistory.of(false) } : null,
);

/**
 * Yjs text binding + remote cursors/selections (a coloured caret with the
 * device name as a flag, tinted selection ranges). Yjs' own undo manager is
 * disabled on purpose - see `keepRemoteChangesOutOfUndoHistory`.
 */
export function createCollabExtension(ytext: Y.Text, awareness: Awareness): Extension {
  // The library's cursor renderer is swapped for ours (./remoteSelections): it made lines jump sideways.
  const binding = (yCollab(ytext, awareness, { undoManager: false }) as Extension[]).filter(
    (part) => part !== yRemoteSelections && part !== yRemoteSelectionsTheme,
  );
  return [binding, remoteSelections, keepRemoteChangesOutOfUndoHistory];
}

/** `Editor.cm` is long-stable in Obsidian (every community CodeMirror plugin relies on it) but isn't in the public typings. */
export function getEditorView(view: MarkdownView): EditorView | null {
  const cm = (view.editor as unknown as { cm?: EditorView } | undefined)?.cm;
  return cm ?? null;
}

/** False if this editor was created without our compartment (should not happen once the extension is registered). */
export function canBind(cm: EditorView): boolean {
  return collabCompartment.get(cm.state) !== undefined;
}

export function bindEditor(cm: EditorView, extension: Extension): void {
  cm.dispatch({ effects: collabCompartment.reconfigure(extension) });
}

export function unbindEditor(cm: EditorView): void {
  if (!canBind(cm)) return;
  cm.dispatch({ effects: collabCompartment.reconfigure([]) });
}

/**
 * Makes the editor's text equal `target` with one minimal change (common
 * prefix/suffix kept), so cursors and scroll position survive when the two
 * texts are almost - or entirely - the same, which is the normal case when a
 * device joins. Must run BEFORE the Yjs binding is installed: the binding
 * would otherwise treat this as the user's own edit and echo it to the peers.
 */
export function replaceEditorText(cm: EditorView, target: string): void {
  const current = cm.state.doc.toString();
  if (current === target) return;

  const shortest = Math.min(current.length, target.length);
  let start = 0;
  while (start < shortest && current.charCodeAt(start) === target.charCodeAt(start)) start++;

  let currentEnd = current.length;
  let targetEnd = target.length;
  while (currentEnd > start && targetEnd > start && current.charCodeAt(currentEnd - 1) === target.charCodeAt(targetEnd - 1)) {
    currentEnd--;
    targetEnd--;
  }

  cm.dispatch({
    changes: { from: start, to: currentEnd, insert: target.slice(start, targetEnd) },
    annotations: Transaction.addToHistory.of(false),
  });
}

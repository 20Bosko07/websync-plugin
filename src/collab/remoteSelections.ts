import type { Extension, Range } from "@codemirror/state";
import { Annotation } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { ySyncFacet } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

/**
 * Remote cursors and selections. Replaces the renderer of y-codemirror.next, which tagged every fully
 * selected line with a `cm-yLineSelection` class that sets `padding: 0; margin: 0 2px 0 4px` - the text of
 * all those lines jumped sideways on the watching device whenever somebody else selected across them
 * (and the reset in our CSS lost against the host's own `!important` line margins). Here selected lines get
 * a background colour only, so no selection can ever move text. Keep in sync with packages/web/src/workspace/collab/remoteSelections.ts.
 */

const refresh = Annotation.define<true>();

interface AwarenessState {
  cursor?: { anchor?: Y.RelativePosition | null; head?: Y.RelativePosition | null } | null;
  user?: { name?: string; color?: string; colorLight?: string };
}

class RemoteCaretWidget extends WidgetType {
  constructor(
    readonly color: string,
    readonly name: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const caret = document.createElement("span");
    caret.className = "cm-ySelectionCaret";
    caret.style.backgroundColor = this.color;
    caret.style.borderColor = this.color;
    const info = document.createElement("div");
    info.className = "cm-ySelectionInfo";
    info.textContent = this.name;
    // Word joiners keep the empty inline box from collapsing without adding any width.
    caret.append("⁠", info, "⁠");
    return caret;
  }

  eq(other: RemoteCaretWidget): boolean {
    return other.color === this.color && other.name === this.name;
  }

  get estimatedHeight(): number {
    return -1;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const theme = EditorView.baseTheme({
  // Border 2px + margins -1px/-1px = a caret that takes no horizontal space, so it never pushes text.
  ".cm-ySelectionCaret": {
    position: "relative",
    borderLeft: "2px solid black",
    borderRight: "0",
    marginLeft: "-1px",
    marginRight: "-1px",
    boxSizing: "border-box",
    display: "inline",
  },
  ".cm-ySelectionInfo": {
    position: "absolute",
    top: "-1.5em",
    left: "-2px",
    fontStyle: "normal",
    lineHeight: "normal",
    userSelect: "none",
    color: "white",
    zIndex: "101",
    backgroundColor: "inherit",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  },
});

class RemoteSelectionsPlugin {
  decorations: DecorationSet = Decoration.none;
  private readonly awareness: Awareness;
  private readonly listener: (changes: { added: number[]; updated: number[]; removed: number[] }) => void;

  constructor(private readonly view: EditorView) {
    this.awareness = view.state.facet(ySyncFacet).awareness;
    this.listener = ({ added, updated, removed }) => {
      const own = this.awareness.doc.clientID;
      if ([...added, ...updated, ...removed].some((id) => id !== own)) view.dispatch({ annotations: [refresh.of(true)] });
    };
    this.awareness.on("change", this.listener);
  }

  destroy(): void {
    this.awareness.off("change", this.listener);
  }

  update(update: ViewUpdate): void {
    const { ytext, awareness } = update.state.facet(ySyncFacet);
    const ydoc = ytext.doc as Y.Doc;
    const doc = update.state.doc;

    // Publish our own cursor.
    const local = awareness.getLocalState();
    if (local != null) {
      const hasFocus = update.view.hasFocus && update.view.dom.ownerDocument.hasFocus();
      const sel = hasFocus ? update.state.selection.main : null;
      const currentAnchor = local.cursor == null ? null : Y.createRelativePositionFromJSON(local.cursor.anchor);
      const currentHead = local.cursor == null ? null : Y.createRelativePositionFromJSON(local.cursor.head);
      if (sel != null) {
        const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor);
        const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head);
        if (local.cursor == null || !Y.compareRelativePositions(currentAnchor, anchor) || !Y.compareRelativePositions(currentHead, head)) {
          awareness.setLocalStateField("cursor", { anchor, head });
        }
      } else if (local.cursor != null) {
        // Not editing here any more (focus went elsewhere): take the cursor away instead of leaving it behind on the other devices.
        awareness.setLocalStateField("cursor", null);
      }
    }

    // Draw everybody else's.
    const decorations: Range<Decoration>[] = [];
    awareness.getStates().forEach((state: AwarenessState, clientId: number) => {
      if (clientId === awareness.doc.clientID) return;
      const cursor = state.cursor;
      if (cursor == null || cursor.anchor == null || cursor.head == null) return;
      const anchor = Y.createAbsolutePositionFromRelativePosition(cursor.anchor, ydoc);
      const head = Y.createAbsolutePositionFromRelativePosition(cursor.head, ydoc);
      if (anchor == null || head == null || anchor.type !== ytext || head.type !== ytext) return;
      // Positions come from another device and may be a moment ahead of our document.
      const clamp = (n: number) => Math.max(0, Math.min(n, doc.length));
      const anchorIndex = clamp(anchor.index);
      const headIndex = clamp(head.index);

      // Awareness comes from other devices and ends up in a style attribute, so only plain hex colours pass.
      const hex = (v: unknown, fallback: string) => (typeof v === "string" && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v) ? v : fallback);
      const { name = "Anonymous" } = state.user ?? {};
      const color = hex(state.user?.color, "#30bced");
      const colorLight = hex(state.user?.colorLight, `${color}33`);
      const start = Math.min(anchorIndex, headIndex);
      const end = Math.max(anchorIndex, headIndex);
      const startLine = doc.lineAt(start);
      const endLine = doc.lineAt(end);
      const tint = { attributes: { style: `background-color: ${colorLight}` }, class: "cm-ySelection" };

      if (startLine.number === endLine.number) {
        if (end > start) decorations.push(Decoration.mark(tint).range(start, end));
      } else {
        if (startLine.to > start) decorations.push(Decoration.mark(tint).range(start, startLine.to));
        if (end > endLine.from) decorations.push(Decoration.mark(tint).range(endLine.from, end));
        for (let i = startLine.number + 1; i < endLine.number; i++) {
          // Background only - no class/padding/margin, see the note at the top.
          decorations.push(Decoration.line({ attributes: { style: `background-color: ${colorLight}` } }).range(doc.line(i).from));
        }
      }
      decorations.push(
        Decoration.widget({
          side: headIndex - anchorIndex > 0 ? -1 : 1, // keep the caret outside of the remote selection
          block: false,
          widget: new RemoteCaretWidget(color, name),
        }).range(headIndex),
      );
    });
    this.decorations = Decoration.set(decorations, true);
  }
}

const plugin = ViewPlugin.fromClass(RemoteSelectionsPlugin, { decorations: (v) => v.decorations });

export const remoteSelections: Extension = [theme, plugin];

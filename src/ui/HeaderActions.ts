/**
 * WebSync's presence in the tab header (the icon row top right, next to the
 * reading-view "book" toggle and the "..." menu), built with Obsidian's own `view.addAction`:
 *
 *  - While other devices are in the same note, a compact stack of coloured
 *    avatars (initial of the device name, same colour as their cursor). The
 *    full names are in the tooltip and in the menu you get on click.
 *  - The general WebSync status icon (synced / syncing / offline / locked ...)
 *    lives here on every note and on every platform (there is no bottom status
 *    bar item any more). Clicking it opens the sync menu; the icon alone is the
 *    label, no text.
 *
 * It is a pure view: state is read from the plugin, and the DOM is only
 * touched when the rendered result actually changes.
 */
import { t } from "../i18n/index.js";
import { ItemView, MarkdownView, Menu, setIcon, setTooltip } from "obsidian";
import type WebSyncPlugin from "../main.js";
import type { CollabPresence } from "../collab/CollabManager.js";
import { describeStatus, type WebSyncStatusBar } from "./StatusBar.js";

const REFRESH_INTERVAL_MS = 1000;
const MAX_AVATARS = 3;

interface HeaderAction {
  el: HTMLElement;
  /** What was last rendered - skips DOM work while nothing changed. */
  signature: string;
}

export class WebSyncHeaderActions {
  private readonly actions = new Map<ItemView, HeaderAction>();
  private timer: ReturnType<typeof window.setInterval> | null = null;

  constructor(
    private readonly plugin: WebSyncPlugin,
    private readonly statusBar: WebSyncStatusBar,
  ) {}

  start(): void {
    const { workspace } = this.plugin.app;
    const refresh = () => this.refresh();
    this.plugin.registerEvent(workspace.on("layout-change", refresh));
    this.plugin.registerEvent(workspace.on("active-leaf-change", refresh));
    this.plugin.registerEvent(workspace.on("file-open", refresh));
    // Status changes (syncing, offline, ...) have no event of their own.
    this.timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    this.plugin.registerInterval(this.timer);
    this.refresh();
  }

  dispose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    for (const { el } of this.actions.values()) el.remove();
    this.actions.clear();
  }

  refresh(): void {
    const seen = new Set<ItemView>();
    this.plugin.app.workspace.iterateRootLeaves((leaf) => {
      const view = leaf.view;
      // Every tab of the main area: notes, canvas, PDF, images, the graph view and the empty "new tab" page - the sync
      // icon is the same everywhere, so it is never missing just because no file is open.
      if (!(view instanceof ItemView)) return;
      seen.add(view);
      let action = this.actions.get(view);
      if (!action) {
        const el = view.addAction("cloud", "WebSync", (evt) => this.onClick(evt, view));
        el.addClass("websync-header-action");
        action = { el, signature: "" };
        this.actions.set(view, action);
      }
      this.render(view, action);
    });

    // Tabs that were closed took their header (and our element) with them.
    for (const view of [...this.actions.keys()]) {
      if (!seen.has(view)) this.actions.delete(view);
    }
  }

  private presenceOf(view: ItemView): CollabPresence[] | null {
    if (!(view instanceof MarkdownView) || !view.file) return null;
    return this.plugin.collabManager?.presenceFor(view.file.path) ?? null;
  }

  private render(view: ItemView, action: HeaderAction): void {
    const { el } = action;
    const presence = this.presenceOf(view);
    const status = this.statusBar.computeStatus();
    const described = describeStatus(status, this.plugin.settings.lastSyncAt);
    const signature = JSON.stringify([described.icon, described.spin, described.alert ?? false, described.tooltip, presence]);
    if (signature === action.signature) return;
    action.signature = signature;

    el.empty();
    el.show();

    const iconEl = el.createSpan({ cls: "websync-header-icon" });
    setIcon(iconEl, described.icon);
    iconEl.toggleClass("websync-status-icon-spin", described.spin);
    iconEl.toggleClass("websync-status-icon-alert", described.alert ?? false);

    let tooltip = described.tooltip;
    if (presence && presence.length > 0) {
      const avatars = el.createSpan({ cls: "websync-avatars" });
      for (const peer of presence.slice(0, MAX_AVATARS)) {
        const avatar = avatars.createSpan({ cls: "websync-avatar", text: initialOf(peer.name) });
        avatar.style.backgroundColor = peer.color;
      }
      if (presence.length > MAX_AVATARS) {
        avatars.createSpan({ cls: "websync-avatar websync-avatar-more", text: `+${presence.length - MAX_AVATARS}` });
      }
      const live = t("p.liveWith", { names: presence.map((peer) => peer.name).join(", ") });
      tooltip = `${tooltip} · ${live}`;
    }
    setTooltip(el, tooltip, { placement: "bottom" });
  }

  private onClick(evt: MouseEvent, view: ItemView): void {
    const presence = this.presenceOf(view);
    this.statusBar.openMenu(evt, (menu: Menu) => {
      if (!presence || presence.length === 0) return;
      menu.addItem((item) => item.setTitle(t("p.liveInNote")).setIcon("users").setDisabled(true));
      for (const peer of presence) {
        menu.addItem((item) => item.setTitle(peer.name).setIcon("user").setDisabled(false));
      }
      menu.addSeparator();
    });
  }
}

/** First visible character of the device name, for the avatar. */
function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}

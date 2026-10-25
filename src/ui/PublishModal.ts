import { Modal, Notice, Setting, type App, type TFile } from "obsidian";
import type { PublishedNote, PublishOptions } from "@websync/shared";
import { t, tn, currentLocale } from "../i18n/index.js";
import type { PublishService } from "../publish/PublishService.js";
import { WebSyncApiError } from "../sync/httpClient.js";

type Expiry = "keep" | "never" | "1h" | "1d" | "7d" | "30d" | "custom";

const EXPIRY_MS: Record<Exclude<Expiry, "keep" | "never" | "custom">, number> = {
  "1h": 3_600_000,
  "1d": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

/** `YYYY-MM-DDTHH:mm` in local time, what a datetime-local field wants. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const formatDate = (iso: string) => new Date(iso).toLocaleString(currentLocale(), { dateStyle: "medium", timeStyle: "short" });

/**
 * The "share as link" dialog, like the one of the web editor: create the public link of a note, copy it, change when it
 * expires and whether it needs a password, refresh the published text, or stop publishing.
 */
export class PublishModal extends Modal {
  private publication: PublishedNote | null = null;
  private link: string | null = null;
  private loading = true;
  private busy = false;
  private error: string | null = null;

  private expiry: Expiry = "never";
  private custom = toLocalInput(new Date(Date.now() + 7 * 86_400_000));
  private password = "";
  private removePassword = false;

  constructor(
    app: App,
    private readonly service: PublishService,
    private readonly file: TFile,
    private readonly fileId: string,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("websync-publish");
    this.titleEl.setText(t("p.pub.dialog.title", { name: this.file.basename }));
    this.render();
    void this.load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    try {
      this.publication = (await this.service.publications()).get(this.fileId) ?? null;
      this.link = this.publication ? await this.service.linkOf(this.fileId, this.publication) : null;
      this.expiry = this.publication?.expiresAt ? "keep" : "never";
    } catch (err) {
      this.error = describe(err);
    }
    this.loading = false;
    this.render();
  }

  private options(): PublishOptions {
    const options: PublishOptions = {};
    const expiresAt = this.expiresAt();
    if (expiresAt !== undefined) options.expiresAt = expiresAt;
    if (this.password) options.password = this.password;
    else if (this.removePassword) options.password = null;
    return options;
  }

  /** undefined = leave as is, null = never, else the time. */
  private expiresAt(): string | null | undefined {
    if (this.expiry === "keep") return undefined;
    if (this.expiry === "never") return this.publication?.expiresAt ? null : undefined;
    if (this.expiry === "custom") return new Date(this.custom).toISOString();
    return new Date(Date.now() + EXPIRY_MS[this.expiry]).toISOString();
  }

  private customInvalid(): boolean {
    return this.expiry === "custom" && !(new Date(this.custom).getTime() > Date.now());
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.error = null;
    this.render();
    try {
      await action();
      this.password = "";
      this.removePassword = false;
      if (this.expiry !== "keep" && this.expiry !== "never") this.expiry = this.publication?.expiresAt ? "keep" : "never";
    } catch (err) {
      this.error = describe(err);
    }
    this.busy = false;
    this.render();
  }

  private async publish(): Promise<void> {
    await this.run(async () => {
      this.publication = await this.service.publish(this.file, this.fileId, this.options());
      this.link = await this.service.linkOf(this.fileId, this.publication);
      await this.copy(this.link, t("p.pub.copied"));
    });
  }

  private async save(): Promise<void> {
    await this.run(async () => {
      this.publication = await this.service.update(this.fileId, this.options());
      new Notice(t("p.pub.saved"));
    });
  }

  private async stop(): Promise<void> {
    await this.run(async () => {
      await this.service.remove(this.fileId);
      new Notice(t("p.pub.unpublished"));
      this.close();
    });
  }

  private async copy(text: string, notice: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice(notice);
    } catch {
      new Notice(t("p.pub.copyFailed"));
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { cls: "setting-item-description", text: t("p.pub.note") });
    if (this.loading) {
      contentEl.createEl("p", { text: t("p.pub.loading") });
      return;
    }
    const publication = this.publication;

    if (publication && this.link) {
      const link = this.link;
      const row = contentEl.createDiv({ cls: "websync-publish-link" });
      const input = row.createEl("input", { type: "text", attr: { readonly: "true", "aria-label": t("p.pub.link") } });
      input.value = link;
      input.addEventListener("focus", () => input.select());
      const copy = row.createEl("button", { cls: "mod-cta", text: t("p.pub.copy") });
      copy.addEventListener("click", () => void this.copy(link, t("p.pub.copied")));

      const expired = publication.expiresAt ? new Date(publication.expiresAt).getTime() <= Date.now() : false;
      const chips = contentEl.createDiv({ cls: "websync-publish-chips" });
      chips.createSpan({
        cls: expired ? "websync-publish-chip is-warn" : "websync-publish-chip",
        text: expired
          ? t("p.pub.expiredOn", { date: formatDate(publication.expiresAt!) })
          : publication.expiresAt
            ? t("p.pub.expiresOn", { date: formatDate(publication.expiresAt) })
            : t("p.pub.neverExpires"),
      });
      if (publication.hasPassword) chips.createSpan({ cls: "websync-publish-chip", text: t("p.pub.passwordSet") });
      chips.createSpan({ cls: "websync-publish-chip", text: tn("p.pub.views", publication.views) });
    }

    new Setting(contentEl)
      .setName(t("p.pub.expiry"))
      .addDropdown((dropdown) => {
        if (publication?.expiresAt) dropdown.addOption("keep", t("p.pub.expiry.keep", { date: formatDate(publication.expiresAt) }));
        dropdown
          .addOption("never", t("p.pub.expiry.never"))
          .addOption("1h", t("p.pub.expiry.1h"))
          .addOption("1d", t("p.pub.expiry.1d"))
          .addOption("7d", t("p.pub.expiry.7d"))
          .addOption("30d", t("p.pub.expiry.30d"))
          .addOption("custom", t("p.pub.expiry.custom"))
          .setValue(this.expiry)
          .onChange((value) => {
            this.expiry = value as Expiry;
            this.render();
          });
      });
    if (this.expiry === "custom") {
      new Setting(contentEl).addText((text) => {
        text.inputEl.type = "datetime-local";
        text.inputEl.min = toLocalInput(new Date());
        text.setValue(this.custom).onChange((value) => {
          this.custom = value;
          this.refreshButtons();
        });
      });
      if (this.customInvalid()) contentEl.createEl("p", { cls: "websync-error-text", text: t("p.pub.pastDate") });
    }

    new Setting(contentEl)
      .setName(t("p.pub.password"))
      .setDesc(t("p.pub.password.hint"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "new-password";
        text.inputEl.maxLength = 200;
        text
          .setPlaceholder(publication?.hasPassword ? t("p.pub.password.placeholderSet") : t("p.pub.password.placeholder"))
          .setDisabled(this.removePassword)
          .setValue(this.password)
          .onChange((value) => {
            this.password = value;
            this.refreshButtons();
          });
      });
    if (publication?.hasPassword) {
      new Setting(contentEl).setName(t("p.pub.password.remove")).addToggle((toggle) =>
        toggle.setValue(this.removePassword).onChange((value) => {
          this.removePassword = value;
          if (value) this.password = "";
          this.render();
        }),
      );
    }

    if (this.error) contentEl.createEl("p", { cls: "websync-error-text", text: this.error });

    const actions = new Setting(contentEl);
    actions.settingEl.addClass("websync-publish-actions");
    if (publication) {
      actions.addButton((button) => {
        button.setButtonText(t("p.pub.stop")).setWarning().setDisabled(this.busy).onClick(() => void this.stop());
        button.buttonEl.addClass("websync-publish-stop"); // pushed to the left edge, the others stay on the right
      });
    }
    if (publication) {
      actions.addButton((button) => button.setButtonText(t("p.pub.update")).setDisabled(this.busy || this.customInvalid()).onClick(() => void this.publish()));
      actions.addButton((button) => {
        button.setButtonText(t("p.pub.save")).setCta().onClick(() => void this.save());
        this.saveButton = button.buttonEl;
        this.refreshButtons();
      });
    } else {
      actions.addButton((button) => button.setButtonText(t("common.cancel")).onClick(() => this.close()));
      actions.addButton((button) =>
        button
          .setButtonText(t("p.pub.publish"))
          .setCta()
          .setDisabled(this.busy || this.customInvalid())
          .onClick(() => void this.publish()),
      );
    }
  }

  private saveButton: HTMLButtonElement | null = null;

  /** "Save settings" only makes sense once something was changed. */
  private refreshButtons(): void {
    if (this.saveButton) this.saveButton.disabled = this.busy || this.customInvalid() || Object.keys(this.options()).length === 0;
  }
}

function describe(err: unknown): string {
  if (err instanceof WebSyncApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

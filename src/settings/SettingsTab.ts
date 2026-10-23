import { t } from "../i18n/index.js";
import { App, Notice, Platform, PluginSettingTab, Setting, type TextComponent } from "obsidian";
import type WebSyncPlugin from "../main.js";
import type { LinkedVaultConfig } from "../types.js";
import { VaultLinkError, type VaultLinkResult } from "../sync/VaultLinkManager.js";
import { WebSyncApiError } from "../sync/httpClient.js";
import { formatBytes } from "../ui/historyFormat.js";

type PairingState = "idle" | "starting" | "waiting" | "denied" | "expired" | "error";

function describeError(err: unknown): string {
  if (err instanceof VaultLinkError) return err.message;
  if (err instanceof WebSyncApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

interface PassphraseFormOptions {
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (passphrase: string, remember: boolean) => void | Promise<void>;
  onCancel?: () => void;
}

/**
 * Settings tab with three sections:
 *   1. Account          - server URL, browser-based device-pairing login
 *                          (like `gh auth login --web`), logout.
 *   2. Vault-Verknüpfung - local passphrase unlock for the ONE vault chosen
 *                          on the web panel during pairing (no in-plugin
 *                          vault list/creation any more - see
 *                          VaultLinkManager.ts).
 *   3. Sync-Status       - last sync time, manual sync, pause toggle, and an
 *                          optional live-sync connection indicator.
 *
 * Follows the common Obsidian settings-tab pattern of re-rendering the whole
 * tab (`this.display()`) after every state change instead of hand-patching
 * the DOM - simpler to keep correct for a tab with this much conditional
 * form state.
 */
export class WebSyncSettingsTab extends PluginSettingTab {
  /**
   * Which collapsible sections are open. Kept on the tab (not re-derived) because
   * every state change re-renders the whole tab via display().
   */
  private readonly openSections = new Set<string>(["account", "vault", "sync"]);

  // --- Account / device-pairing state ---
  private deviceName = "";
  private pairingState: PairingState = "idle";
  private pairingCode: string | null = null;
  private verificationUrl: string | null = null;
  private pollToken: string | null = null;
  private pairingError: string | null = null;
  private pollTimer: ReturnType<typeof window.setInterval> | null = null;

  // --- Vault unlock state ---
  // Set once a device-pairing approval hands us a vaultId that isn't (yet)
  // the currently linked+configured one - see handleApproved().
  private pendingUnlockVaultId: string | null = null;
  private linkBusy = false;
  private linkError: string | null = null;

  constructor(
    app: App,
    private readonly plugin: WebSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "WebSync" });

    this.renderAccountSection(containerEl);
    this.renderVaultLinkSection(containerEl);
    this.renderSyncStatusSection(containerEl);
    this.renderConfigSyncSection(containerEl);
  }

  /**
   * A collapsible group (native <details>, so it works with touch and keyboard
   * and needs no extra library). Returns the element to render the group's
   * settings into. `nested` gives the lighter style used for a dropdown inside
   * a section.
   */
  private section(parent: HTMLElement, id: string, title: string, options: { nested?: boolean; summary?: string } = {}): HTMLElement {
    const details = parent.createEl("details", { cls: options.nested ? "websync-dropdown" : "websync-section" });
    details.open = this.openSections.has(id);
    details.addEventListener("toggle", () => {
      if (details.open) this.openSections.add(id);
      else this.openSections.delete(id);
    });

    const summary = details.createEl("summary", { cls: "websync-section-title" });
    summary.createSpan({ text: title });
    if (options.summary) summary.createSpan({ cls: "websync-section-summary", text: options.summary });
    return details.createDiv({ cls: "websync-section-body" });
  }

  hide(): void {
    // The settings tab can be closed mid-pairing (e.g. user switches to
    // another settings pane) - stop polling rather than leaking a timer that
    // keeps firing (and re-rendering a DOM nobody can see) in the
    // background. A fresh pairing attempt can always be started again.
    this.clearPollTimer();
  }

  // ============================================================
  // 1. Account
  // ============================================================

  private renderAccountSection(parent: HTMLElement): void {
    const containerEl = this.section(parent, "account", "Account");

    new Setting(containerEl)
      .setName(t("p.serverUrl"))
      .setDesc(t("p.serverUrlHint"))
      .addText((text) =>
        text
          .setPlaceholder("https://websync.example.com")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    if (this.plugin.settings.sessionToken) {
      new Setting(containerEl)
        .setName(t("p.signedIn"))
        .setDesc(this.plugin.settings.accountUsername ?? "")
        .addButton((btn) =>
          btn.setButtonText(t("p.signOut")).onClick(() => {
            void this.logout();
          }),
        );
      this.renderDeviceNameSetting(containerEl);
      return;
    }

    this.renderDevicePairingFlow(containerEl, "login");
  }

  /**
   * Renders the device-pairing widget: a device-name field + start button
   * when idle, the pairing code + "waiting" state while polling, or a
   * denied/expired message with a retry button. Used both here (to log in
   * when there's no session at all) and from the vault-link section below
   * (to link a vault while already logged in, e.g. after t("p.unlink")).
   */
  private renderDevicePairingFlow(containerEl: HTMLElement, mode: "login" | "link"): void {
    if (this.pairingState === "idle") {
      let deviceName = this.deviceName || this.plugin.settings.deviceName || this.defaultDeviceName();

      new Setting(containerEl)
        .setName(t("p.deviceName"))
        .setDesc(t("p.deviceNameHint"))
        .addText((text) => text.setValue(deviceName).onChange((v) => (deviceName = v.trim())));

      new Setting(containerEl).addButton((btn) =>
        btn
          .setButtonText(mode === "link" ? t("p.linkVault") : t("p.signInBrowser"))
          .setCta()
          .onClick(() => {
            this.deviceName = deviceName || this.defaultDeviceName();
            void this.startDevicePairing();
          }),
      );
      return;
    }

    if (this.pairingState === "starting") {
      containerEl.createEl("p", { text: t("p.starting") });
      return;
    }

    if (this.pairingState === "waiting") {
      // hide() (called when the user navigates away from this tab) stops
      // the poll timer so it doesn't keep firing into a hidden tab forever;
      // if they come back while still "waiting", restart it here rather
      // than leaving the UI stuck with no active polling.
      if (this.pollToken && this.pollTimer === null) this.startPolling();

      const wrap = containerEl.createDiv({ cls: "websync-pairing" });
      wrap.createEl("p", { text: t("p.confirmCode") });
      wrap.createEl("div", { text: this.pairingCode ?? "", cls: "websync-pairing-code" });

      if (this.verificationUrl) {
        const linkPara = wrap.createEl("p", { cls: "websync-pairing-link" });
        linkPara.appendText(t("p.browserNotOpening"));
        const link = linkPara.createEl("a", { text: this.verificationUrl, href: this.verificationUrl });
        link.setAttr("target", "_blank");
        link.setAttr("rel", "noopener noreferrer");
      }

      wrap.createEl("p", { text: t("p.waiting") });

      new Setting(wrap).addButton((btn) => btn.setButtonText(t("common.cancel")).onClick(() => this.cancelPairing()));
      return;
    }

    if (this.pairingState === "denied") {
      containerEl.createEl("p", { text: t("p.denied"), cls: "websync-error-text" });
      new Setting(containerEl).addButton((btn) =>
        btn
          .setButtonText(t("p.retry"))
          .setCta()
          .onClick(() => {
            this.pairingState = "idle";
            this.display();
          }),
      );
      return;
    }

    // "expired" (terminal poll status, or any poll failure/404 - see
    // pollOnce()) and "error" (starting the pairing itself failed, e.g. bad
    // server URL) both land here, just with different messages.
    containerEl.createEl("p", {
      text:
        this.pairingState === "expired"
          ? t("p.expired")
          : (this.pairingError ?? t("p.signInFailed")),
      cls: "websync-error-text",
    });
    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText(t("p.retry"))
        .setCta()
        .onClick(() => {
          this.pairingState = "idle";
          this.pairingError = null;
          this.display();
        }),
    );
  }

  /** Rename this device (server-side), so it's recognisable in the web panel and next to live cursors. */
  private renderDeviceNameSetting(containerEl: HTMLElement): void {
    const initial = this.plugin.settings.deviceName ?? this.defaultDeviceName();
    let name = initial;
    let input: TextComponent | null = null;

    new Setting(containerEl)
      .setName(t("p.deviceName"))
      .setDesc(t("p.deviceNameLong"))
      .addText((text) => {
        input = text;
        text.setValue(initial).onChange((value) => (name = value.trim()));
      })
      .addButton((btn) => btn.setButtonText(t("p.save")).onClick(() => void this.renameDevice(name)));

    // Devices paired before this setting existed don't have the name stored locally yet - take it from the server.
    if (!this.plugin.settings.deviceName) {
      void this.plugin.remoteApi
        .getCurrentDeviceName()
        .then(async (remoteName) => {
          if (!remoteName) return;
          this.plugin.settings.deviceName = remoteName;
          await this.plugin.saveSettings();
          if (name === initial) {
            name = remoteName; // the user hasn't typed anything yet
            input?.setValue(remoteName);
          }
        })
        .catch((err) => console.error("WebSync: Gerätename konnte nicht geladen werden", err));
    }
  }

  private async renameDevice(name: string): Promise<void> {
    if (!name) {
      new Notice(t("p.nameEmpty"));
      return;
    }
    try {
      await this.plugin.remoteApi.renameCurrentDevice(name);
      this.plugin.settings.deviceName = name;
      await this.plugin.saveSettings();
      new Notice(t("p.nameChanged", { name }));
    } catch (err) {
      new Notice(t("p.renameFailed", { error: describeError(err) }));
    }
  }

  private defaultDeviceName(): string {
    return t("p.defaultDevice", { platform: Platform.isMobile ? "Mobile" : navigator.platform || "Desktop" });
  }

  private async startDevicePairing(): Promise<void> {
    this.pairingState = "starting";
    this.pairingError = null;
    this.display();
    try {
      const result = await this.plugin.authClient.startDeviceAuth(this.deviceName || this.defaultDeviceName());
      this.pairingCode = result.pairingCode;
      this.verificationUrl = result.verificationUrl;
      this.pollToken = result.pollToken;
      this.pairingState = "waiting";
      this.display();
      // window.open (not require('electron').shell or any Node API) is the
      // correct cross-platform way to hand off to the system/external
      // browser from an Obsidian plugin on both Electron desktop and mobile
      // WebView. The clickable link rendered above is the fallback in case
      // this doesn't fire in some environment.
      window.open(result.verificationUrl, "_blank");
      this.startPolling();
    } catch (err) {
      this.pairingState = "error";
      this.pairingError = describeError(err);
      this.display();
    }
  }

  private startPolling(): void {
    this.clearPollTimer();
    this.pollTimer = window.setInterval(() => void this.pollOnce(), 2000);
  }

  private async pollOnce(): Promise<void> {
    const pollToken = this.pollToken;
    if (!pollToken) return;
    try {
      const result = await this.plugin.authClient.pollDeviceAuth(pollToken);
      if (result.status === "pending") return; // keep polling

      this.clearPollTimer();

      if (result.status === "approved" && result.sessionToken && result.vaultId) {
        await this.handleApproved(result.sessionToken, result.vaultId);
      } else if (result.status === "denied") {
        this.pairingState = "denied";
        this.display();
      } else {
        // "expired", or an "approved" response missing its payload (should
        // not happen per the DTO, but don't hang forever if it does).
        this.pairingState = "expired";
        this.display();
      }
    } catch (err) {
      // Any poll error - including the 404 the server returns once a
      // pairing has already resolved and is polled again - is terminal:
      // stop polling and let the user retry, per AuthClient.pollDeviceAuth.
      console.error("WebSync: Device-Pairing-Poll fehlgeschlagen", err);
      this.clearPollTimer();
      this.pairingState = "expired";
      this.display();
    }
  }

  private cancelPairing(): void {
    this.clearPollTimer();
    this.pollToken = null;
    this.pairingCode = null;
    this.verificationUrl = null;
    this.pairingState = "idle";
    this.display();
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * A device pairing was approved on the web panel: we now have a fresh
   * session token and the id of the vault the user picked there. If it's
   * the same vault we already have configured, just let the normal
   * cached-key-or-manual-unlock path (tryStartSync / the "gesperrt" unlock
   * form below) handle it. Otherwise the new vault still needs its
   * encryption passphrase entered once, locally - that secret never touches
   * the server, so no browser step can hand it over.
   */
  private async handleApproved(sessionToken: string, vaultId: string): Promise<void> {
    this.plugin.settings.sessionToken = sessionToken;
    // DevicePollResponse doesn't carry an expiry (unlike the old
    // session-token response) - leave it unset rather than guessing one.
    this.plugin.settings.sessionExpiresAt = null;
    this.plugin.settings.deviceName = this.deviceName || this.defaultDeviceName();
    await this.plugin.saveSettings();

    try {
      const me = await this.plugin.authClient.getMe(sessionToken);
      this.plugin.settings.accountUsername = me.username;
      await this.plugin.saveSettings();
    } catch (err) {
      console.error("WebSync: Kontoinformationen konnten nicht geladen werden", err);
    }

    this.pairingState = "idle";
    this.pairingCode = null;
    this.verificationUrl = null;
    this.pollToken = null;

    const linked = this.plugin.settings.linkedVault;
    if (linked && linked.vaultId === vaultId) {
      await this.plugin.tryStartSync();
    } else {
      this.plugin.settings.linkedVault = null;
      this.plugin.settings.rememberKey = false;
      this.plugin.settings.cachedKeyMaterial = null;
      this.plugin.cryptoService.lock();
      await this.plugin.saveSettings();
      await this.plugin.tryStartSync(); // stops any previous sync engine
      this.pendingUnlockVaultId = vaultId;
    }

    this.display();
  }

  private async logout(): Promise<void> {
    const token = this.plugin.settings.sessionToken;
    try {
      if (token) await this.plugin.authClient.logout(token);
    } catch (err) {
      console.error("WebSync: Logout fehlgeschlagen", err);
    }
    this.plugin.settings.sessionToken = null;
    this.plugin.settings.sessionExpiresAt = null;
    this.plugin.settings.accountUsername = null;
    this.pendingUnlockVaultId = null;
    this.pairingState = "idle";
    await this.plugin.saveSettings();
    await this.plugin.tryStartSync(); // stops sync - sessionToken is gone
    this.display();
  }

  // ============================================================
  // 2. Vault-Verknüpfung
  // ============================================================

  /**
   * Storage used / quota with a bar, the plan state (trial, read-only) and a link to the plan page. Shown in the vault
   * and the sync section; the numbers come from the account the plugin refreshes after every sync.
   */
  private renderStorageSetting(containerEl: HTMLElement): void {
    const account = this.plugin.account;
    if (!account) {
      // Not loaded yet (or offline): ask once, the tab re-renders when the answer is in.
      void this.plugin.refreshAccount(true).then(() => this.plugin.account && this.display());
      return;
    }
    const used = account.storageUsedBytes;
    const quota = account.storageQuotaBytes;
    const full = account.readOnly ? false : quota !== null && quota > 0 && used >= quota;
    const percent = quota ? Math.min(100, Math.floor((used / quota) * 100)) : 0;
    const date = (iso: string) => new Date(iso).toLocaleDateString();

    const setting = new Setting(containerEl)
      .setName(t("p.storage"))
      .setDesc(quota ? t("p.storageOf", { used: formatBytes(used), quota: formatBytes(quota), percent }) : t("p.storageNoLimit", { used: formatBytes(used) }));

    if (quota) {
      const bar = setting.descEl.createDiv({ cls: "websync-storage-bar" });
      const fill = bar.createDiv({ cls: "websync-storage-fill" });
      fill.style.width = `${percent}%`;
      if (full) fill.addClass("is-full");
      else if (used >= quota * 0.8) fill.addClass("is-nearly");
    }
    if (account.readOnly) setting.descEl.createDiv({ cls: "websync-storage-warning", text: t("p.readOnly") });
    else if (full) setting.descEl.createDiv({ cls: "websync-storage-warning", text: t("p.storageFull") });
    if (account.billingState === "trial" && account.trialEndsAt) setting.descEl.createDiv({ text: t("p.trialEnds", { date: date(account.trialEndsAt) }) });
    if (account.dataDeleteAt && account.billingState !== "active") setting.descEl.createDiv({ cls: "websync-storage-warning", text: t("p.deleteOn", { date: date(account.dataDeleteAt) }) });

    if (account.billingState !== "unmanaged" && account.webUrl) {
      const planUrl = `${account.webUrl.replace(/\/+$/, "")}/account/billing`;
      setting.addButton((btn) => btn.setButtonText(t("p.openPlanBtn")).onClick(() => window.open(planUrl, "_blank")));
    }
  }

  private renderVaultLinkSection(parent: HTMLElement): void {
    if (!this.plugin.settings.sessionToken) return;
    const containerEl = this.section(parent, "vault", t("p.vaultLink"));

    const linked = this.plugin.settings.linkedVault;
    if (linked && !this.pendingUnlockVaultId) {
      new Setting(containerEl)
        .setName(t("p.linkedTo", { name: linked.vaultName }))
        .setDesc(this.plugin.cryptoService.isUnlocked() ? t("p.unlocked") : t("p.locked"))
        .addButton((btn) =>
          btn
            .setButtonText(t("p.unlink"))
            .setWarning()
            .onClick(() => void this.unlinkVault()),
        );

      this.renderStorageSetting(containerEl);

      if (!this.plugin.cryptoService.isUnlocked()) {
        this.renderUnlockForm(containerEl, linked);
      }
      return;
    }

    if (this.pendingUnlockVaultId) {
      containerEl.createEl("p", {
        text: t("p.chosenEnterPass"),
      });
      this.renderPassphraseForm(containerEl, {
        submitLabel: t("p.unlock"),
        busy: this.linkBusy,
        error: this.linkError,
        onSubmit: (passphrase, remember) => this.unlockPendingVault(passphrase, remember),
      });
      return;
    }

    containerEl.createEl("p", {
      text: t("p.noVault"),
    });
    this.renderDevicePairingFlow(containerEl, "link");
  }

  /** Shared passphrase + "remember key" form, reused for unlocking a newly-picked vault and for re-unlocking an already-linked one. */
  private renderPassphraseForm(containerEl: HTMLElement, opts: PassphraseFormOptions): void {
    const wrap = containerEl.createDiv({ cls: "websync-passphrase-form" });

    let passphrase = "";
    let remember = false;

    new Setting(wrap).setName(t("p.passphrase")).addText((text) => {
      text.inputEl.type = "password";
      text.onChange((v) => (passphrase = v));
    });

    new Setting(wrap)
      .setName(t("p.rememberKey"))
      .setDesc(
        t("p.rememberKeyHint"),
      )
      .addToggle((toggle) => toggle.setValue(false).onChange((v) => (remember = v)));

    if (opts.error) {
      wrap.createEl("p", { text: opts.error, cls: "websync-error-text" });
    }

    const row = new Setting(wrap);
    row.addButton((btn) =>
      btn
        .setButtonText(opts.submitLabel)
        .setCta()
        .setDisabled(opts.busy)
        .onClick(() => {
          if (!passphrase) {
            this.linkError = t("p.enterPass");
            this.display();
            return;
          }
          void opts.onSubmit(passphrase, remember);
        }),
    );
    if (opts.onCancel) {
      const onCancel = opts.onCancel;
      row.addButton((btn) => btn.setButtonText(t("common.cancel")).onClick(onCancel));
    }
  }

  private async unlockPendingVault(passphrase: string, remember: boolean): Promise<void> {
    if (!this.pendingUnlockVaultId) return;
    this.linkBusy = true;
    this.linkError = null;
    this.display();
    try {
      const result = await this.plugin.vaultLinkManager.unlockVault(this.pendingUnlockVaultId, passphrase, remember);
      await this.applyVaultLink(result, remember);
      this.pendingUnlockVaultId = null;
      new Notice(t("p.vaultLinked", { name: result.config.vaultName }));
    } catch (err) {
      this.linkError = describeError(err);
    } finally {
      this.linkBusy = false;
      this.display();
    }
  }

  private async applyVaultLink(result: VaultLinkResult, remember: boolean): Promise<void> {
    this.plugin.settings.linkedVault = result.config;
    this.plugin.settings.rememberKey = remember;
    this.plugin.settings.cachedKeyMaterial = remember && result.rootBitsBase64 ? { rootBitsBase64: result.rootBitsBase64 } : null;
    this.plugin.settings.lastSyncAt = null;
    await this.plugin.saveSettings();
    await this.plugin.tryStartSync();
  }

  private renderUnlockForm(containerEl: HTMLElement, linked: LinkedVaultConfig): void {
    this.renderPassphraseForm(containerEl, {
      submitLabel: t("p.unlock"),
      busy: this.linkBusy,
      error: this.linkError,
      onSubmit: async (passphrase, remember) => {
        this.linkBusy = true;
        this.linkError = null;
        this.display();
        try {
          let rootBitsBase64: string | null = null;
          if (linked.memberKey) {
            // Shared vault: the passphrase opens the user's own wrapped copy of the key, not the owner's kdf parameters.
            rootBitsBase64 = (await this.plugin.cryptoService.unlockMemberWithPassphrase(passphrase, linked.vaultId, linked.memberKey)).rootBitsBase64;
          } else if (remember) {
            rootBitsBase64 = (
              await this.plugin.cryptoService.unlockAndDeriveRootBitsForCaching(passphrase, linked.kdfSalt, linked.kdfIterations)
            ).rootBitsBase64;
          } else {
            await this.plugin.cryptoService.unlockWithPassphrase(passphrase, linked.kdfSalt, linked.kdfIterations);
          }
          const ok = await this.plugin.cryptoService.verifyAgainstBlob(
            linked.vaultName,
            linked.verificationBlob,
            linked.verificationNonce,
          );
          if (!ok) throw new VaultLinkError(t("p.wrongPass"));
          if (remember && rootBitsBase64) {
            this.plugin.settings.rememberKey = true;
            this.plugin.settings.cachedKeyMaterial = { rootBitsBase64 };
          }
          await this.plugin.saveSettings();
          await this.plugin.tryStartSync();
        } catch (err) {
          this.plugin.cryptoService.lock();
          this.linkError = describeError(err);
        } finally {
          this.linkBusy = false;
          this.display();
        }
      },
    });
  }

  private async unlinkVault(): Promise<void> {
    // Note: the local IndexedDB mapping table for this vault (see
    // LocalIndex.ts) is deliberately left in place, not destroyed - if the
    // user re-links the same vault later it's simply reused; it just sits
    // unused otherwise. Call `LocalIndex.destroy(vaultId)` explicitly if a
    // future UI wants an explicit "forget this vault" action.
    this.plugin.settings.linkedVault = null;
    this.plugin.settings.rememberKey = false;
    this.plugin.settings.cachedKeyMaterial = null;
    this.plugin.settings.lastSyncAt = null;
    this.plugin.cryptoService.lock();
    await this.plugin.saveSettings();
    await this.plugin.tryStartSync();
    this.display();
  }

  // ============================================================
  // 3. Sync-Status
  // ============================================================

  private renderSyncStatusSection(parent: HTMLElement): void {
    const containerEl = this.section(parent, "sync", t("p.syncStatus"));

    if (this.plugin.settings.sessionToken) this.renderStorageSetting(containerEl);

    new Setting(containerEl)
      .setName(t("p.lastSync"))
      .setDesc(this.plugin.settings.lastSyncAt ? new Date(this.plugin.settings.lastSyncAt).toLocaleString() : t("p.never"));

    if (this.plugin.syncEngine) {
      new Setting(containerEl)
        .setName(t("p.liveSync"))
        .setDesc(this.plugin.liveSyncConnected ? t("p.connected") : t("p.disconnected"));
    }

    new Setting(containerEl)
      .setName(t("p.collab"))
      .setDesc(
        t("p.collabHint"),
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.collabEnabled).onChange(async (value) => {
          this.plugin.settings.collabEnabled = value;
          await this.plugin.saveSettings();
          this.plugin.refreshCollab();
        }),
      );

    new Setting(containerEl).setName(t("p.syncNow")).addButton((btn) =>
      btn
        .setButtonText(t("p.syncNow"))
        .setDisabled(!this.plugin.syncEngine)
        .onClick(async () => {
          await this.plugin.runManualSync();
          this.display();
        }),
    );

    new Setting(containerEl)
      .setName(t("p.paused"))
      .setDesc(t("p.pausedHint"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncPaused).onChange(async (value) => {
          this.plugin.settings.syncPaused = value;
          await this.plugin.saveSettings();
          this.plugin.refreshCollab();
        }),
      );
  }

  // ============================================================
  // 4. Einstellungen synchronisieren (.obsidian/* - plugins, themes, etc.)
  // ============================================================

  private renderConfigSyncSection(parent: HTMLElement): void {
    const config = this.plugin.settings.configSync;
    const containerEl = this.section(parent, "config", t("p.syncSettings"), {
      summary: config.enabled ? "an" : "aus",
    });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: t("p.syncSettingsHint"),
    });

    new Setting(containerEl)
      .setName(t("p.syncSettings"))
      .setDesc(t("p.syncSettingsToggle"))
      .addToggle((toggle) =>
        toggle.setValue(config.enabled).onChange(async (value) => {
          config.enabled = value;
          if (value) this.openSections.add("config-categories"); // show the choices right away
          await this.plugin.saveSettings();
          if (value) void this.plugin.configSyncEngine?.run().catch((err) => console.error("WebSync: Einstellungs-Sync fehlgeschlagen", err));
          this.display();
        }),
      );

    // Nothing to choose while it's off - no greyed-out list cluttering the tab.
    if (!config.enabled) return;

    const categories: Array<{
      key: "coreSettings" | "communityPlugins" | "themes" | "snippets" | "hotkeys" | "workspace";
      name: string;
      desc: string;
    }> = [
      { key: "coreSettings", name: t("p.catCore"), desc: t("p.catCoreHint") },
      {
        key: "communityPlugins",
        name: t("p.catPlugins"),
        desc: t("p.catPluginsHint"),
      },
      { key: "themes", name: t("p.catThemes"), desc: t("p.catThemesHint") },
      { key: "snippets", name: t("p.catSnippets"), desc: t("p.catSnippetsHint") },
      { key: "hotkeys", name: t("p.catHotkeys"), desc: t("p.catHotkeysHint") },
      {
        key: "workspace",
        name: t("p.catWorkspace"),
        desc: t("p.catWorkspaceHint"),
      },
    ];

    const countActive = () => categories.filter((category) => config[category.key]).length;
    const dropdown = this.section(containerEl, "config-categories", t("p.whatToSync"), {
      nested: true,
      summary: `${countActive()} von ${categories.length} aktiv`,
    });

    for (const category of categories) {
      new Setting(dropdown)
        .setName(category.name)
        .setDesc(category.desc)
        .addToggle((toggle) =>
          toggle.setValue(config[category.key]).onChange(async (value) => {
            config[category.key] = value;
            await this.plugin.saveSettings();
            void this.plugin.configSyncEngine?.run().catch((err) => console.error("WebSync: Einstellungs-Sync fehlgeschlagen", err));
            // Keep the "n von 6 aktiv" hint current without collapsing the dropdown.
            dropdown.parentElement?.querySelector(".websync-section-summary")?.setText(`${countActive()} von ${categories.length} aktiv`);
          }),
        );
    }
  }
}

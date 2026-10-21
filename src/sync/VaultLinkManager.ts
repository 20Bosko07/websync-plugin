import { t } from "../i18n/index.js";
import type { VaultDetail } from "@websync/shared";
import type { CryptoService } from "./CryptoService.js";
import type { RemoteApiClient } from "./RemoteApiClient.js";
import type { LinkedVaultConfig } from "../types.js";

export class VaultLinkError extends Error {}

export interface VaultLinkResult {
  config: LinkedVaultConfig;
  /** Set only when the caller asked to "remember" the key on this device. */
  rootBitsBase64: string | null;
}

/**
 * Handles unlocking the ONE server vault the user already picked on the web
 * panel during device pairing (see AuthClient.startDeviceAuth /
 * SettingsTab.ts): fetch its KDF params + verification blob, derive keys
 * locally from the user-supplied passphrase, and verify the passphrase - and
 * only THEN report success, never before.
 *
 * There used to also be `listVaults`/`createVault` here for an in-plugin
 * vault picker/creation form - both are gone now that vault *selection*
 * happens on the web panel's `/pair` page as part of approving the device,
 * and vault *creation* lives on the web panel at `/vaults/new`. The
 * encryption passphrase itself never touches the server, so unlocking is
 * unavoidably still a local step.
 */
export class VaultLinkManager {
  constructor(
    private readonly remote: RemoteApiClient,
    private readonly cryptoService: CryptoService,
  ) {}

  async unlockVault(vaultId: string, passphrase: string, remember: boolean): Promise<VaultLinkResult> {
    const detail = await this.remote.getVaultDetail(vaultId);

    // A vault shared with the user is unlocked with their own passphrase for it, not with the owner's kdf parameters.
    const rootBitsBase64 = detail.memberKey
      ? await this.unlockMember(passphrase, detail.id, detail.memberKey, remember)
      : await this.unlock(passphrase, detail.kdfSalt, detail.kdfIterations, remember);

    const ok = await this.cryptoService.verifyAgainstBlob(detail.name, detail.verificationBlob, detail.verificationNonce);
    if (!ok) {
      this.cryptoService.lock();
      throw new VaultLinkError(
        t("p.wrongPassVault"),
      );
    }

    const config: LinkedVaultConfig = {
      vaultId: detail.id,
      vaultName: detail.name,
      kdfAlgo: detail.kdfAlgo,
      kdfSalt: detail.kdfSalt,
      kdfIterations: detail.kdfIterations,
      verificationBlob: detail.verificationBlob,
      verificationNonce: detail.verificationNonce,
      memberKey: detail.memberKey,
      lastSyncedGlobalVersion: 0,
    };

    return { config, rootBitsBase64 };
  }

  private async unlockMember(
    passphrase: string,
    vaultId: string,
    memberKey: NonNullable<VaultDetail["memberKey"]>,
    remember: boolean,
  ): Promise<string | null> {
    const derived = await this.cryptoService.unlockMemberWithPassphrase(passphrase, vaultId, memberKey);
    return remember ? derived.rootBitsBase64 : null;
  }

  private async unlock(
    passphrase: string,
    saltBase64: string,
    iterations: number,
    remember: boolean,
  ): Promise<string | null> {
    if (remember) {
      const derived = await this.cryptoService.unlockAndDeriveRootBitsForCaching(passphrase, saltBase64, iterations);
      return derived.rootBitsBase64;
    }
    await this.cryptoService.unlockWithPassphrase(passphrase, saltBase64, iterations);
    return null;
  }
}

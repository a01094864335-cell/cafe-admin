import { seed } from "../../shared/seed.js";
import { validate } from "../../shared/validate.js";

export const LEDGER_KEY = "cafe-admin-public-v1";
export const THEME_KEY = "cafe-admin-public-theme";
const LEGACY_KEY = "cafe-admin-unused-legacy";

// The legacy JSON shape is retained until the server migration has its own contract.
export type LedgerSnapshot = ReturnType<typeof validate>;
export interface LedgerRepository {
  load(): { data: LedgerSnapshot; ok: boolean; warning: string };
  save(next: LedgerSnapshot): void;
}
export interface LocalRepository extends LedgerRepository {
  loadTheme(): "light" | "dark";
  saveTheme(theme: "light" | "dark"): void;
  loadLegacyBackup(): string | null;
}

type StorageAccess = () => Pick<Storage, "getItem" | "setItem">;

/** Access storage lazily: disabled storage must not prevent the UI from opening. */
export function createLocalRepository(storage: StorageAccess): LocalRepository {
  return {
    load() {
      try {
        const raw = storage().getItem(LEDGER_KEY);
        return {
          data: raw ? validate(JSON.parse(raw)) : seed(),
          ok: true,
          warning: "",
        };
      } catch {
        return {
          data: seed(),
          ok: false,
          warning:
            "저장 자료를 읽지 못했습니다. 빈 장부를 임시 표시하며 기존 저장값은 덮어쓰지 않습니다.",
        };
      }
    },
    save(next) {
      // A failed validation or quota error must propagate before the UI swaps state.
      validate(next);
      storage().setItem(LEDGER_KEY, JSON.stringify(next));
    },
    loadTheme() {
      return storage().getItem(THEME_KEY) === "dark" ? "dark" : "light";
    },
    saveTheme(theme) {
      storage().setItem(THEME_KEY, theme);
    },
    loadLegacyBackup() {
      return storage().getItem(LEGACY_KEY);
    },
  };
}

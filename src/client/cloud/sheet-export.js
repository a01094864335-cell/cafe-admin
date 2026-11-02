import { workbookBytes } from "./xlsx.js";
import { backupSheets } from "../../shared/backup-sheets.js";
export { backupSheets } from "../../shared/backup-sheets.js";
export function sheetFile(backup) {
  return new Blob([workbookBytes(backupSheets(backup))], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

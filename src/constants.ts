/** Shared pipeline constants. */
export const BACKUP_PREFIX = "backups/";
export const DUMP_TIMEOUT_MS = 20 * 60 * 1000; // keep below the workflow job's timeout-minutes
export const ENCRYPT_TIMEOUT_MS = 10 * 60 * 1000;
export const TOOL_CHECK_TIMEOUT_MS = 30 * 1000;
export const MAX_BUFFER = 10 * 1024 * 1024;

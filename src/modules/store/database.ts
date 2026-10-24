import fs from "node:fs";
import path from "node:path";
import * as sqlite from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";
import { $logger } from "../../_libs/logger";
import { CONCOS_VERSION } from "../../_libs/version";
import { SCHEMA_STEPS } from "./schema";

export const DATABASE_FILE_NAME = "concos.db";
const MIGRATION_BACKUP_MARKER = ".bak-v";
const DAILY_BACKUP_MARKER = ".bak-daily-";
const MIGRATION_BACKUP_KEEP_COUNT = 3;
const DAILY_BACKUP_KEEP_COUNT = 7;

/**
 * Runs `work` inside BEGIN IMMEDIATE so the write lock is taken up front;
 * a deferred transaction that upgrades to a writer later fails with SQLITE_BUSY
 * instead of waiting on busy_timeout.
 */
export function runInTransaction<T>(database: DatabaseSync, work: () => T): T {
    database.exec("BEGIN IMMEDIATE");
    try {
        const result = work();
        database.exec("COMMIT");
        return result;
    }
    catch(ex) {
        database.exec("ROLLBACK");
        throw ex;
    }
}

function readSchemaVersion(database: DatabaseSync): number {
    const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
}

function readMetaValue(database: DatabaseSync, key: string): string | null {
    try {
        const row = database.prepare("SELECT value FROM meta WHERE key = :key").get({ key: key }) as { value: string } | undefined;
        if(row == null) {
            return null;
        }
        return row.value;
    }
    catch {
        // meta may be missing or shaped differently in a database made by a newer concos
        return null;
    }
}

function writeMetaValue(database: DatabaseSync, key: string, value: string): void {
    database.prepare(`
        INSERT INTO meta (key, value) VALUES (:key, :value)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `).run({ key: key, value: value });
}

/** A temporary backup copy this old is not being written any more: its process died mid-backup. */
const STALE_TEMPORARY_BACKUP_MS = 60 * 60 * 1000;

function pruneBackups(dataDirectory: string, marker: string, keepCount: number): void {
    const prefix = `${DATABASE_FILE_NAME}${marker}`;
    const names = fs.readdirSync(dataDirectory).filter((name) => name.startsWith(prefix) == true);
    const backupNames = names.filter((name) => name.includes(".tmp-") == false).sort().reverse();
    for(const name of backupNames.slice(keepCount)) {
        fs.rmSync(path.join(dataDirectory, name), { force: true });
    }
    // a fresh temporary copy may belong to another process backing up right now; leave those
    for(const name of names.filter((name) => name.includes(".tmp-") == true)) {
        const file = path.join(dataDirectory, name);
        try {
            if(Date.now() - fs.statSync(file).mtimeMs > STALE_TEMPORARY_BACKUP_MS) {
                fs.rmSync(file, { force: true });
            }
        }
        catch {
            // removed by another process between the listing and the check
        }
    }
}

/** Migration backups are mandatory; daily backups remain best effort. Both include the WAL. */
async function backupDatabase(database: DatabaseSync, targetPath: string, required = false): Promise<void> {
    const _logger = $logger.child({ context: "backupDatabase", target_path: targetPath });
    if(typeof sqlite.backup != "function" && !required) {
        _logger.warn("skipped backup: node:sqlite backup() needs node 23.8 or newer");
        return;
    }
    const temporaryPath = `${targetPath}.tmp-${process.pid}`;
    try {
        if(typeof sqlite.backup == "function") await sqlite.backup(database, temporaryPath);
        else database.prepare("VACUUM INTO ?").run(temporaryPath);
        fs.renameSync(temporaryPath, targetPath);
    }
    catch(ex) {
        fs.rmSync(temporaryPath, { force: true });
        _logger.error(ex, "database backup failed");
        if(required) throw new Error("migration stopped because the database backup failed", { cause: ex });
    }
}

/**
 * Opens the shared database file, creating or migrating it as needed.
 *
 * Flow:
 *  1) Open with WAL, busy timeout and foreign keys
 *  2) Refuse a schema newer than this build knows
 *  3) Back up, then run each missing step in its own transaction
 *  4) Record provenance in meta and take the first backup of the day
 */
export async function openDatabase(dataDirectory: string, options: { busyTimeoutMs?: number } = {}): Promise<DatabaseSync> {
    // (1) Open
    fs.mkdirSync(dataDirectory, { recursive: true });
    const databasePath = path.join(dataDirectory, DATABASE_FILE_NAME);
    let _logger = $logger.child({ context: "openDatabase", database_path: databasePath });
    const database = new sqlite.DatabaseSync(databasePath);
    try {
        database.exec(`
            PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000};
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
        `);

        // (2) Newer schema
        const expectedVersion = SCHEMA_STEPS.length;
        const currentVersion = readSchemaVersion(database);
        _logger = _logger.child({ schema_version: currentVersion, expected_version: expectedVersion });
        if(currentVersion > expectedVersion) {
            const lastOpenedBy = readMetaValue(database, "last_opened_by_version") ?? "unknown";
            throw new Error(
                `the concos database was upgraded by concos ${lastOpenedBy} and this concos ${CONCOS_VERSION} cannot read it; update concos`
            );
        }

        // (3) Migrate
        if(currentVersion < expectedVersion) {
            if(currentVersion > 0) {
                const stamp = new Date().toISOString().replace(/[:.]/g, "-");
                const backupPath = path.join(dataDirectory, `${DATABASE_FILE_NAME}${MIGRATION_BACKUP_MARKER}${currentVersion}-${stamp}`);
                await backupDatabase(database, backupPath, true);
                pruneBackups(dataDirectory, MIGRATION_BACKUP_MARKER, MIGRATION_BACKUP_KEEP_COUNT);
            }
            for(let version = currentVersion + 1; version <= expectedVersion; version++) {
                runInTransaction(database, () => {
                    // another bridge may have applied this step while this one waited for the write lock
                    if(readSchemaVersion(database) >= version) {
                        return;
                    }
                    database.exec(SCHEMA_STEPS[version - 1]);
                    const now = new Date().toISOString();
                    if(version == 1) {
                        writeMetaValue(database, "created_by_version", CONCOS_VERSION);
                        writeMetaValue(database, "created_at", now);
                    }
                    writeMetaValue(database, "last_migrated_by_version", CONCOS_VERSION);
                    writeMetaValue(database, "last_migrated_at", now);
                    database.exec(`PRAGMA user_version = ${version}`);
                });
                _logger.info(`database schema migrated to ${version}`);
            }
        }

        // (4) Provenance and daily backup
        runInTransaction(database, () => {
            writeMetaValue(database, "last_opened_by_version", CONCOS_VERSION);
        });
        const today = new Date().toISOString().slice(0, 10);
        const dailyBackupPath = path.join(dataDirectory, `${DATABASE_FILE_NAME}${DAILY_BACKUP_MARKER}${today}`);
        if(fs.existsSync(dailyBackupPath) == false) {
            await backupDatabase(database, dailyBackupPath);
            pruneBackups(dataDirectory, DAILY_BACKUP_MARKER, DAILY_BACKUP_KEEP_COUNT);
        }
        return database;
    }
    catch(ex) {
        database.close();
        throw ex;
    }
}

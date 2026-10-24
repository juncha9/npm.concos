import os from "node:os";
import path from "node:path";

/**
 * Per-user folder holding the database and its backups.
 * CONCOS_HOME overrides the platform default (tests and diagnostics use it).
 */
export function resolveDataDirectory(): string {
    const override = process.env.CONCOS_HOME;
    let dataDirectory: string;
    if(override != null && override != "") {
        dataDirectory = path.resolve(override);
    }
    else if(process.platform == "win32") {
        const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
        dataDirectory = path.join(localAppData, "concos");
    }
    else if(process.platform == "darwin") {
        dataDirectory = path.join(os.homedir(), "Library", "Application Support", "concos");
    }
    else {
        const stateHome = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
        dataDirectory = path.join(stateHome, "concos");
    }

    // SQLite file locking does not hold across the WSL /mnt/<drive> boundary or network shares.
    if(process.platform == "linux" && dataDirectory.startsWith("/mnt/") == true) {
        throw new Error("concos data directory must be on a local Linux filesystem, not under /mnt/");
    }
    return dataDirectory;
}

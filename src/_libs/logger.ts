export interface Logger {
    child(bindings: Record<string, unknown>): Logger;
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(error: unknown, message: string): void;
}

const LOG_LEVEL_RANK: Record<string, number> = {
    none: 0,
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
};

const DEFAULT_LOG_LEVEL = "info";

let stderrBroken = false;
process.stderr.on("error", () => {
    stderrBroken = true;
});

function writeLine(line: string): void {
    if(stderrBroken == true) {
        return;
    }
    try {
        process.stderr.write(`${line}\n`);
    }
    catch {
        stderrBroken = true;
    }
}

function resolveMinimumRank(): number {
    const configuredLevel = process.env.CONCOS_LOG_LEVEL ?? DEFAULT_LOG_LEVEL;
    const rank = LOG_LEVEL_RANK[configuredLevel];
    if(rank == null) {
        return LOG_LEVEL_RANK[DEFAULT_LOG_LEVEL];
    }
    if(rank == 0) {
        return Number.POSITIVE_INFINITY;
    }
    return rank;
}

function createLogger(bindings: Record<string, unknown>): Logger {
    const minimumRank = resolveMinimumRank();

    const write = (level: string, message: string, detail: string | null): void => {
        if(LOG_LEVEL_RANK[level] < minimumRank) {
            return;
        }
        let line = `${new Date().toISOString()} [concos] [${level}] ${message}`;
        if(Object.keys(bindings).length > 0) {
            line += ` ${JSON.stringify(bindings)}`;
        }
        if(detail != null) {
            line += `\n${detail}`;
        }
        writeLine(line);
    };

    return {
        child: (extra) => createLogger({ ...bindings, ...extra }),
        debug: (message) => write("debug", message, null),
        info: (message) => write("info", message, null),
        warn: (message) => write("warn", message, null),
        error: (error, message) => {
            let detail = String(error);
            if(error instanceof Error && error.stack != null) {
                detail = error.stack;
            }
            write("error", message, detail);
        },
    };
}

/** Writes to stderr only: stdout of the MCP bridge carries protocol messages. */
export const $logger: Logger = createLogger({});

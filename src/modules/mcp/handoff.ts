import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Set on a bridge that an older bridge (0.1.17, 0.1.18) started as its own child to take its
 * client over: what it carries over, as JSON. Bridges from 0.1.19 on load the newer code into
 * their own process instead (`TakeoverInput`).
 */
export const HANDOFF_VARIABLE = "CONCOS_HANDOFF";

/** What a bridge carries over to the newer one, so its agents need not join again. */
export interface HandoffState {
    lastHandle: string | null;
    joinedAgentIds: string[];
    toldToRecord: string[];
    clientPid: number;
    /** The installed version handed to; the newer bridge never hands over to it again. */
    version: string;
    /** The version that handed over; absent from bridges before 0.1.19. */
    fromVersion?: string;
    /**
     * The MCP instructions the client holds, from its initialize: a client reads them once, so a
     * newer bridge tells it of changed ones. Absent from bridges before 0.1.19, which did not know.
     */
    clientInstructions?: string;
}

/** The state an older bridge carried over to this one, read once; null for a bridge its client started. */
export function readHandoff(): HandoffState | null {
    const text = process.env[HANDOFF_VARIABLE];
    if(text == null) {
        return null;
    }
    // the handle in it goes no further than this process
    delete process.env[HANDOFF_VARIABLE];
    try {
        return JSON.parse(text) as HandoffState;
    }
    catch {
        return null;
    }
}

/**
 * The version of the concos installed where this process's cli.js lives: `npm install -g` replaces
 * the files under a running bridge, whose code stays as it was. Re-reads package.json only when it
 * changes, since every request asks.
 */
export class InstalledVersion {
    private readonly file: string;
    private changedMs = -1;
    private version: string | null = null;

    constructor(cliPath: string) {
        this.file = path.resolve(path.dirname(cliPath), "..", "package.json");
    }

    read(): string | null {
        try {
            const changedMs = fs.statSync(this.file).mtimeMs;
            if(changedMs != this.changedMs) {
                this.changedMs = changedMs;
                const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as { version?: unknown };
                this.version = typeof parsed.version == "string" ? parsed.version : null;
            }
            return this.version;
        }
        catch {
            return null;
        }
    }
}

/**
 * What a bridge hands the newer concos code it loads into its own process (protocol 1, from
 * 0.1.19). Starting a second process for each update had doubled the bridges: 22 sessions went
 * from 22 to 44 node processes, about 1 GB more, when 0.1.18 was installed (2026-10-29).
 */
export interface TakeoverInput {
    protocol: 1;
    state: HandoffState;
    /** The client's initialize request: the newer bridge starts out initialized with it. */
    initializeParams: Record<string, unknown>;
    /**
     * Called once by the newer bridge when it is ready and right before it reads stdin: the older
     * bridge lets go of stdin, its timers and its process listeners, and gives over the client lines
     * it held meanwhile and the start of a line not yet ended. Before this call the older bridge
     * still holds everything, so a newer bridge that fails leaves it as it was.
     */
    release(): { held: string[]; partial: string };
}

/** The entry of a concos install that a bridge of an older version loads to hand its client over. */
export type TakeOver = (input: TakeoverInput) => Promise<void>;

/**
 * Loads `takeover.js` of the concos installed beside `cliPath`. The version in the URL keeps it
 * apart from any code this process loaded before, including an earlier takeover's.
 */
export async function loadTakeover(cliPath: string, version: string): Promise<TakeOver> {
    const file = path.resolve(path.dirname(cliPath), "takeover.js");
    const entry = await import(`${pathToFileURL(file).href}?v=${encodeURIComponent(version)}`) as { takeOver?: unknown };
    if(typeof entry.takeOver != "function") {
        throw new Error(`concos ${version} has no takeover entry`);
    }
    return entry.takeOver as TakeOver;
}

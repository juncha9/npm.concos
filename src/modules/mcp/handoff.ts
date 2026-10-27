import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { HANDOFF_TIMEOUT_MS, NODE_FLAGS } from "../../_defs";
import type { Logger } from "../../_libs/logger";
import type { StdioServer } from "./stdio-server";

/** A newer bridge relaying the client: its stdin and stdout are piped, its stderr shared. */
export type Successor = ChildProcessByStdio<Writable, Readable, null>;

/** Set on a bridge that another bridge started to take its client over: what it carries over, as JSON. */
export const HANDOFF_VARIABLE = "CONCOS_HANDOFF";

/** The id of the initialize request that introduces the newer bridge; its answer never reaches the client. */
const HANDOFF_REQUEST_ID = "concos-handoff";

/** What a bridge carries over to the newer bridge it starts, so its agents need not join again. */
export interface HandoffState {
    lastHandle: string | null;
    joinedAgentIds: string[];
    toldToRecord: string[];
    clientPid: number;
    /** The installed version handed to; the successor never hands over to it again. */
    version: string;
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
 * Hands the client to a newer bridge (2026-10-28 user request: agents kept running an older concos,
 * and restarting their sessions was hard, the client programs owning them).
 *
 * Flow:
 *  1) Hold the client's lines, start the installed cli.js as a bridge with this one's state
 *  2) Introduce it with the client's own initialize; its answer stays here
 *  3) Send it initialized and the held lines, then relay both ways; tell the client its tools may
 *     have changed
 *  4) A successor that does not answer in time, or stops, gives the client back: the held lines
 *     are answered here, and this bridge goes on as before
 */
export function startSuccessor(options: {
    server: StdioServer;
    initializeParams: Record<string, unknown>;
    state: HandoffState;
    logger: Logger;
    /** The successor answers the client now; this bridge stops its own work. */
    onHandedOver: (successor: Successor) => void;
    /** The successor failed or stopped; this bridge answers the client again. */
    onReturned: (reason: string) => void;
}): void {
    const { server, logger } = options;
    // (1) Hold and start
    const held: string[] = [];
    server.handOver((line) => held.push(line));
    const successor = spawn(process.execPath, [...NODE_FLAGS, process.argv[1], "mcp"], {
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
        env: { ...process.env, [HANDOFF_VARIABLE]: JSON.stringify(options.state) },
    });
    const toSuccessor = (line: string): void => {
        successor.stdin.write(`${line}\n`);
    };
    // a successor that died mid-write is handled by its exit
    successor.stdin.on("error", () => undefined);

    let handedOver = false;
    let returned = false;
    const giveBack = (reason: string): void => {
        if(returned == true) {
            return;
        }
        returned = true;
        handedOver = false;
        clearTimeout(timer);
        server.takeBack();
        logger.warn(`kept the client: ${reason}`);
        for(const line of held.splice(0)) {
            server.receive(line);
        }
        options.onReturned(reason);
    };
    const timer = setTimeout(() => {
        successor.kill();
        giveBack("the newer bridge did not answer");
    }, HANDOFF_TIMEOUT_MS);

    // (3) Relay
    const complete = (): void => {
        handedOver = true;
        clearTimeout(timer);
        toSuccessor(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
        server.handOver(toSuccessor);
        for(const line of held.splice(0)) {
            toSuccessor(line);
        }
        // the newer bridge may describe its tools differently
        server.writeLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
        logger.info(`handed the client to concos ${options.state.version} (pid ${successor.pid})`);
        options.onHandedOver(successor);
    };

    let buffer = "";
    successor.stdout.setEncoding("utf8");
    successor.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        for(let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
            const line = buffer.slice(0, end).replace(/\r$/, "");
            buffer = buffer.slice(end + 1);
            if(handedOver == true) {
                server.writeLine(line);
                continue;
            }
            if(returned == true) {
                continue;
            }
            // (2) before the hand-over only the answer to the introduction comes back
            let answer: { id?: unknown; result?: unknown } = {};
            try {
                answer = JSON.parse(line) as { id?: unknown; result?: unknown };
            }
            catch {
                continue;
            }
            if(answer.id != HANDOFF_REQUEST_ID) {
                continue;
            }
            if(answer.result == null) {
                successor.kill();
                giveBack("the newer bridge refused the introduction");
                continue;
            }
            complete();
        }
    });
    successor.on("error", (error) => giveBack(`the newer bridge did not start: ${error.message}`));
    successor.on("exit", (code) => giveBack(`the newer bridge stopped (exit ${code})`));

    // (2) Introduce
    toSuccessor(JSON.stringify({ jsonrpc: "2.0", id: HANDOFF_REQUEST_ID, method: "initialize", params: options.initializeParams }));
}

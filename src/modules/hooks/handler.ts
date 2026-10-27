import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { NODE_FLAGS, SHARED_ROOM } from "../../_defs";
import { $logger } from "../../_libs/logger";
import { resolveDataDirectory } from "../../_libs/paths";
import { openDatabase } from "../store/database";
import { RoomError } from "../store/room-error";
import { RoomStore } from "../store/room-store";
import { clientPidFromEnvironment, getHostAdapter } from "./adapters";
import { describeNotices } from "./notices";
import { HOOK_EVENTS } from "./types";
import type { HookEvent, HookEventKind, HookResult, HostAdapter } from "./types";
import { WAKE_TIMINGS, watchForWake } from "./watch";
import type { WakeLiveness } from "./watch";

export function processHook(store: RoomStore, event: HookEvent, room = SHARED_ROOM): HookResult | undefined {
    const outcome = store.applyHookEvent(event, room);
    if(outcome == null) return;
    if(outcome.continueFor != null) {
        return {
            continueReason: `${describeNotices(outcome.continueFor, outcome.unread)} Read them with read_messages, answer questions with kind reply if they need one, then finish.`,
        };
    }
    const notices = outcome.notices ?? [];
    const unread = outcome.unread ?? notices.length;
    const lines: string[] = [];
    if(outcome.joined != null) {
        const { joined } = outcome;
        const overview = store.getRoomOverview(room, 0);
        const others = overview.agents.filter((agent) => !agent.left && !agent.ended && agent.agent_id != joined.agent_id).length;
        lines.push(`concos shared waiting room; agent_id=${joined.agent_id}; handle=${joined.handle}`);
        lines.push(`Call join with resume_handle=${joined.handle}, your absolute working_directory and this session's name as display_name to keep this participant.`);
        lines.push(`Hooks record your working/waiting status and edited files; keep reporting summary and next step with check_in. ${others} other participant(s).`);
    }
    if(unread > 0) {
        lines.push(`${describeNotices(notices, unread)} Read them with read_messages.`);
    }
    // a turn starts where a blocker may have cleared: agents left resolved ones on the card (2026-10-28 report)
    if(outcome.blocker != null) {
        lines.push(`concos: your card still reports blocker "${outcome.blocker}". If it is resolved, clear it with check_in blocker "".`);
    }
    if(lines.length > 0) {
        return { context: lines.join("\n") };
    }
}

async function readPayload(): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let buffer = "";
        let bytes = 0;
        const finish = (error?: Error) => {
            clearTimeout(timer);
            process.stdin.off("data", onData);
            process.stdin.off("end", onEnd);
            process.stdin.off("error", finish);
            process.stdin.pause();
            if(error != null) reject(error);
            else {
                try { resolve(JSON.parse(buffer)); }
                catch { reject(new RoomError("invalid hook JSON")); }
            }
        };
        const onData = (chunk: string) => {
            bytes += Buffer.byteLength(chunk);
            if(bytes > 1024 * 1024) finish(new RoomError("hook input exceeds 1 MiB"));
            else buffer += chunk;
        };
        const onEnd = () => finish();
        const timer = setTimeout(() => finish(new RoomError("hook input timed out")), 2000);
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", onData);
        process.stdin.once("end", onEnd);
        process.stdin.once("error", finish);
    });
}

/** Set on a watch that goes on in a node of its own: the hook event it watches, as JSON. */
const WATCH_EVENT_VARIABLE = "CONCOS_WATCH_EVENT";

/**
 * Starts the watch for `event` in a node of its own and returns at once. Waking from outside
 * needs nothing back from the hook, so the shell Codex runs hooks in (PowerShell, about 64 MB)
 * does not stay for the watch's day. The watch still ends when the session does, through its end hook.
 */
function startDetachedWatch(adapter: HostAdapter, event: HookEvent): void {
    const watch = spawn(process.execPath, [...NODE_FLAGS, process.argv[1], "hook", "watch", "--host", adapter.id], {
        detached: true, stdio: "ignore", windowsHide: true,
        // database logging stays off the watch's stderr unless the user set a level
        env: { ...process.env, CONCOS_LOG_LEVEL: process.env.CONCOS_LOG_LEVEL ?? "none", [WATCH_EVENT_VARIABLE]: JSON.stringify(event) },
    });
    // a watch that cannot start is left for the next turn end; the hook still ends quietly
    watch.on("error", (error) => $logger.error(error, "idle-wake watch did not start"));
    watch.unref();
}

/** Whether the user's settings have this host's idle wake on; read when a session starts, never on later hooks. */
async function wakeRegistered(adapter: HostAdapter): Promise<boolean> {
    try {
        const { inspectWake } = await import("../cli/setup");
        return inspectWake({ host: adapter.id });
    }
    catch {
        return false;
    }
}

/**
 * The client process this hook runs under, when it is cheap to know: the id the client names in
 * its environment, or the parent of a hook started in exec form, with no shell between them.
 * Codex runs hooks through a shell and names no id, so its sessions get none.
 */
export function hookClientPid(adapter: HostAdapter): number | undefined {
    const named = clientPidFromEnvironment(adapter);
    if(named != null) {
        return named;
    }
    if(process.execArgv.includes(NODE_FLAGS[0])) {
        return process.ppid;
    }
    return undefined;
}

/**
 * The idle-wake hook. A host that wakes a session from outside (Codex) gets the line from
 * `deliverWake`. Otherwise exit code 2 wakes the Claude Code session with stderr as its message,
 * so stderr carries that one line and nothing else. Every other ending is a quiet exit 0.
 */
async function runWatch(adapter: HostAdapter, event: HookEvent | null): Promise<void> {
    // child loggers read the level when created, so database logging stays off stderr from here
    process.env.CONCOS_LOG_LEVEL ??= "none";
    if(event != null && adapter.wake != null && adapter.deliverWake != null && process.env[WATCH_EVENT_VARIABLE] == null) {
        startDetachedWatch(adapter, event);
        process.stdout.write("{}\n");
        return;
    }
    let reason: string | null = null;
    if(event != null && adapter.wake != null) {
        const database = await openDatabase(resolveDataDirectory(), { busyTimeoutMs: 100 });
        try {
            let liveness: WakeLiveness = { keepOnline: true };
            if(adapter.deliverWake == null) {
                // Claude Code starts a watch registered in exec form (node with concos's flags) itself, so
                // its parent is the client. Through the `concos` command the parent is a shell, which
                // outlives a killed client (checked on 2.1.310): such a watch only wakes.
                if(process.execArgv.includes(NODE_FLAGS[0])) {
                    liveness = { keepOnline: true, parentPid: process.ppid };
                }
                else {
                    liveness = { keepOnline: false };
                }
            }
            reason = await watchForWake(new RoomStore(database), event, WAKE_TIMINGS, liveness);
        }
        finally { database.close(); }
        if(reason != null && adapter.deliverWake != null) {
            await adapter.deliverWake(event.sessionId, reason);
            process.stdout.write("{}\n");
            return;
        }
    }
    if(reason == null) {
        process.stdout.write("{}\n");
        return;
    }
    process.exitCode = 2;
    process.stderr.write(`${reason}\n`);
}

/** Every failure emits neutral JSON and exits successfully, including argument and input errors. */
export async function runHook(args: string[]): Promise<void> {
    let adapter: HostAdapter | undefined;
    let kind: HookEventKind | undefined;
    let output: Record<string, unknown> = {};
    try {
        const { values, positionals } = parseArgs({
            args, allowPositionals: true,
            options: { host: { type: "string" }, room: { type: "string" }, "room-base64": { type: "string" } },
        });
        adapter = getHostAdapter(values.host);
        if(positionals.length != 1 || !(HOOK_EVENTS as readonly string[]).includes(positionals[0])) throw new RoomError("invalid hook event");
        kind = positionals[0] as HookEventKind;
        // a watch started by `runWatch` has no stdin; its event comes along in the environment
        const watchEvent = process.env[WATCH_EVENT_VARIABLE];
        // Accept old registered commands, but never use their former room selectors.
        const event = kind == "watch" && watchEvent != null ? JSON.parse(watchEvent) as HookEvent : adapter.normalize(kind, await readPayload());
        if(kind == "watch") {
            await runWatch(adapter, event);
            return;
        }
        if(event != null) {
            const hookEvent: HookEvent = { ...event, client: adapter.label };
            const clientPid = hookClientPid(adapter);
            if(clientPid != null) {
                hookEvent.clientPid = clientPid;
            }
            const database = await openDatabase(resolveDataDirectory(), { busyTimeoutMs: 100 });
            try {
                const result = processHook(new RoomStore(database), hookEvent);
                if(result?.continueReason != null && adapter.continueTurn != null) {
                    output = adapter.continueTurn(result.continueReason);
                }
                else {
                    output = adapter.output(kind, result?.context);
                }
            }
            finally { database.close(); }
            // A session given no work never calls concos and went offline at once (2026-10-28
            // report). A host woken from outside watches from its start, as after each turn,
            // when its idle wake is on: the card stays online and a message can start its first turn.
            if(kind == "session-start" && adapter.wake != null && adapter.deliverWake != null && await wakeRegistered(adapter) == true) {
                startDetachedWatch(adapter, event);
            }
        }
        else output = adapter.output(kind);
    }
    catch(ex) {
        $logger.error(ex, "hook skipped; host may continue");
        output = adapter != null && kind != null ? adapter.output(kind) : {};
    }
    process.stdout.write(`${JSON.stringify(output)}\n`);
}

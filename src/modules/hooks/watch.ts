import { HEARTBEAT_INTERVAL_MS, WAKE_IDLE_MS, WAKE_POLL_MS, WAKE_WATCH_MS } from "../../_defs";
import type { RoomStore, WakeCheck } from "../store/room-store";
import { describeWake } from "./notices";
import type { HookEvent } from "./types";

export interface WakeTimings {
    /** Quiet time after the turn ends before a wake is allowed. */
    idleMs: number;
    pollMs: number;
    /** The watch's whole life. */
    watchMs: number;
    /** How often the watch keeps the waiting session's card online; HEARTBEAT_INTERVAL_MS when absent. */
    keepAliveMs?: number;
}

export const WAKE_TIMINGS: WakeTimings = { idleMs: WAKE_IDLE_MS, pollMs: WAKE_POLL_MS, watchMs: WAKE_WATCH_MS, keepAliveMs: HEARTBEAT_INTERVAL_MS };

/** Whether process `pid` still runs; one that exists but may not be signalled counts as running. */
export function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch(ex) {
        return (ex as NodeJS.ErrnoException).code == "EPERM";
    }
}

/**
 * What vouches for the watched session. `keepOnline`: the watch keeps the card online while it
 * runs, since the MCP server that heartbeats it may have restarted without the model joining it
 * again. `parentPid`: the client that ran the hook; the watch ends once it is gone, since a client
 * killed without its session-end hook would otherwise leave the watch for the whole day.
 */
export interface WakeLiveness {
    keepOnline: boolean;
    parentPid?: number;
}

/**
 * Idle wake: watches a session that just ended its turn. Resolves with the wake
 * message once a message for it is waiting after the quiet time, or with null when a newer
 * watch or a prompt replaces this one, the session ends, or the watch's time runs out.
 */
export async function watchForWake(
    store: RoomStore,
    event: HookEvent,
    timings: WakeTimings = WAKE_TIMINGS,
    liveness: WakeLiveness = { keepOnline: true },
): Promise<string | null> {
    const watch = store.startWakeWatch(event);
    if(watch == null) {
        return null;
    }
    const startedMs = Date.now();
    const keepAliveMs = timings.keepAliveMs ?? HEARTBEAT_INTERVAL_MS;
    let keptAliveMs = startedMs;
    const parentPid = liveness.parentPid;
    // a parent already gone was a launcher in between, not the client: the watch still wakes, but
    // without the client to vouch for the session it does not keep the card online
    const watchParent = parentPid != null && isRunning(parentPid);
    const keepOnline = liveness.keepOnline == true && (parentPid == null || watchParent);
    for(;;) {
        await new Promise((resolve) => setTimeout(resolve, timings.pollMs));
        const nowMs = Date.now();
        const elapsedMs = nowMs - startedMs;
        if(elapsedMs >= timings.watchMs) {
            return null;
        }
        if(watchParent == true && parentPid != null && isRunning(parentPid) == false) {
            return null;
        }
        let check: WakeCheck;
        try {
            if(keepOnline == true && nowMs - keptAliveMs >= keepAliveMs) {
                store.keepAlive(watch.agentId);
                keptAliveMs = nowMs;
            }
            check = store.checkWakeWatch(watch, elapsedMs >= timings.idleMs);
        }
        catch {
            // another writer held the database past the hook's short busy wait: look again next time
            continue;
        }
        if(check.state == "stop") {
            return null;
        }
        if(check.state == "wake") {
            return describeWake(check.notices, check.unread);
        }
    }
}

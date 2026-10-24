import { WAKE_IDLE_MS, WAKE_POLL_MS, WAKE_WATCH_MS } from "../../_defs";
import type { RoomStore, WakeCheck } from "../store/room-store";
import { describeNotices } from "./notices";
import type { HookEvent } from "./types";

export interface WakeTimings {
    /** Quiet time after the turn ends before a wake is allowed. */
    idleMs: number;
    pollMs: number;
    /** The watch's whole life. */
    watchMs: number;
}

export const WAKE_TIMINGS: WakeTimings = { idleMs: WAKE_IDLE_MS, pollMs: WAKE_POLL_MS, watchMs: WAKE_WATCH_MS };

/**
 * Claude Code idle wake: watches a session that just ended its turn. Resolves with the wake
 * message once a message for it is waiting after the quiet time, or with null when a newer
 * watch or a prompt replaces this one, the session ends, or the watch's time runs out.
 */
export async function watchForWake(store: RoomStore, event: HookEvent, timings: WakeTimings = WAKE_TIMINGS): Promise<string | null> {
    const watch = store.startWakeWatch(event);
    if(watch == null) {
        return null;
    }
    const startedMs = Date.now();
    for(;;) {
        await new Promise((resolve) => setTimeout(resolve, timings.pollMs));
        const elapsedMs = Date.now() - startedMs;
        if(elapsedMs >= timings.watchMs) {
            return null;
        }
        let check: WakeCheck;
        try {
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
            return `${describeNotices(check.notices)} Read them with read_messages, and answer questions with kind reply if they need one.`;
        }
    }
}

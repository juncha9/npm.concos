import { parseArgs } from "node:util";
import { SHARED_ROOM } from "../../_defs";
import { $logger } from "../../_libs/logger";
import { resolveDataDirectory } from "../../_libs/paths";
import { openDatabase } from "../store/database";
import { RoomError } from "../store/room-error";
import { RoomStore } from "../store/room-store";
import { getHostAdapter } from "./adapters";
import { describeNotices } from "./notices";
import { HOOK_EVENTS } from "./types";
import type { HookEvent, HookEventKind, HookResult, HostAdapter } from "./types";
import { watchForWake } from "./watch";

export function processHook(store: RoomStore, event: HookEvent, room = SHARED_ROOM): HookResult | undefined {
    const outcome = store.applyHookEvent(event, room);
    if(outcome == null) return;
    if(outcome.continueFor != null) {
        return {
            continueReason: `${describeNotices(outcome.continueFor)} Read them with read_messages, answer questions with kind reply if they need one, then finish.`,
        };
    }
    const notices = outcome.notices ?? [];
    if(outcome.joined != null) {
        const { joined } = outcome;
        const overview = store.getRoomOverview(room, 0);
        const others = overview.agents.filter((agent) => !agent.left && !agent.ended && agent.agent_id != joined.agent_id).length;
        let context = `concos shared waiting room; agent_id=${joined.agent_id}; handle=${joined.handle}\n`
            + `Call join with resume_handle=${joined.handle}, your absolute working_directory and this session's name as display_name to keep this participant.\n`
            + `Hooks record your working/waiting status and edited files; keep reporting summary and next step with check_in. ${others} other participant(s).`;
        if(notices.length > 0) {
            context += `\n${describeNotices(notices)} Read them with read_messages.`;
        }
        return { context: context };
    }
    if(notices.length > 0) {
        return { context: `${describeNotices(notices)} Read them with read_messages.` };
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

/**
 * The idle-wake hook. Exit code 2 wakes the Claude Code session with stderr as its message, so
 * stderr carries that one line and nothing else; every other ending is a quiet exit 0.
 */
async function runWatch(adapter: HostAdapter, event: HookEvent | null): Promise<void> {
    // child loggers read the level when created, so database logging stays off stderr from here
    process.env.CONCOS_LOG_LEVEL ??= "none";
    let reason: string | null = null;
    if(event != null && adapter.wake != null) {
        const database = await openDatabase(resolveDataDirectory(), { busyTimeoutMs: 100 });
        try {
            reason = await watchForWake(new RoomStore(database), event);
        }
        finally { database.close(); }
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
        // Accept old registered commands, but never use their former room selectors.
        const event = adapter.normalize(kind, await readPayload());
        if(kind == "watch") {
            await runWatch(adapter, event);
            return;
        }
        if(event != null) {
            const database = await openDatabase(resolveDataDirectory(), { busyTimeoutMs: 100 });
            try {
                const result = processHook(new RoomStore(database), { ...event, client: adapter.label });
                if(result?.continueReason != null && adapter.continueTurn != null) {
                    output = adapter.continueTurn(result.continueReason);
                }
                else {
                    output = adapter.output(kind, result?.context);
                }
            }
            finally { database.close(); }
        }
        else output = adapter.output(kind);
    }
    catch(ex) {
        $logger.error(ex, "hook skipped; host may continue");
        output = adapter != null && kind != null ? adapter.output(kind) : {};
    }
    process.stdout.write(`${JSON.stringify(output)}\n`);
}

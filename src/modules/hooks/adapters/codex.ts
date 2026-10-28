import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RoomError } from "../../store/room-error";
import type { HostAdapter } from "../types";
import { contextOutput, continueOutput, failed, normalizeEvent, object, patchFiles, withContinue } from "./shared";
import { newestContextSize, tokenCount } from "./transcript";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Days of Codex's dated session folders searched for a thread's record, newest first. */
const ROLLOUT_SEARCH_DAYS = 31;

/**
 * Codex's record of a thread: `sessions/<year>/<month>/<day>/rollout-<time>-<thread id>.jsonl`
 * under CODEX_HOME, in the folder of the day it started. For a hook not told the record's path.
 */
function findRollout(sessionId: string): string | null {
    if(THREAD_ID.test(sessionId) == false) {
        return null;
    }
    const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
    const newestFirst = (folder: string) => {
        try {
            return fs.readdirSync(folder).filter((name) => /^\d+$/.test(name)).sort().reverse().map((name) => path.join(folder, name));
        }
        catch {
            return [];
        }
    };
    const suffix = `-${sessionId}.jsonl`;
    let days = 0;
    for(const year of newestFirst(root)) {
        for(const month of newestFirst(year)) {
            for(const day of newestFirst(month)) {
                if(days >= ROLLOUT_SEARCH_DAYS) {
                    return null;
                }
                days += 1;
                try {
                    const name = fs.readdirSync(day).find((file) => file.endsWith(suffix));
                    if(name != null) {
                        return path.join(day, name);
                    }
                }
                catch {
                    // an unreadable day folder is skipped
                }
            }
        }
    }
    return null;
}
/**
 * The longest wake line cmd.exe takes on Windows once its line breaks are marks: a command line
 * ends at 8,191 characters, and codex.cmd runs node with the paths to node and Codex in front.
 */
const CMD_LINE_ROOM = 7500;
/** On Windows a line break would end the command, so it shows as a mark and a carried message keeps its lines. */
const windowsLine = (message: string) => message.replace(/\r?\n/g, " ⏎ ");

/**
 * Codex idle wake. `codex queue` adds the line to the session's queue through Codex's shared
 * app-server daemon; an idle session that Codex has open starts a turn with it. For a session no
 * Codex process has open, the line is only stored.
 */
async function queueMessage(sessionId: string, message: string): Promise<void> {
    // the session id goes into a command line
    if(THREAD_ID.test(sessionId) == false) {
        throw new RoomError("invalid Codex session id");
    }
    let file = "codex";
    let args = ["queue", "--thread", sessionId, "--message", message];
    let options: ExecFileOptions = { timeout: 60_000, windowsHide: true };
    if(process.platform == "win32") {
        // npm installs codex as codex.cmd, which only cmd.exe runs. Inside the quotes cmd still
        // reads " and % and ends the line at a control character, so the line goes without them;
        // trailing backslashes are doubled so they do not escape the closing quote
        const text = windowsLine(message).replace(/[\x00-\x1f\x7f]/g, " ").replaceAll("\"", "'").replaceAll("%", "").replace(/(\\+)$/, "$1$1");
        file = process.env.ComSpec ?? "cmd.exe";
        args = ["/d", "/v:off", "/s", "/c", `"codex queue --thread ${sessionId} --message "${text}""`];
        options = { ...options, windowsVerbatimArguments: true };
    }
    await new Promise<void>((resolve, reject) => {
        execFile(file, args, options, (error) => {
            if(error != null) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

export const codex: HostAdapter = {
    id: "codex",
    label: "Codex",
    registrations: [
        { event: "SessionStart", kind: "session-start", timeout: 10 },
        { event: "UserPromptSubmit", kind: "prompt", timeout: 10 },
        // nothing to hand back, so the edit does not wait for a shell to start
        { event: "PostToolUse", kind: "file-edited", matcher: "^apply_patch$", timeout: 10, async: true },
        { event: "Stop", kind: "turn-end", timeout: 10 },
        // Codex allows at most 3 seconds here
        { event: "SessionEnd", kind: "session-end", timeout: 3 },
    ],
    // the hook starts the watch in a node of its own and ends, so this timeout never binds the watch;
    // it stays as registered, since Codex may ask to trust a changed hook again
    wake: { event: "Stop", kind: "watch", timeout: 3660, async: true },
    deliverWake: queueMessage,
    // what cmd.exe would alter or cut goes by number, so a carried text is never received changed
    wakeCarries: (body, whole) => process.platform != "win32"
        || (/["%\x00-\x1f\x7f]/.test(body.replace(/\r?\n/g, "")) == false && windowsLine(whole).length <= CMD_LINE_ROOM),
    normalize(kind, raw) {
        const payload = object(raw);
        let files: string[] = [];
        if(kind == "file-edited") {
            if(payload.tool_name != "apply_patch" || failed(payload.tool_response)) return null;
            // Codex PostToolUse also fires on failures; only successful patches claim files.
            const response = typeof payload.tool_response == "string" ? payload.tool_response : JSON.stringify(payload.tool_response);
            if(!response?.includes("Success. Updated the following files:")) return null;
            files = patchFiles(object(payload.tool_input).command);
            if(files.length == 0) return null;
        }
        return withContinue(normalizeEvent("codex", kind, raw, files), kind, raw);
    },
    output: (kind, context) => contextOutput(kind == "session-start" ? "SessionStart" : "UserPromptSubmit", context),
    continueTurn: continueOutput,
    // Codex records each call's usage as a token_count event, with the model's context window
    contextSize(event) {
        const file = event.transcriptPath ?? findRollout(event.sessionId);
        if(file == null) {
            return null;
        }
        return newestContextSize(file, (record) => {
            const payload = object(record.payload);
            if(record.type != "event_msg" || payload.type != "token_count") {
                return null;
            }
            const info = object(payload.info);
            const tokens = tokenCount(object(info.last_token_usage).input_tokens);
            if(tokens == null || tokens == 0) {
                return null;
            }
            return { tokens: tokens, window: tokenCount(info.model_context_window) };
        });
    },
    setup: {
        userHooks: ".codex/hooks.json", userMcp: ".codex/config.toml", hookFormat: "grouped", mcpFormat: "toml",
    },
};

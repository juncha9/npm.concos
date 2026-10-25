import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { WAKE_WATCH_MS } from "../../../_defs";
import { RoomError } from "../../store/room-error";
import type { HostAdapter } from "../types";
import { contextOutput, continueOutput, failed, normalizeEvent, object, patchFiles, withContinue } from "./shared";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
        const text = message.replace(/[\x00-\x1f\x7f]/g, " ").replaceAll("\"", "'").replaceAll("%", "").replace(/(\\+)$/, "$1$1");
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
    // the watch stops itself after WAKE_WATCH_MS; the timeout is the host's backstop a minute later
    wake: { event: "Stop", kind: "watch", timeout: WAKE_WATCH_MS / 1000 + 60, async: true },
    deliverWake: queueMessage,
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
    setup: {
        userHooks: ".codex/hooks.json", userMcp: ".codex/config.toml", hookFormat: "grouped", mcpFormat: "toml",
    },
};

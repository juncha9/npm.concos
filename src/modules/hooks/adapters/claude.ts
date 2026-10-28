import { WAKE_WATCH_MS } from "../../../_defs";
import type { HostAdapter } from "../types";
import { contextOutput, continueOutput, failed, fileArgument, normalizeEvent, object, withContinue } from "./shared";
import { newestContextSize, tokenCount } from "./transcript";

export const claude: HostAdapter = {
    id: "claude",
    label: "Claude Code",
    // claude.exe, the parent of the MCP servers it starts (checked 2026-10-28 on 2.1.x)
    clientPidVariable: "CLAUDE_PID",
    registrations: [
        { event: "SessionStart", kind: "session-start", timeout: 10 },
        { event: "UserPromptSubmit", kind: "prompt", timeout: 10 },
        // nothing to hand back, so the edit does not wait for a shell to start
        { event: "PostToolUse", kind: "file-edited", matcher: "Edit|Write|MultiEdit|NotebookEdit", timeout: 10, async: true },
        { event: "Stop", kind: "turn-end", timeout: 10 },
        { event: "SessionEnd", kind: "session-end", timeout: 10 },
    ],
    // the watch stops itself after WAKE_WATCH_MS; the timeout is the host's backstop a minute later
    wake: { event: "Stop", kind: "watch", timeout: WAKE_WATCH_MS / 1000 + 60, asyncRewake: true },
    normalize(kind, raw) {
        const payload = object(raw);
        let files: string[] = [];
        if(kind == "file-edited") {
            if(!["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(String(payload.tool_name)) || failed(payload.tool_response)) return null;
            files = fileArgument(payload.tool_input, payload.tool_name == "NotebookEdit" ? "notebook_path" : "file_path");
            if(files.length == 0) return null;
        }
        return withContinue(normalizeEvent("claude", kind, raw, files), kind, raw);
    },
    output: (kind, context) => contextOutput(kind == "session-start" ? "SessionStart" : "UserPromptSubmit", context),
    continueTurn: continueOutput,
    // the input of the main conversation's last call; a subagent's calls are a conversation of their own
    contextSize(event) {
        if(event.transcriptPath == null) {
            return null;
        }
        return newestContextSize(event.transcriptPath, (record) => {
            if(record.type != "assistant" || record.isSidechain == true) {
                return null;
            }
            const usage = object(object(record.message).usage);
            const input = tokenCount(usage.input_tokens);
            if(input == null) {
                return null;
            }
            const tokens = input + (tokenCount(usage.cache_read_input_tokens) ?? 0) + (tokenCount(usage.cache_creation_input_tokens) ?? 0);
            return tokens > 0 ? { tokens: tokens, window: null } : null;
        });
    },
    setup: {
        userHooks: ".claude/settings.json", userMcp: ".claude.json", hookFormat: "grouped",
    },
};

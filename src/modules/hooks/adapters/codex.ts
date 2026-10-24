import type { HostAdapter } from "../types";
import { contextOutput, continueOutput, failed, normalizeEvent, object, patchFiles, withContinue } from "./shared";

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

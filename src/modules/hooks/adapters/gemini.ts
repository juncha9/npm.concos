import type { HostAdapter } from "../types";
import { contextOutput, failed, fileArgument, normalizeEvent, object } from "./shared";

export const gemini: HostAdapter = {
    id: "gemini",
    label: "Gemini CLI",
    registrations: [
        { event: "SessionStart", kind: "session-start" },
        { event: "BeforeAgent", kind: "prompt" },
        { event: "AfterTool", kind: "file-edited", matcher: "^(write_file|replace)$" },
        { event: "AfterAgent", kind: "turn-end" },
        { event: "SessionEnd", kind: "session-end" },
    ],
    normalize(kind, raw) {
        const payload = object(raw);
        let files: string[] = [];
        if(kind == "file-edited") {
            if(!["write_file", "replace"].includes(String(payload.tool_name)) || failed(payload.tool_response)) return null;
            files = fileArgument(payload.tool_input, "file_path");
            if(files.length == 0) return null;
        }
        return normalizeEvent("gemini", kind, raw, files);
    },
    output: (kind, context) => contextOutput(kind == "session-start" ? "SessionStart" : "BeforeAgent", context),
    setup: {
        userHooks: ".gemini/settings.json", userMcp: ".gemini/settings.json", hookFormat: "grouped",
    },
};

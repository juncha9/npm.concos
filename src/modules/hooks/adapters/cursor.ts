import type { HostAdapter } from "../types";
import { fileArgument, normalizeEvent } from "./shared";

export const cursor: HostAdapter = {
    id: "cursor",
    label: "Cursor",
    registrations: [
        { event: "sessionStart", kind: "session-start" },
        { event: "beforeSubmitPrompt", kind: "prompt" },
        { event: "afterFileEdit", kind: "file-edited" },
        { event: "stop", kind: "turn-end" },
        { event: "sessionEnd", kind: "session-end" },
    ],
    normalize(kind, raw) {
        const files = kind == "file-edited" ? fileArgument(raw, "file_path") : [];
        if(kind == "file-edited" && files.length == 0) return null;
        return normalizeEvent("cursor", kind, raw, files);
    },
    output: (kind, context) => kind == "session-start" && context ? { additional_context: context }
        : kind == "prompt" ? { continue: true } : {},
    setup: {
        userHooks: ".cursor/hooks.json", userMcp: ".cursor/mcp.json", hookFormat: "cursor",
    },
};

import type { HostAdapter } from "../types";
import { failed, fileArgument, normalizeEvent, object, patchFiles } from "./shared";
import { RoomError } from "../../store/room-error";

export const copilot: HostAdapter = {
    id: "copilot",
    label: "Copilot CLI",
    registrations: [
        { event: "sessionStart", kind: "session-start" },
        { event: "userPromptSubmitted", kind: "prompt" },
        { event: "postToolUse", kind: "file-edited", matcher: "^(create|edit|str_replace_editor|apply_patch)$" },
        { event: "agentStop", kind: "turn-end" },
        { event: "sessionEnd", kind: "session-end" },
    ],
    normalize(kind, raw) {
        const payload = object(raw);
        let files: string[] = [];
        if(kind == "file-edited") {
            if(!["create", "edit", "str_replace_editor", "apply_patch"].includes(String(payload.toolName))) return null;
            if(failed(payload.toolResult) || object(payload.toolResult).resultType != "success") return null;
            let args = payload.toolArgs;
            if(typeof args == "string") {
                try { args = JSON.parse(args); }
                catch { throw new RoomError("invalid Copilot toolArgs JSON"); }
            }
            files = payload.toolName == "apply_patch" ? patchFiles(object(args).input ?? object(args).patch)
                : fileArgument(args, "path");
            if(files.length == 0) return null;
        }
        return normalizeEvent("copilot", kind, raw, files);
    },
    output: (kind, context) => kind == "session-start" && context ? { additionalContext: context } : {},
    setup: {
        userHooks: ".copilot/hooks/concos.json", userMcp: ".copilot/mcp-config.json", hookFormat: "copilot",
    },
};

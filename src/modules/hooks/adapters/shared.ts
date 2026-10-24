import path from "node:path";
import { MAX_PATH_LENGTH } from "../../../_defs";
import { RoomError } from "../../store/room-error";
import type { HookEvent, HookEventKind } from "../types";

export function object(value: unknown): Record<string, unknown> {
    if(value == null || typeof value != "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string, max: number): string {
    if(typeof value != "string" || value.trim() == "" || value.length > max || /[\x00-\x1f]/.test(value)) {
        throw new RoomError(`invalid hook ${field}`);
    }
    return value;
}

export function normalizeEvent(host: string, kind: HookEventKind, raw: unknown, files: string[] = []): HookEvent | null {
    const payload = object(raw);
    // Parent-scoped session ids cannot safely identify a subagent as the parent.
    if(payload.agent_id || payload.agentId || payload.subagent_id) return null;
    const sessionId = requiredText(host == "copilot" ? payload.sessionId : host == "cursor"
        ? payload.conversation_id ?? payload.session_id : payload.session_id, "session id", 500);
    const roots = payload.workspace_roots;
    const directory = payload.cwd ?? (host == "cursor" && Array.isArray(roots) && roots.length == 1 ? roots[0] : undefined);
    const cwd = requiredText(directory, "cwd (a single explicit workspace is required)", MAX_PATH_LENGTH);
    if(!path.isAbsolute(cwd)) throw new RoomError("hook cwd must be absolute");
    return { host, kind, sessionId, cwd, files: files.map((file) => requiredText(file, "file path", MAX_PATH_LENGTH)) };
}

/**
 * A turn end may continue unless the host is already continuing because a stop hook asked:
 * `stop_hook_active` is the hosts' guard against a hook that keeps the turn going forever.
 */
export function withContinue(event: HookEvent | null, kind: HookEventKind, raw: unknown): HookEvent | null {
    if(event != null && kind == "turn-end") {
        event.canContinue = object(raw).stop_hook_active !== true;
    }
    return event;
}

/** Claude Code and Codex both continue the turn with this Stop output, using `reason` as the next instruction. */
export function continueOutput(reason: string): Record<string, unknown> {
    return { decision: "block", reason: reason };
}

export function fileArgument(input: unknown, key: string): string[] {
    const value = object(input)[key];
    return typeof value == "string" && value != "" ? [value] : [];
}

export function failed(response: unknown): boolean {
    const result = object(response);
    return Boolean(result.error) || result.isError === true || result.success === false
        || (typeof result.exit_code == "number" && result.exit_code != 0);
}

/** Patch headers only: added source lines cannot masquerade as another edited file. */
export function patchFiles(value: unknown): string[] {
    if(typeof value != "string" || !value.startsWith("*** Begin Patch")) return [];
    return [...value.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)]
        .map((match) => match[1].trim());
}

export function contextOutput(event: string, context?: string): Record<string, unknown> {
    return context ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : {};
}

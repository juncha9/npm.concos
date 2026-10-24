/** `watch`: Claude Code idle wake, a background Stop hook that may wake the waiting session. */
export const HOOK_EVENTS = ["session-start", "prompt", "file-edited", "turn-end", "session-end", "watch"] as const;
export type HookEventKind = typeof HOOK_EVENTS[number];

export interface HookEvent {
    kind: HookEventKind;
    host: string;
    sessionId: string;
    cwd: string;
    files: string[];
    /** Client name for a participant the hook creates, until the model joins and renames it. */
    client?: string;
    /** A turn end on a host that can continue the turn, outside a continuation it already asked for. */
    canContinue?: boolean;
}

export interface HookRegistration {
    event: string;
    kind: HookEventKind;
    matcher?: string;
    /** Seconds; the host's default applies when absent. */
    timeout?: number;
    /** Runs in the background: only for events whose output the host does not need. */
    async?: boolean;
    /** Claude Code: runs in the background, and exit code 2 wakes the session with stderr as the message. */
    asyncRewake?: boolean;
}

/** What one hook call hands back: lines for the model's context, or a reason to continue the turn. */
export interface HookResult {
    context?: string;
    continueReason?: string;
}

export interface HostAdapter {
    id: string;
    /** Client name on a participant card the hook created. */
    label: string;
    registrations: HookRegistration[];
    /** The idle wake hook, registered separately from `registrations`; only hosts that can wake a session have one. */
    wake?: HookRegistration;
    normalize(kind: HookEventKind, payload: unknown): HookEvent | null;
    output(kind: HookEventKind, context?: string): Record<string, unknown>;
    /** Output that continues the turn at its end; a host without one never continues a turn. */
    continueTurn?(reason: string): Record<string, unknown>;
    setup: {
        userHooks: string;
        userMcp: string;
        hookFormat: "grouped" | "cursor" | "copilot";
        mcpFormat?: "toml";
    };
}

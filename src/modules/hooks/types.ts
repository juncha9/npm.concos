/** `watch`: idle wake, a background Stop hook that may wake the waiting session (Claude Code, Codex). */
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
    /** The client process the hook ran under, when known; MCP servers under it keep the card online. */
    clientPid?: number;
    /** The client's record of the session, as the hook was told (`transcript_path`). */
    transcriptPath?: string;
    /** At a turn end: the conversation size the client recorded for its last call. */
    context?: ContextSize;
}

/** A session's conversation as its client recorded it for its last call: every call rereads it. */
export interface ContextSize {
    tokens: number;
    /** The model's context window, when the client records it (Codex). */
    window: number | null;
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
    /** Messages `continueReason` carries in full, for the agent `agentId`: delivered once it went out. */
    delivered?: { agentId: string; messageIds: number[] };
}

export interface HostAdapter {
    id: string;
    /** Client name on a participant card the hook created. */
    label: string;
    registrations: HookRegistration[];
    /** The idle wake hook, registered separately from `registrations`; only hosts that can wake a session have one. */
    wake?: HookRegistration;
    /**
     * Hands the wake line to the waiting session from outside it. Without one, the watch exits
     * with code 2 and the line on stderr, which Claude Code's asyncRewake turns into a turn.
     */
    deliverWake?(sessionId: string, message: string): Promise<void>;
    /**
     * Whether `deliverWake` hands `whole`, a wake text carrying the message `body`, over unchanged
     * and in full; a message it would alter or cut goes by number only. Absent: anything within HOOK_TEXT_LIMIT.
     */
    wakeCarries?(body: string, whole: string): boolean;
    /** The environment variable in which the client names its own process id to the hooks and MCP servers it starts. */
    clientPidVariable?: string;
    normalize(kind: HookEventKind, payload: unknown): HookEvent | null;
    output(kind: HookEventKind, context?: string): Record<string, unknown>;
    /** Output that continues the turn at its end; a host without one never continues a turn. */
    continueTurn?(reason: string): Record<string, unknown>;
    /** Reads the session's conversation size from the client's own record; null when it cannot tell. */
    contextSize?(event: HookEvent): ContextSize | null;
    setup: {
        userHooks: string;
        userMcp: string;
        hookFormat: "grouped" | "cursor" | "copilot";
        mcpFormat?: "toml";
    };
}

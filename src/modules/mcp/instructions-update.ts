/** Carries the client's instructions across server replacements and announces a change once. */
export class InstructionsUpdate {
    private readonly current: string;
    private readonly version: string;
    private readonly fromVersion: string | null;
    private lastSeen: string | null;

    constructor(options: { current: string; version: string; seen: string | null; fromVersion: string | null }) {
        this.current = options.current;
        this.version = options.version;
        this.fromVersion = options.fromVersion;
        this.lastSeen = options.seen;
    }

    /** The first tool response after a changed or unknown instruction set carries its full text. */
    take(): string | null {
        if(this.lastSeen == this.current) return null;
        this.lastSeen = this.current;
        const from = this.fromVersion == null ? "" : ` from ${this.fromVersion}`;
        return `concos updated${from} to ${this.version} during this session and its instructions changed; follow the instructions below.\n\n${this.current}`;
    }

    /** What the next server inherits; reading it does not consume the pending update. */
    seen(): string {
        return this.lastSeen ?? "";
    }
}

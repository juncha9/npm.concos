import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
    CARD_FIELD_PREVIEW_LENGTH,
    CHECK_IN_MAX_AGENTS,
    CHECK_IN_MAX_CHARS,
    CHECK_IN_MAX_MESSAGES,
    INSPECT_CHECKPOINT_DEFAULT_LIMIT,
    MESSAGE_PREVIEW_LENGTH,
    MAX_LIST_ITEMS,
    MAX_LIST_ITEM_LENGTH,
    AGENT_RETENTION_MS,
    CHECKPOINT_KEEP_PER_AGENT,
    ENDED_AFTER_MS,
    MAX_DISPLAY_NAME_LENGTH,
    MAX_RECIPIENTS,
    MAX_SIMILAR_TOPICS,
    MAX_TOPIC_KEY_LENGTH,
    MAX_TOPICS_PER_MESSAGE,
    MIN_TOPIC_KEY_LENGTH,
    OFFLINE_AFTER_MS,
    RESOLVED_MESSAGE_GRACE_MS,
    UNDELIVERED_MESSAGE_RETENTION_MS,
    READ_MESSAGES_DEFAULT_LIMIT,
    RECIPIENT_ALL,
    SHARED_ROOM,
    STALE_CARD_MS,
    TOPIC_KEY_PATTERN,
    WAKE_HOURLY_LIMIT,
} from "../../_defs";
import type { AgentStatus, MessageKind } from "../../_defs";
import { runInTransaction } from "./database";
import { RoomError } from "./room-error";
import type { HookEvent } from "../hooks/types";

interface AgentRow {
    id: string;
    room: string;
    display_name: string;
    client: string;
    is_human: number;
    workspace_id: string | null;
    working_directory: string | null;
    status: AgentStatus;
    task: string;
    summary: string;
    next_step: string;
    blocker: string;
    reference_list: string;
    editing_list: string;
    revision: number;
    changed_seq: number;
    delivered_seq: number;
    joined_at: string;
    updated_at: string;
    editing_updated_at: string | null;
    last_seen_at: string;
    disconnected_at: string | null;
    left_at: string | null;
}

interface MessageRow {
    id: number;
    seq: number;
    sender_agent_id: string;
    sender_name: string;
    recipient_agent_id: string | null;
    recipient_scope: "direct" | "group" | "all";
    kind: MessageKind;
    reply_to_message_id: number | null;
    body: string;
    created_at: string;
    received_at: string | null;
    /** JSON array of topic keys in the sender's order (`MESSAGE_TOPICS_COLUMN`). */
    topics: string;
}

/** Selects `topics` for a message aliased `M`: a JSON array of its topic keys in the sender's order. */
const MESSAGE_TOPICS_COLUMN = `(
    SELECT json_group_array(MT.topic_key ORDER BY MT.position)
    FROM message_topic AS MT
    WHERE MT.message_id = M.id
) AS topics`;

export interface SendResult {
    message_id: number;
    recipient_count: number;
    duplicate?: true;
    /** Named recipients whose session ended or left: stored for them, but nobody reads it until they return. */
    inactive_recipients?: string[];
    reply_target_removed?: true;
    /** Topics already in use that look like a new topic this message introduced. */
    similar_topics?: string[];
}

const AGENT_COLUMNS = `
    id, room, display_name, client, is_human, workspace_id, working_directory,
    status, task, summary, next_step, blocker, reference_list, editing_list,
    revision, changed_seq, delivered_seq, joined_at, updated_at, editing_updated_at,
    last_seen_at, disconnected_at, left_at
`;

export interface CardUpdate {
    status?: AgentStatus;
    task?: string;
    summary?: string;
    nextStep?: string;
    blocker?: string;
    references?: string[];
    editing?: string[];
    /** The card's name; renaming needs no new join. Empty or blank keeps the current name. */
    displayName?: string;
}

export interface JoinResult {
    agent_id: string;
    handle: string;
    room: string;
    workspace_id: string;
    resumed: boolean;
}

export interface InboxCounts {
    questions: number;
    notes: number;
}

/** An unread message a hook points the model at: a question to it, or an answer to its own question. */
export interface HookNotice {
    id: number;
    seq: number;
    kind: MessageKind;
    from_name: string;
    /** The message's first topic key. */
    topic: string | null;
}

export interface HookOutcome {
    agentId: string;
    joined?: JoinResult;
    /** Unread messages to mention: at session start and on a prompt. */
    notices?: HookNotice[];
    /** Set when the turn end should continue the turn: the messages it continues for. */
    continueFor?: HookNotice[];
}

/** A Claude Code idle-wake watch: the session it watches, and the generation that keeps it live. */
export interface WakeWatch {
    agentId: string;
    generation: number;
}

export type WakeCheck =
    | { state: "stop" }
    | { state: "wait" }
    | { state: "wake"; notices: HookNotice[] };

export interface CompactCard {
    agent_id: string;
    name: string;
    status: AgentStatus;
    task?: string;
    next_step?: string;
    blocker?: string;
    editing?: string[];
    checkpoint?: string;
    workspace_id?: string;
    human?: true;
    offline?: true;
    stale?: true;
    left?: true;
}

export interface MessagePreview {
    id: number;
    from: string;
    from_name: string;
    /** `me` (to you alone), `group` (to you and others), `all`, or another agent's id. */
    to: string;
    kind: MessageKind;
    reply_to?: number;
    topics?: string[];
    text: string;
    truncated?: true;
}

export interface CheckInResult {
    changed: boolean;
    agents?: CompactCard[];
    messages?: MessagePreview[];
    pending_count: number;
    cursor: string;
    has_more?: true;
    revision: number;
}

export interface FullCard {
    agent_id: string;
    name: string;
    client: string;
    human: boolean;
    status: AgentStatus;
    task: string;
    summary: string;
    next_step: string;
    blocker: string;
    references: string[];
    editing: string[];
    editing_updated_at: string | null;
    workspace: { id: string; path: string; verified: boolean } | null;
    working_directory: string | null;
    revision: number;
    updated_at: string;
    last_seen_at: string;
    online: boolean;
    stale: boolean;
    left: boolean;
}

export interface InspectResult {
    card: FullCard;
    checkpoints: { id: number; at: string; text: string }[];
    has_more_checkpoints?: true;
}

export interface FullMessage {
    id: number;
    from: string;
    from_name: string;
    /** Same values as `MessagePreview.to`. */
    to: string;
    kind: MessageKind;
    reply_to?: number;
    topics?: string[];
    text: string;
    at: string;
    received: boolean;
}

export interface RoomOverviewAgent {
    agent_id: string;
    name: string;
    client: string;
    human: boolean;
    status: AgentStatus;
    task: string;
    next_step: string;
    blocker: string;
    editing: string[];
    workspace_path: string | null;
    updated_at: string;
    online: boolean;
    stale: boolean;
    left: boolean;
    /** Closed or silent past ENDED_AFTER_MS; the board folds these away. */
    ended: boolean;
    pending_count: number;
}

export interface RoomOverviewParticipant {
    name: string;
    client: string;
    human: boolean;
}

export interface RoomOverviewMessage {
    id: number;
    at: string;
    from_name: string;
    from_client: string;
    from_human: boolean;
    to_name: string | null;
    recipients: RoomOverviewParticipant[];
    to_agent_id: string | null;
    /** The recipient is a person at the CLI, who acknowledges by opening the message on the board. */
    to_human: boolean;
    /** Topic keys in the sender's order; the first is the one the board groups by. */
    topics: string[];
    /**
     * Every active recipient has acknowledged it. Ended and left recipients are not waited for,
     * or a message to a session that closed would stay open forever; one that comes back reopens it.
     */
    resolved: boolean;
    /** Names of active recipients who have not acknowledged it yet. */
    waiting_on: string[];
    waiting_on_participants: RoomOverviewParticipant[];
    kind: MessageKind;
    reply_to: number | null;
    text: string;
}

function preview(text: string, length: number): string {
    if(text.length <= length) {
        return text;
    }
    return `${text.slice(0, length - 1)}…`;
}

function newIdentifier(prefix: string): string {
    return `${prefix}_${randomBytes(5).toString("hex")}`;
}

function hashHandle(handle: string): string {
    return createHash("sha256").update(handle).digest("hex");
}

function parseList(text: string): string[] {
    return JSON.parse(text) as string[];
}

function formatCursor(seq: number): string {
    return `c${seq}`;
}

function parseCursor(cursor: string): number {
    const match = /^c(\d+)$/.exec(cursor);
    if(match == null) {
        throw new RoomError("invalid cursor; omit it to continue from the last delivered position");
    }
    return Number(match[1]);
}

function isOnline(row: AgentRow, nowMs: number): boolean {
    if(row.left_at != null || row.disconnected_at != null) {
        return false;
    }
    return nowMs - Date.parse(row.last_seen_at) <= OFFLINE_AFTER_MS;
}

function isStale(row: AgentRow, nowMs: number): boolean {
    return nowMs - Date.parse(row.updated_at) > STALE_CARD_MS;
}

/** A session that closed or went silent; an explicit leave is `left`, not ended. People never end. */
function isEnded(row: AgentRow, nowMs: number): boolean {
    if(row.left_at != null || row.is_human == 1) {
        return false;
    }
    if(row.disconnected_at != null) {
        return true;
    }
    return nowMs - Date.parse(row.last_seen_at) > ENDED_AFTER_MS;
}

/**
 * SQL condition on alias `A` matching `isEnded == false && left == false`: a person at the
 * CLI, or an agent whose session is connected and was heard from since `:active_since`.
 */
const ACTIVE_AGENT_CONDITION = `(
    A.left_at IS NULL
    AND (A.is_human = 1 OR (A.disconnected_at IS NULL AND A.last_seen_at >= :active_since))
)`;

/** The `:active_since` value for `ACTIVE_AGENT_CONDITION`; stored times are ISO UTC, so text order is time order. */
function activeSince(nowMs: number): string {
    return new Date(nowMs - ENDED_AFTER_MS).toISOString();
}

/** Lowercase, with spaces and hyphens turned into single underscores: `Webapp login-redirect` → `webapp_login_redirect`. */
function canonicalTopic(raw: string): string {
    return raw.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

/** Topic keys for a message: canonical, valid, without repeats, at most MAX_TOPICS_PER_MESSAGE. */
export function normalizeTopics(raw: string[]): string[] {
    const topics = [...new Set(raw.map(canonicalTopic).filter((topic) => topic != ""))];
    if(topics.length > MAX_TOPICS_PER_MESSAGE) {
        throw new RoomError(`at most ${MAX_TOPICS_PER_MESSAGE} topics per message`);
    }
    for(const topic of topics) {
        const lengthOk = topic.length >= MIN_TOPIC_KEY_LENGTH && topic.length <= MAX_TOPIC_KEY_LENGTH;
        if(lengthOk == false || TOPIC_KEY_PATTERN.test(topic) == false) {
            throw new RoomError(
                `topic "${topic}" must be 2-6 lowercase English words joined by underscores, broad to narrow, e.g. webapp_login_redirect`
            );
        }
    }
    return topics;
}

/** A topic or the leading words of one, for reading a topic with everything narrower under it. */
function normalizeTopicPrefix(raw: string): string {
    const topic = canonicalTopic(raw);
    if(/^[a-z0-9]+(_[a-z0-9]+){0,5}$/.test(topic) == false || topic.length > MAX_TOPIC_KEY_LENGTH) {
        throw new RoomError("topic must be lowercase English words joined by underscores, e.g. webapp or webapp_login");
    }
    return topic;
}

/**
 * Existing topics that look like `topic`, so the sender can reuse one instead of splitting an
 * issue across spellings: one is a leading part of the other, or they share the first word and
 * another word, or they are the same words in another order.
 */
function similarTopics(topic: string, existing: string[]): string[] {
    const words = topic.split("_");
    return existing.filter((other) => {
        if(other == topic) {
            return false;
        }
        if(other.startsWith(`${topic}_`) == true || topic.startsWith(`${other}_`) == true) {
            return true;
        }
        const otherWords = other.split("_");
        const sameWords = otherWords.length == words.length && [...otherWords].sort().join("_") == [...words].sort().join("_");
        if(sameWords == true) {
            return true;
        }
        return otherWords[0] == words[0] && otherWords.slice(1).some((word) => words.slice(1).includes(word));
    });
}

/** How a message is addressed, as seen by `viewerId`. */
function addressedTo(row: { recipient_agent_id: string | null; recipient_scope: string }, viewerId: string): string {
    if(row.recipient_scope == "all") {
        return RECIPIENT_ALL;
    }
    if(row.recipient_scope == "group") {
        return "group";
    }
    if(row.recipient_agent_id == viewerId) {
        return "me";
    }
    return row.recipient_agent_id ?? RECIPIENT_ALL;
}

/** Canonical comparison key for a workspace path; an unreachable path stays separate from verified ones. */
function resolveWorkspacePath(rawPath: string): { displayPath: string; comparePath: string; isVerified: boolean } {
    if(path.isAbsolute(rawPath) == false) {
        throw new RoomError("working_directory and workspace_root must be absolute paths");
    }
    const displayPath = path.resolve(rawPath);
    try {
        const realPath = fs.realpathSync.native(displayPath);
        return { displayPath: displayPath, comparePath: realPath, isVerified: true };
    }
    catch {
        return { displayPath: displayPath, comparePath: `unverified:${displayPath}`, isVerified: false };
    }
}

function applyCardUpdate(current: AgentRow, update: CardUpdate): {
    values: Pick<AgentRow, "status" | "task" | "summary" | "next_step" | "blocker" | "reference_list" | "editing_list">;
    cardChanged: boolean;
    editingChanged: boolean;
} {
    const values = {
        status: update.status ?? current.status,
        task: update.task?.trim() ?? current.task,
        summary: update.summary?.trim() ?? current.summary,
        next_step: update.nextStep?.trim() ?? current.next_step,
        blocker: update.blocker?.trim() ?? current.blocker,
        reference_list: current.reference_list,
        editing_list: current.editing_list,
    };
    if(update.references != null) {
        values.reference_list = JSON.stringify(update.references);
    }
    if(update.editing != null) {
        values.editing_list = JSON.stringify(update.editing);
    }
    const editingChanged = values.editing_list != current.editing_list;
    const cardChanged = editingChanged == true
        || values.status != current.status
        || values.task != current.task
        || values.summary != current.summary
        || values.next_step != current.next_step
        || values.blocker != current.blocker
        || values.reference_list != current.reference_list;
    return { values: values, cardChanged: cardChanged, editingChanged: editingChanged };
}

/**
 * Domain operations on the shared database. Every bridge, CLI command and hook
 * opens its own connection and goes through this class; SQLite serializes writers.
 * Methods take an already-resolved agent id; handle resolution is separate.
 */
export class RoomStore {
    private readonly database: DatabaseSync;
    /*
     * SQL text → its statement, prepared once on this connection. The SQL in this class binds every
     * value, so this holds a few dozen entries; SQL built with a value inside would grow it forever.
     */
    private readonly statements = new Map<string, StatementSync>();

    constructor(database: DatabaseSync) {
        this.database = database;
    }

    /**
     * A statement prepared anew on every call stays in native memory until garbage collection, which
     * node:sqlite does not hurry because V8 cannot see that memory. Reusing one keeps it flat.
     */
    private prepare(sql: string): StatementSync {
        let statement = this.statements.get(sql);
        if(statement == null) {
            statement = this.database.prepare(sql);
            this.statements.set(sql, statement);
        }
        return statement;
    }

    /** One counter orders card changes and messages together, so a single cursor covers both. */
    private nextSeq(): number {
        const row = this.prepare(`
            UPDATE meta SET value = CAST(value AS INTEGER) + 1
            WHERE key = 'last_seq'
            RETURNING CAST(value AS INTEGER) AS seq
        `).get() as { seq: number };
        return row.seq;
    }

    private readLastSeq(): number {
        const row = this.prepare(`
            SELECT CAST(value AS INTEGER) AS seq FROM meta WHERE key = 'last_seq'
        `).get() as { seq: number };
        return row.seq;
    }

    private selectAgent(agentId: string): AgentRow | null {
        const row = this.prepare(`SELECT ${AGENT_COLUMNS} FROM agent WHERE id = :id`).get({ id: agentId });
        if(row == null) {
            return null;
        }
        return row as unknown as AgentRow;
    }

    private requireAgent(agentId: string): AgentRow {
        const row = this.selectAgent(agentId);
        if(row == null) {
            throw new RoomError(`unknown agent ${agentId}`);
        }
        return row;
    }

    private selectLatestCheckpoint(agentId: string): string | null {
        const row = this.prepare(`
            SELECT body FROM checkpoint WHERE agent_id = :agent_id ORDER BY id DESC LIMIT 1
        `).get({ agent_id: agentId }) as { body: string } | undefined;
        if(row == null) {
            return null;
        }
        return row.body;
    }

    private countPending(agentId: string): number {
        const row = this.prepare(`
            SELECT COUNT(*) AS pending_count
            FROM message_receipt
            WHERE agent_id = :agent_id AND received_at IS NULL
        `).get({ agent_id: agentId }) as { pending_count: number };
        return row.pending_count;
    }

    /** Counts only; looking at an inbox never acknowledges or advances its cursor. */
    /** `excludeMessageIds`: delivered in full in the response being built, so not "waiting" any more. */
    getInbox(agentId: string, excludeMessageIds: number[] = []): InboxCounts | undefined {
        const row = this.prepare(`
            SELECT SUM(M.kind = 'question') AS questions, SUM(M.kind <> 'question') AS notes
            FROM message_receipt AS R JOIN message AS M ON M.id = R.message_id
            WHERE R.agent_id = :id
                AND R.received_at IS NULL
                AND R.message_id NOT IN (SELECT value FROM json_each(:exclude))
        `).get({ id: agentId, exclude: JSON.stringify(excludeMessageIds) }) as { questions: number | null; notes: number | null };
        if(!row.questions && !row.notes) {
            return undefined;
        }
        return { questions: row.questions ?? 0, notes: row.notes ?? 0 };
    }

    private hookHandle(host: string, sessionId: string): string {
        const row = this.prepare("SELECT value FROM meta WHERE key = 'hook_handle_secret'").get() as { value: string };
        return createHmac("sha256", row.value).update(JSON.stringify([host, sessionId])).digest("base64url");
    }

    requireAgentIdByHandle(handle: string): string {
        const row = this.prepare(`
            SELECT id FROM agent WHERE handle_hash = :handle_hash
        `).get({ handle_hash: hashHandle(handle) }) as { id: string } | undefined;
        if(row == null) {
            throw new RoomError("unknown handle; call join again");
        }
        return row.id;
    }

    join(input: {
        /** Legacy input; all participants now join the shared room. */
        room?: string;
        displayName: string;
        client: string;
        workingDirectory: string;
        workspaceRoot: string | null;
        resumeHandle: string | null;
        hookSession?: { host: string; sessionId: string };
    }): JoinResult {
        const room = SHARED_ROOM;
        if(path.isAbsolute(input.workingDirectory) == false) {
            throw new RoomError("working_directory must be an absolute path");
        }
        const workspacePath = resolveWorkspacePath(input.workspaceRoot ?? input.workingDirectory);
        const workingDirectory = path.resolve(input.workingDirectory);
        const nowText = new Date().toISOString();

        return runInTransaction(this.database, () => {
            const session = input.hookSession;
            const existingSession = session == null ? undefined : this.prepare(`
                SELECT id, room FROM agent WHERE host = :host AND host_session_id = :session_id
            `).get({ host: session.host, session_id: session.sessionId }) as { id: string; room: string } | undefined;
            if(existingSession != null && existingSession.room != room) {
                throw new RoomError("host session belongs to another room");
            }
            let workspaceId: string;
            const existingWorkspace = this.prepare(`
                SELECT id FROM workspace WHERE compare_path = :compare_path
            `).get({ compare_path: workspacePath.comparePath }) as { id: string } | undefined;
            if(existingWorkspace != null) {
                workspaceId = existingWorkspace.id;
            }
            else {
                workspaceId = newIdentifier("ws");
                this.prepare(`
                    INSERT INTO workspace (id, display_path, compare_path, is_verified, created_at)
                    VALUES (:id, :display_path, :compare_path, :is_verified, :created_at)
                `).run({
                    id: workspaceId,
                    display_path: workspacePath.displayPath,
                    compare_path: workspacePath.comparePath,
                    is_verified: Number(workspacePath.isVerified),
                    created_at: nowText,
                });
            }

            const seq = this.nextSeq();
            const resumeHandle = existingSession != null && session != null
                ? this.hookHandle(session.host, session.sessionId) : input.resumeHandle;
            if(resumeHandle != null) {
                const resumedId = this.requireAgentIdByHandle(resumeHandle);
                const resumed = this.requireAgent(resumedId);
                if(resumed.room != room) {
                    throw new RoomError("resume_handle belongs to another room");
                }
                this.prepare(`
                    UPDATE agent
                    SET display_name = :display_name,
                        client = :client,
                        workspace_id = :workspace_id,
                        working_directory = :working_directory,
                        changed_seq = :changed_seq,
                        last_seen_at = :now,
                        status = CASE WHEN left_at IS NOT NULL THEN 'working' ELSE status END,
                        disconnected_at = NULL,
                        left_at = NULL
                    WHERE id = :id
                `).run({
                    id: resumed.id,
                    display_name: session == null ? input.displayName : resumed.display_name,
                    client: session == null ? input.client : resumed.client,
                    workspace_id: workspaceId,
                    working_directory: workingDirectory,
                    changed_seq: seq,
                    now: nowText,
                });
                return { agent_id: resumed.id, handle: resumeHandle, room: room, workspace_id: workspaceId, resumed: true };
            }

            const agentId = newIdentifier("agt");
            const handle = session == null ? randomBytes(24).toString("base64url") : this.hookHandle(session.host, session.sessionId);
            this.prepare(`
                INSERT INTO agent (
                    id, room, handle_hash, display_name, client, is_human, workspace_id, working_directory,
                    changed_seq, joined_at, updated_at, last_seen_at, host, host_session_id
                )
                VALUES (
                    :id, :room, :handle_hash, :display_name, :client, 0, :workspace_id, :working_directory,
                    :changed_seq, :now, :now, :now, :host, :host_session_id
                )
            `).run({
                id: agentId,
                room: room,
                handle_hash: hashHandle(handle),
                display_name: input.displayName,
                client: input.client,
                workspace_id: workspaceId,
                working_directory: workingDirectory,
                changed_seq: seq,
                host: session?.host ?? null,
                host_session_id: session?.sessionId ?? null,
                now: nowText,
            });
            return { agent_id: agentId, handle: handle, room: room, workspace_id: workspaceId, resumed: false };
        });
    }

    /**
     * Unread messages a hook may point out, newer than `afterSeq`: questions named to this agent,
     * alone or in a group, and answers to its own questions. Room-wide messages would continue
     * every session in the room, and answers to answers would bounce between agents, so neither
     * counts. Reading this list acknowledges nothing.
     */
    hookNotices(agentId: string, afterSeq = 0): HookNotice[] {
        return this.prepare(`
            SELECT
                M.id,
                M.seq,
                M.kind,
                S.display_name AS from_name,
                (
                    SELECT MT.topic_key
                    FROM message_topic AS MT
                    WHERE MT.message_id = M.id
                    ORDER BY MT.position
                    LIMIT 1
                ) AS topic
            FROM message_receipt AS R
            JOIN message AS M
                ON M.id = R.message_id
            JOIN agent AS S
                ON S.id = M.sender_agent_id
            WHERE R.agent_id = :agent_id
                AND R.received_at IS NULL
                AND M.seq > :after_seq
                -- a direct row without a recipient is a room-wide message from an older bridge
                AND (M.recipient_scope = 'group' OR (M.recipient_scope = 'direct' AND M.recipient_agent_id IS NOT NULL))
                AND (
                    M.kind = 'question'
                    OR (
                        M.kind = 'reply'
                        AND EXISTS (
                            SELECT 1
                            FROM message AS Q
                            WHERE Q.id = M.reply_to_message_id
                                AND Q.sender_agent_id = :agent_id
                                AND Q.kind = 'question'
                        )
                    )
                )
            ORDER BY M.seq
        `).all({ agent_id: agentId, after_seq: afterSeq }) as unknown as HookNotice[];
    }

    /**
     * Mechanical hook updates. A hook never calls checkIn, which would move the model's cursor,
     * and never acknowledges a message.
     *
     * Flow:
     *  1) session-start: join or come back by host session key
     *  2) Other events: find the participant by session key; none, or one that left, is ignored
     *  3) A turn end with unread messages not pointed out yet continues the turn once: it stays
     *     working, keeps its editing claims and records how far it has pointed
     *  4) Otherwise apply the event to status and editing; a prompt reports what is unread
     */
    applyHookEvent(event: HookEvent, room = SHARED_ROOM): HookOutcome | null {
        room = SHARED_ROOM;
        // (1) Session start
        if(event.kind == "session-start") {
            const client = event.client ?? event.host;
            // the model's join renames it to the session's own name
            const displayName = `${client} · ${path.basename(event.cwd) || event.cwd}`.slice(0, MAX_DISPLAY_NAME_LENGTH);
            const joined = this.join({
                room, displayName: displayName, client: client,
                workingDirectory: event.cwd, workspaceRoot: null, resumeHandle: null,
                hookSession: { host: event.host, sessionId: event.sessionId },
            });
            return { agentId: joined.agent_id, joined: joined, notices: this.hookNotices(joined.agent_id) };
        }
        return runInTransaction(this.database, () => {
            // (2) Participant
            const row = this.prepare(`
                SELECT id, hook_nudged_seq FROM agent WHERE host = :host AND host_session_id = :session_id AND room = :room
            `).get({ host: event.host, session_id: event.sessionId, room }) as { id: string; hook_nudged_seq: number } | undefined;
            // A missing start or an explicit leave must not create a phantom participant.
            if(row == null) return null;
            const current = this.requireAgent(row.id);
            if(current.left_at != null) return null;
            const now = new Date().toISOString();

            // (3) Continue the turn once per message
            if(event.kind == "turn-end" && event.canContinue == true) {
                const continueFor = this.hookNotices(row.id, row.hook_nudged_seq);
                if(continueFor.length > 0) {
                    this.prepare(`
                        UPDATE agent
                        SET hook_nudged_seq = :nudged_seq, last_seen_at = :now, disconnected_at = NULL
                        WHERE id = :id
                    `).run({ nudged_seq: continueFor[continueFor.length - 1].seq, now: now, id: row.id });
                    return { agentId: row.id, continueFor: continueFor };
                }
            }

            // (4) Status and editing
            let editing = parseList(current.editing_list);
            if(event.kind == "file-edited") {
                const files = event.files.map((file) => {
                    const absolute = path.resolve(event.cwd, file);
                    const workspace = this.prepare("SELECT display_path FROM workspace WHERE id = :id")
                        .get({ id: current.workspace_id }) as { display_path: string };
                    return path.relative(workspace.display_path, absolute).replaceAll(path.sep, "/") || ".";
                }).filter((file) => file.length <= MAX_LIST_ITEM_LENGTH);
                editing = [...new Set([...editing, ...files])].slice(0, MAX_LIST_ITEMS);
            }
            if(event.kind == "turn-end" || event.kind == "session-end") editing = [];
            const status = event.kind == "prompt" ? "working" : event.kind == "turn-end" ? "waiting" : current.status;
            const { values, cardChanged, editingChanged } = applyCardUpdate(current, { status, editing });
            // a prompt means the session is in use: an idle-wake watch from the previous turn ends
            this.prepare(`
                UPDATE agent SET status = :status, editing_list = :editing,
                    revision = revision + :changed, changed_seq = :seq,
                    updated_at = CASE WHEN :changed THEN :now ELSE updated_at END,
                    editing_updated_at = CASE WHEN :editing_changed THEN :now ELSE editing_updated_at END,
                    last_seen_at = :now, disconnected_at = :disconnected,
                    wake_generation = wake_generation + :wake_step
                WHERE id = :id
            `).run({
                id: row.id, status: values.status, editing: values.editing_list,
                changed: Number(cardChanged), seq: cardChanged ? this.nextSeq() : current.changed_seq,
                editing_changed: Number(editingChanged), now,
                disconnected: event.kind == "session-end" ? now : null,
                wake_step: event.kind == "prompt" ? 1 : 0,
            });
            const outcome: HookOutcome = { agentId: row.id };
            if(event.kind == "prompt") {
                outcome.notices = this.hookNotices(row.id);
            }
            return outcome;
        });
    }

    /**
     * Claude Code idle wake: starts a watch for the session behind `event` and makes it the only
     * live one, so a watch left from an earlier turn ends. A session that never started, or
     * left, has nothing to watch.
     */
    startWakeWatch(event: HookEvent): WakeWatch | null {
        return runInTransaction(this.database, () => {
            const row = this.prepare(`
                SELECT id, left_at FROM agent WHERE host = :host AND host_session_id = :session_id
            `).get({ host: event.host, session_id: event.sessionId }) as { id: string; left_at: string | null } | undefined;
            if(row == null || row.left_at != null) {
                return null;
            }
            const started = this.prepare(`
                UPDATE agent SET wake_generation = wake_generation + 1 WHERE id = :id RETURNING wake_generation
            `).get({ id: row.id }) as { wake_generation: number };
            return { agentId: row.id, generation: started.wake_generation };
        });
    }

    /**
     * One look at a watched session.
     *
     * Flow:
     *  1) stop: a newer watch or a prompt replaced this one, or the session ended or left
     *  2) wait: still inside the quiet time, nothing new to point out, or woken enough this hour
     *  3) wake: under the write lock, check again, then record the wake and the messages pointed
     *     out, and end this watch
     *
     * Reads take no lock, so a watch polling every few seconds never holds up other writers.
     */
    checkWakeWatch(watch: WakeWatch, quietEnough: boolean, nowMs: number = Date.now()): WakeCheck {
        // the check, and for a wake the wake times within the last hour
        const look = (): { check: WakeCheck; woken: string[] } => {
            const row = this.prepare(`
                SELECT wake_generation, hook_nudged_seq, woken_at_list, left_at, disconnected_at
                FROM agent
                WHERE id = :id
            `).get({ id: watch.agentId }) as {
                wake_generation: number; hook_nudged_seq: number; woken_at_list: string; left_at: string | null; disconnected_at: string | null;
            } | undefined;
            // (1) Replaced or ended
            if(row == null || row.wake_generation != watch.generation || row.left_at != null || row.disconnected_at != null) {
                return { check: { state: "stop" }, woken: [] };
            }
            // (2) Not now
            if(quietEnough == false) {
                return { check: { state: "wait" }, woken: [] };
            }
            const notices = this.hookNotices(watch.agentId, row.hook_nudged_seq);
            const woken = parseList(row.woken_at_list).filter((at) => nowMs - Date.parse(at) < 60 * 60 * 1000);
            if(notices.length == 0 || woken.length >= WAKE_HOURLY_LIMIT) {
                return { check: { state: "wait" }, woken: [] };
            }
            return { check: { state: "wake", notices: notices }, woken: woken };
        };
        const first = look();
        if(first.check.state != "wake") {
            return first.check;
        }
        // (3) Wake
        return runInTransaction(this.database, () => {
            const confirmed = look();
            if(confirmed.check.state != "wake") {
                return confirmed.check;
            }
            const notices = confirmed.check.notices;
            this.prepare(`
                UPDATE agent
                SET wake_generation = wake_generation + 1, hook_nudged_seq = :nudged_seq, woken_at_list = :woken_at_list
                WHERE id = :id
            `).run({
                nudged_seq: notices[notices.length - 1].seq,
                woken_at_list: JSON.stringify([...confirmed.woken, new Date(nowMs).toISOString()]),
                id: watch.agentId,
            });
            return confirmed.check;
        });
    }

    /**
     * Reports this agent's changes and returns what changed for it since its cursor.
     *
     * Flow:
     *  1) Under the write lock: check revision, mark received messages, apply card changes and checkpoint
     *  2) Snapshot the sequence bound, then read other agents' card changes and messages after the cursor
     *  3) Merge both by sequence and fill the page until a count or character limit is reached
     *  4) Store the new delivered position so the next call can omit the cursor
     */
    checkIn(agentId: string, input: {
        cursor: string | null;
        expectedRevision: number | null;
        update: CardUpdate;
        checkpoint: string | null;
        receivedMessageIds: number[];
    }): CheckInResult {
        const nowMs = Date.now();
        const nowText = new Date(nowMs).toISOString();
        let cursorSeq: number | null = null;
        if(input.cursor != null) {
            cursorSeq = parseCursor(input.cursor);
        }

        // (1) Write
        const agent = runInTransaction(this.database, () => {
            const current = this.requireAgent(agentId);
            if(current.left_at != null) {
                throw new RoomError("this participant has left; join again (pass resume_handle to keep the same agent_id)");
            }
            if(input.expectedRevision != null && input.expectedRevision != current.revision) {
                throw new RoomError(`revision conflict: your card is at revision ${current.revision}; inspect it and retry`);
            }

            const acknowledge = this.prepare(`
                UPDATE message_receipt SET received_at = :now
                WHERE message_id = :message_id AND agent_id = :agent_id AND received_at IS NULL
            `);
            for(const messageId of input.receivedMessageIds) {
                acknowledge.run({ now: nowText, message_id: messageId, agent_id: agentId });
            }

            const checkpoint = input.checkpoint?.trim() ?? "";
            const { values, cardChanged: fieldsChanged, editingChanged } = applyCardUpdate(current, input.update);
            let displayName = current.display_name;
            if(input.update.displayName != null && input.update.displayName.trim() != "") {
                displayName = input.update.displayName.trim();
            }
            const cardChanged = fieldsChanged == true || displayName != current.display_name;
            if(cardChanged == false && checkpoint == "") {
                this.prepare(`
                    UPDATE agent SET last_seen_at = :now, disconnected_at = NULL WHERE id = :id
                `).run({ now: nowText, id: agentId });
                return this.requireAgent(agentId);
            }

            let revision = current.revision;
            if(cardChanged == true) {
                revision += 1;
            }
            let editingUpdatedAt = current.editing_updated_at;
            if(editingChanged == true) {
                editingUpdatedAt = nowText;
            }
            this.prepare(`
                UPDATE agent
                SET display_name = :display_name,
                    status = :status,
                    task = :task,
                    summary = :summary,
                    next_step = :next_step,
                    blocker = :blocker,
                    reference_list = :reference_list,
                    editing_list = :editing_list,
                    revision = :revision,
                    changed_seq = :changed_seq,
                    updated_at = :now,
                    editing_updated_at = :editing_updated_at,
                    last_seen_at = :now,
                    disconnected_at = NULL
                WHERE id = :id
            `).run({
                ...values,
                display_name: displayName,
                revision: revision,
                changed_seq: this.nextSeq(),
                now: nowText,
                editing_updated_at: editingUpdatedAt,
                id: agentId,
            });
            if(checkpoint != "") {
                this.prepare(`
                    INSERT INTO checkpoint (agent_id, workspace_id, body, created_at)
                    VALUES (:agent_id, :workspace_id, :body, :created_at)
                `).run({ agent_id: agentId, workspace_id: current.workspace_id, body: checkpoint, created_at: nowText });
            }
            return this.requireAgent(agentId);
        });

        // (2) Read; rows at or below the bound are committed, so nothing below it can appear later
        const startSeq = cursorSeq ?? agent.delivered_seq;
        const boundSeq = this.readLastSeq();
        // a session that ended or left before this agent joined never reaches it; one that ended
        // later (or in the same millisecond) was seen alive, so its final card is delivered once
        const changedAgents = this.prepare(`
            SELECT ${AGENT_COLUMNS}
            FROM agent AS A
            WHERE A.room = :room
                AND A.id <> :agent_id
                AND A.changed_seq > :start_seq
                AND A.changed_seq <= :bound_seq
                AND (${ACTIVE_AGENT_CONDITION} OR COALESCE(A.left_at, A.disconnected_at, A.last_seen_at) >= :viewer_joined_at)
            ORDER BY A.changed_seq
            LIMIT :limit
        `).all({
            room: agent.room,
            agent_id: agentId,
            start_seq: startSeq,
            bound_seq: boundSeq,
            active_since: activeSince(nowMs),
            viewer_joined_at: agent.joined_at,
            limit: CHECK_IN_MAX_AGENTS + 1,
        }) as unknown as AgentRow[];
        const newMessages = this.prepare(`
            SELECT
                M.id,
                M.seq,
                M.sender_agent_id,
                S.display_name AS sender_name,
                M.recipient_agent_id,
                M.recipient_scope,
                M.kind,
                M.reply_to_message_id,
                M.body,
                M.created_at,
                MR.received_at,
                ${MESSAGE_TOPICS_COLUMN}
            FROM message AS M
            JOIN message_receipt AS MR
                ON MR.message_id = M.id
                AND MR.agent_id = :agent_id
            JOIN agent AS S
                ON S.id = M.sender_agent_id
            WHERE M.seq > :start_seq AND M.seq <= :bound_seq
            ORDER BY M.seq
            LIMIT :limit
        `).all({
            agent_id: agentId,
            start_seq: startSeq,
            bound_seq: boundSeq,
            limit: CHECK_IN_MAX_MESSAGES + 1,
        }) as unknown as MessageRow[];

        // (3) Page
        const events: ({ seq: number; agent: AgentRow } | { seq: number; message: MessageRow })[] = [
            ...changedAgents.map((row) => ({ seq: row.changed_seq, agent: row })),
            ...newMessages.map((row) => ({ seq: row.seq, message: row })),
        ].sort((left, right) => left.seq - right.seq);

        const pendingCount = this.countPending(agentId);
        const cards: CompactCard[] = [];
        const previews: MessagePreview[] = [];
        let deliveredSeq = startSeq;
        let hasMore = false;
        // envelope with every optional key present, so the budget check is never optimistic
        const envelopeLength = JSON.stringify({
            changed: true,
            agents: [],
            messages: [],
            pending_count: pendingCount,
            cursor: formatCursor(boundSeq),
            has_more: true,
            revision: agent.revision,
            inbox: this.getInbox(agentId),
        }).length;
        let usedLength = envelopeLength;

        for(const event of events) {
            let item: CompactCard | MessagePreview;
            if("agent" in event) {
                if(cards.length >= CHECK_IN_MAX_AGENTS) {
                    hasMore = true;
                    break;
                }
                item = this.toCompactCard(event.agent, nowMs);
            }
            else {
                if(previews.length >= CHECK_IN_MAX_MESSAGES) {
                    hasMore = true;
                    break;
                }
                item = this.toMessagePreview(event.message, agentId);
            }
            const itemLength = JSON.stringify(item).length + 1;
            if(cards.length + previews.length > 0 && usedLength + itemLength > CHECK_IN_MAX_CHARS) {
                hasMore = true;
                break;
            }
            usedLength += itemLength;
            if("agent" in event) {
                cards.push(item as CompactCard);
            }
            else {
                previews.push(item as MessagePreview);
            }
            deliveredSeq = event.seq;
        }
        if(hasMore == false) {
            deliveredSeq = Math.max(startSeq, boundSeq);
        }

        // (4) Remember the position
        this.prepare(`
            UPDATE agent SET delivered_seq = :delivered_seq WHERE id = :id
        `).run({ delivered_seq: deliveredSeq, id: agentId });

        const result: CheckInResult = {
            changed: cards.length + previews.length > 0,
            pending_count: pendingCount,
            cursor: formatCursor(deliveredSeq),
            revision: agent.revision,
        };
        if(cards.length > 0) {
            result.agents = cards;
        }
        if(previews.length > 0) {
            result.messages = previews;
        }
        if(hasMore == true) {
            result.has_more = true;
        }
        return result;
    }

    private toCompactCard(row: AgentRow, nowMs: number): CompactCard {
        const card: CompactCard = { agent_id: row.id, name: row.display_name, status: row.status };
        if(row.task != "") {
            card.task = preview(row.task, CARD_FIELD_PREVIEW_LENGTH);
        }
        if(row.next_step != "") {
            card.next_step = preview(row.next_step, CARD_FIELD_PREVIEW_LENGTH);
        }
        if(row.blocker != "") {
            card.blocker = preview(row.blocker, CARD_FIELD_PREVIEW_LENGTH);
        }
        const editing = parseList(row.editing_list);
        if(editing.length > 0) {
            card.editing = editing.map((entry) => preview(entry, CARD_FIELD_PREVIEW_LENGTH));
        }
        const checkpoint = this.selectLatestCheckpoint(row.id);
        if(checkpoint != null) {
            card.checkpoint = preview(checkpoint, CARD_FIELD_PREVIEW_LENGTH);
        }
        if(row.workspace_id != null) {
            card.workspace_id = row.workspace_id;
        }
        if(row.is_human == 1) {
            card.human = true;
            return card;
        }
        if(row.left_at != null) {
            card.left = true;
            return card;
        }
        if(isOnline(row, nowMs) == false) {
            card.offline = true;
        }
        if(isStale(row, nowMs) == true) {
            card.stale = true;
        }
        return card;
    }

    private toMessagePreview(row: MessageRow, viewerId: string): MessagePreview {
        const item: MessagePreview = {
            id: row.id,
            from: row.sender_agent_id,
            from_name: row.sender_name,
            to: addressedTo(row, viewerId),
            kind: row.kind,
            text: preview(row.body, MESSAGE_PREVIEW_LENGTH),
        };
        if(row.reply_to_message_id != null) {
            item.reply_to = row.reply_to_message_id;
        }
        const topics = parseList(row.topics);
        if(topics.length > 0) {
            item.topics = topics;
        }
        if(row.body.length > MESSAGE_PREVIEW_LENGTH) {
            item.truncated = true;
        }
        return item;
    }

    inspectAgent(viewerId: string, input: {
        agentId: string;
        checkpointLimit: number | null;
        beforeCheckpointId: number | null;
    }): InspectResult {
        const viewer = this.requireAgent(viewerId);
        const target = this.selectAgent(input.agentId);
        if(target == null || target.room != viewer.room) {
            throw new RoomError(`no agent ${input.agentId} in room ${viewer.room}`);
        }
        const nowMs = Date.now();

        let workspace: FullCard["workspace"] = null;
        if(target.workspace_id != null) {
            const workspaceRow = this.prepare(`
                SELECT id, display_path, is_verified FROM workspace WHERE id = :id
            `).get({ id: target.workspace_id }) as { id: string; display_path: string; is_verified: number };
            workspace = { id: workspaceRow.id, path: workspaceRow.display_path, verified: workspaceRow.is_verified == 1 };
        }

        const limit = input.checkpointLimit ?? INSPECT_CHECKPOINT_DEFAULT_LIMIT;
        const checkpointRows = this.prepare(`
            SELECT id, body, created_at
            FROM checkpoint
            WHERE agent_id = :agent_id AND (:before_id IS NULL OR id < :before_id)
            ORDER BY id DESC
            LIMIT :limit
        `).all({ agent_id: target.id, before_id: input.beforeCheckpointId, limit: limit + 1 }) as {
            id: number;
            body: string;
            created_at: string;
        }[];

        const result: InspectResult = {
            card: {
                agent_id: target.id,
                name: target.display_name,
                client: target.client,
                human: target.is_human == 1,
                status: target.status,
                task: target.task,
                summary: target.summary,
                next_step: target.next_step,
                blocker: target.blocker,
                references: parseList(target.reference_list),
                editing: parseList(target.editing_list),
                editing_updated_at: target.editing_updated_at,
                workspace: workspace,
                working_directory: target.working_directory,
                revision: target.revision,
                updated_at: target.updated_at,
                last_seen_at: target.last_seen_at,
                online: isOnline(target, nowMs),
                stale: isStale(target, nowMs),
                left: target.left_at != null,
            },
            checkpoints: checkpointRows.slice(0, limit).map((row) => ({ id: row.id, at: row.created_at, text: row.body })),
        };
        if(checkpointRows.length > limit) {
            result.has_more_checkpoints = true;
        }
        return result;
    }

    /**
     * Stores a message for one agent, several, or the whole room, tagged with up to three topics.
     *
     * Flow:
     *  1) Check the text, the reply kind and the topic keys before taking the write lock
     *  2) Repeat of a request id: return the stored message
     *  3) Resolve recipients into a scope: `direct` (one), `group` (several) or `all`
     *  4) Check reply_to; a reply to a message already cleaned up keeps its text and loses the link
     *  5) Insert the message, its topics and its receipts
     *  6) Report inactive recipients, a removed reply target, and existing topics similar to new ones
     */
    sendMessage(senderId: string, input: {
        to: string | string[];
        kind: MessageKind;
        text: string;
        replyTo: number | null;
        requestId: string | null;
        topics?: string[];
    }): SendResult {
        // (1) Input
        const text = input.text.trim();
        if(text == "") {
            throw new RoomError("text is empty");
        }
        if(input.kind == "reply" && input.replyTo == null) {
            throw new RoomError("kind reply needs reply_to");
        }
        const topics = normalizeTopics(input.topics ?? []);

        return runInTransaction(this.database, () => {
            const sender = this.requireAgent(senderId);
            if(sender.left_at != null) {
                throw new RoomError("this participant has left; join again before sending");
            }

            // (2) Retry
            if(input.requestId != null) {
                const existing = this.prepare(`
                    SELECT
                        M.id,
                        (SELECT COUNT(*) FROM message_receipt AS MR WHERE MR.message_id = M.id) AS recipient_count
                    FROM message AS M
                    WHERE M.sender_agent_id = :sender_agent_id AND M.request_id = :request_id
                `).get({ sender_agent_id: senderId, request_id: input.requestId }) as { id: number; recipient_count: number } | undefined;
                if(existing != null) {
                    return { message_id: existing.id, recipient_count: existing.recipient_count, duplicate: true as const };
                }
            }

            // (3) Recipients
            const nowMs = Date.now();
            const requested = [...new Set(Array.isArray(input.to) ? input.to : [input.to])];
            let scope: "direct" | "group" | "all" = "all";
            const recipientIds: string[] = [];
            const inactiveRecipients: string[] = [];
            if(requested.includes(RECIPIENT_ALL) == true) {
                if(requested.length > 1) {
                    throw new RoomError("send to \"all\" alone, or list agent ids");
                }
            }
            else {
                if(requested.length > MAX_RECIPIENTS) {
                    throw new RoomError(`at most ${MAX_RECIPIENTS} recipients; use "all" for the whole room`);
                }
                for(const agentId of requested) {
                    const recipient = this.selectAgent(agentId);
                    if(recipient == null || recipient.room != sender.room) {
                        throw new RoomError(`no agent ${agentId} in room ${sender.room}`);
                    }
                    if(recipient.id == senderId) {
                        throw new RoomError("cannot send a message to yourself");
                    }
                    recipientIds.push(recipient.id);
                    // still stored: an ended session that comes back reads it, but the sender should know
                    if(recipient.left_at != null || isEnded(recipient, nowMs) == true) {
                        inactiveRecipients.push(recipient.id);
                    }
                }
                scope = "direct";
                if(recipientIds.length > 1) {
                    scope = "group";
                }
            }

            // (4) Reply target
            let replyTo = input.replyTo;
            let replyTargetRemoved = false;
            if(replyTo != null) {
                const target = this.prepare(`SELECT id FROM message WHERE id = :id`).get({ id: replyTo });
                if(target == null) {
                    // cleaned up after it was resolved: the answer still goes out, without the link
                    replyTo = null;
                    replyTargetRemoved = true;
                }
            }
            if(replyTo != null) {
                const visible = this.prepare(`
                    SELECT 1 AS found
                    FROM message AS M
                    WHERE M.id = :message_id
                        AND M.room = :room
                        AND (
                            M.sender_agent_id = :agent_id
                            OR EXISTS (
                                SELECT 1 FROM message_receipt AS MR
                                WHERE MR.message_id = M.id AND MR.agent_id = :agent_id
                            )
                        )
                `).get({ message_id: replyTo, room: sender.room, agent_id: senderId });
                if(visible == null) {
                    throw new RoomError(`message ${replyTo} is not one you sent or received`);
                }
            }

            // topics already in use, read before this message adds its own
            const knownTopics = (this.prepare(`SELECT DISTINCT topic_key FROM message_topic`).all() as { topic_key: string }[])
                .map((row) => row.topic_key);

            // (5) Insert
            let directRecipient: string | null = null;
            if(scope == "direct") {
                directRecipient = recipientIds[0];
            }
            const inserted = this.prepare(`
                INSERT INTO message (
                    seq, room, sender_agent_id, recipient_agent_id, recipient_scope, kind, reply_to_message_id,
                    body, workspace_id, request_id, created_at
                )
                VALUES (
                    :seq, :room, :sender_agent_id, :recipient_agent_id, :recipient_scope, :kind, :reply_to_message_id,
                    :body, :workspace_id, :request_id, :created_at
                )
                RETURNING id
            `).get({
                seq: this.nextSeq(),
                room: sender.room,
                sender_agent_id: senderId,
                recipient_agent_id: directRecipient,
                recipient_scope: scope,
                kind: input.kind,
                reply_to_message_id: replyTo,
                body: text,
                workspace_id: sender.workspace_id,
                request_id: input.requestId,
                created_at: new Date(nowMs).toISOString(),
            }) as { id: number };

            const insertTopic = this.prepare(`
                INSERT INTO message_topic (message_id, topic_key, position) VALUES (:message_id, :topic_key, :position)
            `);
            topics.forEach((topic, position) => {
                insertTopic.run({ message_id: inserted.id, topic_key: topic, position: position });
            });

            /*
             * A room-wide message gets one receipt per agent active now. Later joiners, ended
             * sessions and people at the CLI get none: a receipt they can never acknowledge only
             * piles up. Named recipients keep their receipt unless they left.
             */
            const receipts = this.prepare(`
                INSERT INTO message_receipt (message_id, agent_id)
                SELECT :message_id, A.id
                FROM agent AS A
                WHERE A.room = :room
                    AND A.id <> :sender_agent_id
                    AND A.left_at IS NULL
                    AND (
                        (:scope = 'all' AND A.is_human = 0 AND ${ACTIVE_AGENT_CONDITION})
                        OR (:scope <> 'all' AND A.id IN (SELECT value FROM json_each(:recipients)))
                    )
            `).run({
                message_id: inserted.id,
                room: sender.room,
                sender_agent_id: senderId,
                scope: scope,
                recipients: JSON.stringify(recipientIds),
                active_since: activeSince(nowMs),
            });

            // (6) Report
            const result: SendResult = { message_id: inserted.id, recipient_count: Number(receipts.changes) };
            if(inactiveRecipients.length > 0) {
                result.inactive_recipients = inactiveRecipients;
            }
            if(replyTargetRemoved == true) {
                result.reply_target_removed = true;
            }
            const similar = new Set<string>();
            for(const topic of topics) {
                if(knownTopics.includes(topic) == true) {
                    continue;
                }
                for(const other of similarTopics(topic, knownTopics)) {
                    similar.add(other);
                }
            }
            if(similar.size > 0) {
                result.similar_topics = [...similar].sort().slice(0, MAX_SIMILAR_TOPICS);
            }
            return result;
        });
    }

    /**
     * Full message text. With ids: those messages. With a topic: the newest messages under that
     * topic or its narrower topics. Otherwise: the caller's messages not yet received. Only
     * messages the caller sent or received are visible.
     */
    readMessages(viewerId: string, input: { messageIds: number[] | null; limit: number | null; topic?: string | null }): {
        messages: FullMessage[];
        has_more?: true;
    } {
        const viewer = this.requireAgent(viewerId);
        const limit = input.limit ?? READ_MESSAGES_DEFAULT_LIMIT;
        const selectColumns = `
            SELECT
                M.id,
                M.seq,
                M.sender_agent_id,
                S.display_name AS sender_name,
                M.recipient_agent_id,
                M.recipient_scope,
                M.kind,
                M.reply_to_message_id,
                M.body,
                M.created_at,
                MR.received_at,
                ${MESSAGE_TOPICS_COLUMN}
            FROM message AS M
            JOIN agent AS S
                ON S.id = M.sender_agent_id
            LEFT JOIN message_receipt AS MR
                ON MR.message_id = M.id
                AND MR.agent_id = :agent_id
        `;

        let pageRows: MessageRow[];
        let hasMore: boolean;
        if(input.messageIds != null && input.messageIds.length > 0) {
            const rows = this.prepare(`
                ${selectColumns}
                WHERE M.id IN (SELECT value FROM json_each(:message_ids))
                    AND M.room = :room
                    AND (MR.agent_id IS NOT NULL OR M.sender_agent_id = :agent_id)
                ORDER BY M.seq
                LIMIT :limit
            `).all({
                agent_id: viewerId,
                message_ids: JSON.stringify(input.messageIds),
                room: viewer.room,
                limit: limit + 1,
            }) as unknown as MessageRow[];
            pageRows = rows.slice(0, limit);
            hasMore = rows.length > limit;
        }
        else if(input.topic != null && input.topic.trim() != "") {
            const topic = normalizeTopicPrefix(input.topic);
            // newest first to cut the page, then back to reading order
            const rows = this.prepare(`
                ${selectColumns}
                WHERE M.room = :room
                    AND (MR.agent_id IS NOT NULL OR M.sender_agent_id = :agent_id)
                    AND EXISTS (
                        SELECT 1 FROM message_topic AS T
                        WHERE T.message_id = M.id
                            AND (T.topic_key = :topic OR substr(T.topic_key, 1, length(:topic) + 1) = :topic || '_')
                    )
                ORDER BY M.seq DESC
                LIMIT :limit
            `).all({ agent_id: viewerId, room: viewer.room, topic: topic, limit: limit + 1 }) as unknown as MessageRow[];
            pageRows = rows.slice(0, limit).reverse();
            hasMore = rows.length > limit;
        }
        else {
            const rows = this.prepare(`
                ${selectColumns}
                WHERE MR.agent_id IS NOT NULL AND MR.received_at IS NULL
                ORDER BY M.seq
                LIMIT :limit
            `).all({ agent_id: viewerId, limit: limit + 1 }) as unknown as MessageRow[];
            pageRows = rows.slice(0, limit);
            hasMore = rows.length > limit;
        }

        const messages = pageRows.map((row) => {
            const message: FullMessage = {
                id: row.id,
                from: row.sender_agent_id,
                from_name: row.sender_name,
                to: addressedTo(row, viewerId),
                kind: row.kind,
                text: row.body,
                at: row.created_at,
                received: row.received_at != null,
            };
            if(row.reply_to_message_id != null) {
                message.reply_to = row.reply_to_message_id;
            }
            const topics = parseList(row.topics);
            if(topics.length > 0) {
                message.topics = topics;
            }
            return message;
        });
        const result: { messages: FullMessage[]; has_more?: true } = { messages: messages };
        if(hasMore == true) {
            result.has_more = true;
        }
        return result;
    }

    /** Leaves the final context on the card, clears the editing claim and marks the participant left. */
    leave(agentId: string, input: { summary: string | null; nextStep: string | null; checkpoint: string | null }): { left: true } {
        const nowText = new Date().toISOString();
        runInTransaction(this.database, () => {
            const current = this.requireAgent(agentId);
            if(current.left_at != null) {
                return;
            }
            const { values } = applyCardUpdate(current, {
                status: "finished",
                summary: input.summary ?? undefined,
                nextStep: input.nextStep ?? undefined,
                editing: [],
            });
            this.prepare(`
                UPDATE agent
                SET status = :status,
                    task = :task,
                    summary = :summary,
                    next_step = :next_step,
                    blocker = :blocker,
                    reference_list = :reference_list,
                    editing_list = :editing_list,
                    revision = revision + 1,
                    changed_seq = :changed_seq,
                    updated_at = :now,
                    editing_updated_at = :now,
                    last_seen_at = :now,
                    left_at = :now
                WHERE id = :id
            `).run({ ...values, changed_seq: this.nextSeq(), now: nowText, id: agentId });
            const checkpoint = input.checkpoint?.trim() ?? "";
            if(checkpoint != "") {
                this.prepare(`
                    INSERT INTO checkpoint (agent_id, workspace_id, body, created_at)
                    VALUES (:agent_id, :workspace_id, :body, :created_at)
                `).run({ agent_id: agentId, workspace_id: current.workspace_id, body: checkpoint, created_at: nowText });
            }
        });
        return { left: true };
    }

    /**
     * Deletes messages, with their receipts, that no active participant is waiting on any more.
     *
     * Flow:
     *  1) Candidates: nothing pending on an active agent, and either fully acknowledged past
     *     RESOLVED_MESSAGE_GRACE_MS, or sent past UNDELIVERED_MESSAGE_RETENTION_MS (only ended or
     *     left sessions, or a person who never opened it, still owe an acknowledgement)
     *  2) Keep any candidate that a remaining message replies to, until that reply goes as well
     *  3) Delete receipts, then messages, in one transaction
     *
     * Returns the number of messages deleted.
     */
    purgeMessages(nowMs: number = Date.now()): number {
        return runInTransaction(this.database, () => {
            // (1) Candidates
            const candidates = this.prepare(`
                SELECT M.id
                FROM message AS M
                WHERE NOT EXISTS (
                        SELECT 1
                        FROM message_receipt AS MR
                        JOIN agent AS A
                            ON A.id = MR.agent_id
                        WHERE MR.message_id = M.id
                            AND MR.received_at IS NULL
                            AND A.is_human = 0
                            AND ${ACTIVE_AGENT_CONDITION}
                    )
                    AND (
                        (
                            NOT EXISTS (
                                SELECT 1 FROM message_receipt AS MR
                                WHERE MR.message_id = M.id AND MR.received_at IS NULL
                            )
                            AND COALESCE(
                                (SELECT MAX(MR.received_at) FROM message_receipt AS MR WHERE MR.message_id = M.id),
                                M.created_at
                            ) < :resolved_before
                        )
                        OR M.created_at < :undelivered_before
                    )
            `).all({
                active_since: activeSince(nowMs),
                resolved_before: new Date(nowMs - RESOLVED_MESSAGE_GRACE_MS).toISOString(),
                undelivered_before: new Date(nowMs - UNDELIVERED_MESSAGE_RETENTION_MS).toISOString(),
            }) as { id: number }[];
            if(candidates.length == 0) {
                return 0;
            }

            // (2) Reply chains: a reply that stays keeps what it answers, repeated until nothing changes
            const deletable = new Set(candidates.map((row) => row.id));
            const replies = this.prepare(`
                SELECT id, reply_to_message_id FROM message WHERE reply_to_message_id IS NOT NULL
            `).all() as { id: number; reply_to_message_id: number }[];
            let changed = true;
            while(changed == true) {
                changed = false;
                for(const reply of replies) {
                    if(deletable.has(reply.reply_to_message_id) == true && deletable.has(reply.id) == false) {
                        deletable.delete(reply.reply_to_message_id);
                        changed = true;
                    }
                }
            }
            if(deletable.size == 0) {
                return 0;
            }

            // (3) Delete. ON DELETE RESTRICT is checked row by row, not at the end of the statement,
            // so a reply must go before what it answers: newest first, since a reply is always newer
            const ids = [...deletable].sort((left, right) => right - left);
            this.prepare(`
                DELETE FROM message_receipt WHERE message_id IN (SELECT value FROM json_each(:ids))
            `).run({ ids: JSON.stringify(ids) });
            this.prepare(`
                DELETE FROM message_topic WHERE message_id IN (SELECT value FROM json_each(:ids))
            `).run({ ids: JSON.stringify(ids) });
            const deleteMessage = this.prepare(`DELETE FROM message WHERE id = :id`);
            for(const id of ids) {
                deleteMessage.run({ id: id });
            }
            return ids.length;
        });
    }

    /**
     * Removes everything that would otherwise pile up, so the database stays the size of what is
     * still in use. Safe to call often: each step only touches rows past its retention.
     *
     * Flow:
     *  1) Messages no active agent waits on (`purgeMessages`)
     *  2) Agent cards silent past AGENT_RETENTION_MS, with their checkpoints and receipts, once no
     *     message still names them; people at the CLI are kept
     *  3) Checkpoints beyond the newest CHECKPOINT_KEEP_PER_AGENT of each agent
     *  4) Workspaces nothing refers to any more
     */
    cleanUp(nowMs: number = Date.now()): { messages: number; agents: number; checkpoints: number; workspaces: number } {
        // (1) Messages
        const messages = this.purgeMessages(nowMs);

        return runInTransaction(this.database, () => {
            // (2) Agents
            const retired = this.prepare(`
                SELECT A.id
                FROM agent AS A
                WHERE A.is_human = 0
                    AND A.last_seen_at < :retire_before
                    AND NOT EXISTS (
                        SELECT 1 FROM message AS M
                        WHERE M.sender_agent_id = A.id OR M.recipient_agent_id = A.id
                    )
            `).all({ retire_before: new Date(nowMs - AGENT_RETENTION_MS).toISOString() }) as { id: string }[];
            let checkpoints = 0;
            if(retired.length > 0) {
                const ids = JSON.stringify(retired.map((row) => row.id));
                this.prepare(`DELETE FROM message_receipt WHERE agent_id IN (SELECT value FROM json_each(:ids))`).run({ ids: ids });
                const removedCheckpoints = this.prepare(`DELETE FROM checkpoint WHERE agent_id IN (SELECT value FROM json_each(:ids))`).run({ ids: ids });
                checkpoints += Number(removedCheckpoints.changes);
                this.prepare(`DELETE FROM agent WHERE id IN (SELECT value FROM json_each(:ids))`).run({ ids: ids });
            }

            // (3) Checkpoints over the per-agent cap
            const capped = this.prepare(`
                DELETE FROM checkpoint
                WHERE id IN (
                    SELECT id FROM (
                        SELECT id, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY id DESC) AS newest_first
                        FROM checkpoint
                    )
                    WHERE newest_first > :keep
                )
            `).run({ keep: CHECKPOINT_KEEP_PER_AGENT });
            checkpoints += Number(capped.changes);

            // (4) Workspaces
            const workspaces = this.prepare(`
                DELETE FROM workspace
                WHERE NOT EXISTS (SELECT 1 FROM agent AS A WHERE A.workspace_id = workspace.id)
                    AND NOT EXISTS (SELECT 1 FROM checkpoint AS C WHERE C.workspace_id = workspace.id)
                    AND NOT EXISTS (SELECT 1 FROM message AS M WHERE M.workspace_id = workspace.id)
            `).run();

            return {
                messages: messages,
                agents: retired.length,
                checkpoints: checkpoints,
                workspaces: Number(workspaces.changes),
            };
        });
    }

    /** Marks messages received by one participant; repeating an id changes nothing. */
    acknowledge(agentId: string, messageIds: number[]): void {
        if(messageIds.length == 0) {
            return;
        }
        this.prepare(`
            UPDATE message_receipt SET received_at = :now
            WHERE agent_id = :agent_id
                AND received_at IS NULL
                AND message_id IN (SELECT value FROM json_each(:message_ids))
        `).run({ now: new Date().toISOString(), agent_id: agentId, message_ids: JSON.stringify(messageIds) });
    }

    /**
     * A person at the CLI opened a message on the board: their acknowledgement, whether the
     * message named them alone or in a group. Nothing happens when it did not name them.
     */
    acknowledgeForPerson(displayName: string, messageId: number): void {
        this.prepare(`
            UPDATE message_receipt SET received_at = :now
            WHERE message_id = :message_id
                AND received_at IS NULL
                AND agent_id IN (SELECT id FROM agent WHERE is_human = 1 AND display_name = :display_name)
        `).run({ now: new Date().toISOString(), message_id: messageId, display_name: displayName });
    }

    /**
     * Any tool call from an agent: it is alive and connected again, and the messages whose full
     * text reached it in its previous response count as received. Acknowledging on the next call
     * rather than on delivery keeps a message unread when the session died before reading it.
     */
    recordCall(agentId: string, deliveredMessageIds: number[]): void {
        runInTransaction(this.database, () => {
            this.prepare(`
                UPDATE agent SET last_seen_at = :now, disconnected_at = NULL
                WHERE id = :id AND left_at IS NULL
            `).run({ now: new Date().toISOString(), id: agentId });
            this.acknowledge(agentId, deliveredMessageIds);
        });
    }

    /** Liveness only: never creates a change event for other agents. */
    heartbeat(agentIds: string[]): void {
        if(agentIds.length == 0) {
            return;
        }
        this.prepare(`
            UPDATE agent SET last_seen_at = :now
            WHERE id IN (SELECT value FROM json_each(:agent_ids)) AND left_at IS NULL AND disconnected_at IS NULL
        `).run({ now: new Date().toISOString(), agent_ids: JSON.stringify(agentIds) });
    }

    /** Bridge shutdown: releases editing claims at once (a visible change) and marks the agents disconnected. */
    disconnect(agentIds: string[]): void {
        if(agentIds.length == 0) {
            return;
        }
        const nowText = new Date().toISOString();
        runInTransaction(this.database, () => {
            for(const agentId of agentIds) {
                const current = this.selectAgent(agentId);
                if(current == null || current.left_at != null) {
                    continue;
                }
                if(current.editing_list != "[]") {
                    this.prepare(`
                        UPDATE agent
                        SET editing_list = '[]',
                            editing_updated_at = :now,
                            revision = revision + 1,
                            changed_seq = :changed_seq
                        WHERE id = :id
                    `).run({ now: nowText, changed_seq: this.nextSeq(), id: agentId });
                }
                this.prepare(`
                    UPDATE agent SET disconnected_at = :now WHERE id = :id
                `).run({ now: nowText, id: agentId });
            }
        });
    }

    /** A person posting from the CLI; one row per (room, name), created on first use. */
    ensureHumanParticipant(room: string, displayName: string): string {
        room = SHARED_ROOM;
        return runInTransaction(this.database, () => {
            const existing = this.prepare(`
                SELECT id FROM agent WHERE room = :room AND is_human = 1 AND display_name = :display_name
            `).get({ room: room, display_name: displayName }) as { id: string } | undefined;
            if(existing != null) {
                return existing.id;
            }
            const agentId = newIdentifier("agt");
            const nowText = new Date().toISOString();
            this.prepare(`
                INSERT INTO agent (
                    id, room, handle_hash, display_name, client, is_human, status,
                    changed_seq, joined_at, updated_at, last_seen_at
                )
                VALUES (
                    :id, :room, :handle_hash, :display_name, 'human', 1, 'idle',
                    :changed_seq, :now, :now, :now
                )
            `).run({
                id: agentId,
                room: room,
                handle_hash: hashHandle(randomBytes(24).toString("base64url")),
                display_name: displayName,
                changed_seq: this.nextSeq(),
                now: nowText,
            });
            return agentId;
        });
    }

    listRooms(): string[] {
        const rows = this.prepare(`SELECT DISTINCT room FROM agent ORDER BY room`).all() as { room: string }[];
        return rows.map((row) => row.room);
    }

    /** Resolves an agent id, or a display name matched case-insensitively, within one room. */
    findAgentInRoom(room: string, idOrName: string): string {
        room = SHARED_ROOM;
        const byId = this.selectAgent(idOrName);
        if(byId != null && byId.room == room) {
            return byId.id;
        }
        let byName = this.prepare(`
            SELECT id FROM agent WHERE room = :room AND lower(display_name) = lower(:name) AND left_at IS NULL
        `).all({ room: room, name: idOrName }) as { id: string }[];
        if(byName.length > 1) {
            // a session name is reused by every new conversation; the live one is the one meant
            const nowMs = Date.now();
            const active = byName.filter((row) => isEnded(this.requireAgent(row.id), nowMs) == false);
            if(active.length > 0) {
                byName = active;
            }
        }
        if(byName.length == 1) {
            return byName[0].id;
        }
        if(byName.length > 1) {
            throw new RoomError(`several agents are named ${idOrName}; use an agent id: ${byName.map((row) => row.id).join(", ")}`);
        }
        throw new RoomError(`no agent ${idOrName} in room ${room}`);
    }

    getRoomOverview(room: string, messageLimit: number): { agents: RoomOverviewAgent[]; messages: RoomOverviewMessage[] } {
        room = SHARED_ROOM;
        const nowMs = Date.now();
        const agentRows = this.prepare(`
            SELECT ${AGENT_COLUMNS} FROM agent WHERE room = :room ORDER BY left_at IS NOT NULL, joined_at
        `).all({ room: room }) as unknown as AgentRow[];
        const agents = agentRows.map((row) => {
            let workspacePath: string | null = null;
            if(row.workspace_id != null) {
                const workspaceRow = this.prepare(`
                    SELECT display_path FROM workspace WHERE id = :id
                `).get({ id: row.workspace_id }) as { display_path: string };
                workspacePath = workspaceRow.display_path;
            }
            return {
                agent_id: row.id,
                name: row.display_name,
                client: row.client,
                human: row.is_human == 1,
                status: row.status,
                task: row.task,
                next_step: row.next_step,
                blocker: row.blocker,
                editing: parseList(row.editing_list),
                workspace_path: workspacePath,
                updated_at: row.updated_at,
                online: isOnline(row, nowMs),
                stale: isStale(row, nowMs),
                left: row.left_at != null,
                ended: isEnded(row, nowMs),
                pending_count: this.countPending(row.id),
            };
        });

        const messageRows = this.prepare(`
            SELECT
                M.id,
                M.created_at,
                S.display_name AS from_name,
                S.client AS from_client,
                S.is_human AS from_is_human,
                R.display_name AS to_name,
                R.client AS to_client,
                M.recipient_agent_id,
                M.recipient_scope,
                R.is_human AS to_is_human,
                M.kind,
                M.reply_to_message_id,
                M.body,
                ${MESSAGE_TOPICS_COLUMN},
                -- Keep identity and client together, even when two clients use the same name.
                (
                    SELECT json_group_array(json_object('name', G.display_name, 'client', G.client, 'human', G.is_human) ORDER BY G.display_name)
                    FROM message_receipt AS GR
                    JOIN agent AS G
                        ON G.id = GR.agent_id
                    WHERE GR.message_id = M.id
                ) AS group_participants,
                -- active recipients who have not acknowledged it yet, including their clients
                (
                    SELECT json_group_array(json_object('name', A.display_name, 'client', A.client, 'human', A.is_human))
                    FROM message_receipt AS MR
                    JOIN agent AS A
                        ON A.id = MR.agent_id
                    WHERE MR.message_id = M.id
                        AND MR.received_at IS NULL
                        AND ${ACTIVE_AGENT_CONDITION}
                ) AS waiting_on
            FROM message AS M
            JOIN agent AS S
                ON S.id = M.sender_agent_id
            LEFT JOIN agent AS R
                ON R.id = M.recipient_agent_id
            WHERE M.room = :room
            ORDER BY M.seq DESC
            LIMIT :limit
        `).all({ room: room, limit: messageLimit, active_since: activeSince(nowMs) }) as {
            id: number;
            created_at: string;
            from_name: string;
            from_client: string;
            from_is_human: number;
            to_name: string | null;
            to_client: string | null;
            recipient_agent_id: string | null;
            recipient_scope: "direct" | "group" | "all";
            to_is_human: number | null;
            kind: MessageKind;
            reply_to_message_id: number | null;
            body: string;
            topics: string;
            group_participants: string;
            waiting_on: string;
        }[];
        const participants = (json: string): RoomOverviewParticipant[] => {
            const rows = JSON.parse(json) as { name: string; client: string; human: number }[];
            return rows.map((row) => ({ ...row, human: row.human == 1 }));
        };
        const messages = messageRows.reverse().map((row) => {
            const waitingOn = participants(row.waiting_on);
            let recipients: RoomOverviewParticipant[] = [];
            let toName = row.to_name;
            if(row.recipient_scope == "group") {
                recipients = participants(row.group_participants);
                toName = recipients.map((recipient) => recipient.name).join(", ");
            }
            else if(row.recipient_scope == "direct" && row.to_name != null && row.to_client != null) {
                recipients = [{ name: row.to_name, client: row.to_client, human: row.to_is_human == 1 }];
            }
            return {
                id: row.id,
                at: row.created_at,
                from_name: row.from_name,
                from_client: row.from_client,
                from_human: row.from_is_human == 1,
                to_name: toName,
                recipients,
                to_agent_id: row.recipient_agent_id,
                to_human: row.to_is_human == 1,
                kind: row.kind,
                reply_to: row.reply_to_message_id,
                text: row.body,
                topics: parseList(row.topics),
                resolved: waitingOn.length == 0,
                waiting_on: waitingOn.map((participant) => participant.name),
                waiting_on_participants: waitingOn,
            };
        });
        return { agents: agents, messages: messages };
    }
}

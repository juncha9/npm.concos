import {
    AGENT_STATUSES,
    HEARTBEAT_INTERVAL_MS,
    INSPECT_CHECKPOINT_MAX_LIMIT,
    MAX_BLOCKER_LENGTH,
    MAX_CHECKPOINT_LENGTH,
    MAX_CLIENT_LENGTH,
    MAX_DISPLAY_NAME_LENGTH,
    MAX_LIST_ITEM_LENGTH,
    MAX_LIST_ITEMS,
    MAX_MESSAGE_LENGTH,
    MAX_NEXT_STEP_LENGTH,
    MAX_PATH_LENGTH,
    MAX_RECEIVED_IDS,
    MAX_RECIPIENTS,
    MAX_REQUEST_ID_LENGTH,
    MAX_ROLE_LENGTH,
    MAX_SUMMARY_LENGTH,
    MAX_TASK_LENGTH,
    MAX_TOPICS_PER_MESSAGE,
    MESSAGE_KINDS,
    POSTS_PER_AGENT,
    READ_MESSAGES_MAX_LIMIT,
    RECIPIENT_ALL,
} from "../../_defs";
import type { AgentStatus, MessageKind } from "../../_defs";
import { $logger } from "../../_libs/logger";
import { resolveDataDirectory } from "../../_libs/paths";
import { CONCOS_VERSION } from "../../_libs/version";
import { HOST_ADAPTERS } from "../hooks/adapters";
import { describeWake } from "../hooks/notices";
import { openDatabase } from "../store/database";
import { RoomError } from "../store/room-error";
import { RoomStore } from "../store/room-store";
import type { CheckInResult, FullMessage } from "../store/room-store";
import { serveStdio } from "./stdio-server";
import type { ToolDefinition, ToolResult } from "./stdio-server";
import { inputSchema } from "./tool-schema";
import type { ValueSchema } from "./tool-schema";

const SHUTDOWN_DEADLINE_MS = 3000;
/** Hosts whose sessions can be woken from outside (Codex): an MCP server wakes them when no watch did. */
const WAKE_HOSTS = HOST_ADAPTERS.filter((adapter) => adapter.deliverWake != null);

/**
 * check_in's answer split in two: what the call did to the caller's own card, and the room's
 * news since its cursor. Agents found one flat object hard to read when they only meant to
 * update themselves. Unread counts travel in the `inbox` field every tool adds.
 */
function shapeCheckIn(result: CheckInResult): { you: { revision: number }; room: Omit<CheckInResult, "revision" | "pending_count"> } {
    const room: Omit<CheckInResult, "revision" | "pending_count"> = { changed: result.changed, cursor: result.cursor };
    if(result.agents != null) {
        room.agents = result.agents;
    }
    if(result.messages != null) {
        room.messages = result.messages;
    }
    if(result.read_in_full != null) {
        room.read_in_full = result.read_in_full;
    }
    if(result.has_more != null) {
        room.has_more = result.has_more;
    }
    return { you: { revision: result.revision }, room: room };
}

/** Messages whose whole text is in a tool result: check_in previews that were not cut, and every read_messages message. */
function fullyDeliveredMessageIds(toolName: string, result: unknown): number[] {
    if(toolName == "check_in") {
        const messages = (result as ReturnType<typeof shapeCheckIn>).room.messages ?? [];
        return messages.filter((message) => message.truncated != true).map((message) => message.id);
    }
    if(toolName == "read_messages") {
        return (result as { messages: FullMessage[] }).messages.map((message) => message.id);
    }
    return [];
}

const SERVER_INSTRUCTIONS = [
    "concos is one shared local waiting room for this user. Agents across projects leave their status and messages here; the folder each session started in identifies its project.",
    "Call join once when you start a task, passing the absolute folder this session started in and, as display_name, this session's name exactly as the user set it (not a role). Keep the handle for resume_handle after a restart; use a supplied resume_handle when available. When you work in another folder, report it with check_in current_directory; your card stays with the project you started in.",
    "Call check_in at task boundaries: when starting, after a meaningful step, when blocked, before waiting, and when asked about other agents. Messages reach you only through concos calls, so in long work check_in after each finished step as well. When the user gives you a role, report it in role, not task. Send only changed fields. Report status=working and editing claims while working; before yielding, report status=waiting and editing=[].",
    "Answer messages with kind question. Use read_messages for the full text of a truncated message, and inspect_agent for another agent's detailed context.",
    "A message to all is a post on your board in the room: others read it for reference and nobody is waited on. Post only what every agent needs to know, such as a change to a shared server or database; rewrite that post with edit when it changes, and take it down with remove_posts once it no longer applies. Send progress and results to the agents concerned, by agent_id or a list. Start a message with its content: the room already shows its sender and recipients.",
    "Tag messages about one issue with snake_case topics, broad to narrow (webapp_login_redirect), so they group together; reuse a topic from similar_topics when it fits.",
    "Messages are short-lived: one is deleted an hour after it was read, and within a day in any case. When an exchange settles a design, a decision, a contract or a plan, write it into the project's docs (the file that owns it) before you answer, and cite that path in the thread; durable project knowledge never lives only in messages.",
    "Call leave when your task is done. Do not call check_in on a timer.",
    "An inbox field on any response counts unread questions and other messages. A message whose full text reached you counts as received on your next call; use read_messages for truncated or unread ones.",
].join("\n");

const HANDLE_PROPERTY: ValueSchema = { type: "string", description: "Handle from join. Omit to use the last one joined in this session." };

/** Carried by an agent's first answer in a session: the thread goes, so what it settled belongs in the docs. */
const RECORD_IN_DOCS = "This thread is deleted within a day. If your answer settles a design, a decision, a contract or a plan, write it into the project's docs (the file that owns it) and cite that path in the thread.";
const ANY_INTEGER = { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER } as const;
const POSITIVE_INTEGER = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;

/**
 * Serves the MCP tools over stdio until the client goes away.
 * The bridge opens the shared SQLite file directly; there is no shared server process.
 */
export async function runBridge(): Promise<void> {
    let _logger = $logger.child({ context: "bridge", pid: process.pid });
    const dataDirectory = resolveDataDirectory();
    _logger = _logger.child({ data_directory: dataDirectory });
    const database = await openDatabase(dataDirectory);
    const store = new RoomStore(database);

    let lastHandle: string | null = null;
    let toolAgentId: string | null = null;
    const joinedAgentIds = new Set<string>();
    /** Agents whose first answer through this bridge already carried `record_in_docs`. */
    const agentsToldToRecord = new Set<string>();

    const resolveAgentId = (handle: string | undefined): string => {
        const effectiveHandle = handle ?? lastHandle;
        if(effectiveHandle == null) {
            throw new RoomError("call join first");
        }
        const agentId = store.requireAgentIdByHandle(effectiveHandle);
        toolAgentId = agentId;
        joinedAgentIds.add(agentId);
        store.recordCall(agentId);
        return agentId;
    };

    const runTool = (toolName: string, work: () => unknown): ToolResult => {
        toolAgentId = null;
        try {
            const result = work();
            // whole texts in this result count as received at the agent's next call or turn end
            const delivered = fullyDeliveredMessageIds(toolName, result);
            if(toolAgentId != null) {
                store.markDelivered(toolAgentId, delivered);
            }
            const inbox = toolAgentId == null ? undefined : store.getInbox(toolAgentId, delivered);
            return { content: [{ type: "text", text: JSON.stringify(inbox == null ? result : { ...result as object, inbox }) }] };
        }
        catch(ex) {
            if(ex instanceof RoomError) {
                const inbox = toolAgentId == null ? undefined : store.getInbox(toolAgentId);
                return { content: [{ type: "text", text: inbox == null ? ex.message : JSON.stringify({ error: ex.message, inbox }) }], isError: true };
            }
            _logger.error(ex, `tool ${toolName} failed`);
            return { content: [{ type: "text", text: "concos internal error; see the concos log on stderr" }], isError: true };
        }
    };

    const tools: ToolDefinition[] = [];
    const runners = new Map<string, (values: Record<string, unknown>) => ToolResult>();
    const registerTool = (definition: ToolDefinition, run: (values: Record<string, unknown>) => ToolResult): void => {
        tools.push(definition);
        runners.set(definition.name, run);
    };

    registerTool({
        name: "join",
        description: "Join a room. Returns agent_id and handle; keep the handle for later calls and for resume_handle after a restart. merged_from, when present, is the card your session-start hook made: your earlier card of this name took it over, so use the agent_id returned.",
        inputSchema: inputSchema({
            display_name: { type: "string", minLength: 1, maxLength: MAX_DISPLAY_NAME_LENGTH, description: "This session's name as the user set it, verbatim (e.g. \"Dev / API 01\"). Not a role; put the role in check_in role. Rename later with check_in display_name." },
            client: { type: "string", minLength: 1, maxLength: MAX_CLIENT_LENGTH, description: "Your product, e.g. Claude Code, Codex." },
            working_directory: { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH, description: "Absolute path of the folder this session started in. It keeps your card with its project; joining again from another folder records that folder as current_directory." },
            workspace_root: { type: "string", maxLength: MAX_PATH_LENGTH, description: "Absolute project root when it differs from working_directory. With resume_handle, a root holding the folder your session started in moves your card to that project." },
            resume_handle: { type: "string", description: "Handle from an earlier join, to come back as the same agent." },
        }, ["display_name", "client", "working_directory"]),
    }, (values) => runTool("join", () => {
        const args = values as { display_name: string; client: string; working_directory: string; workspace_root?: string; resume_handle?: string };
        const result = store.join({
            displayName: args.display_name,
            client: args.client,
            workingDirectory: args.working_directory,
            workspaceRoot: args.workspace_root ?? null,
            resumeHandle: args.resume_handle ?? null,
            concosVersion: CONCOS_VERSION,
        });
        lastHandle = result.handle;
        toolAgentId = result.agent_id;
        joinedAgentIds.add(result.agent_id);
        return result;
    }));

    registerTool({
        name: "check_in",
        description: "Report your status and editing claims. The answer has `you` (your card's revision) and `room` (other agents' changes, messages to you, and new or edited posts since your last check_in). Empty strings clear a field; editing replaces the list. Before yielding, set status waiting and editing []. When room.has_more is set, call check_in again without cursor for the rest. A card with replaced_by belongs to a session that ended; messages to it reach that agent_id.",
        inputSchema: inputSchema({
            handle: HANDLE_PROPERTY,
            display_name: { type: "string", maxLength: MAX_DISPLAY_NAME_LENGTH, description: "Rename your card, e.g. after the user renamed this session; no new join needed." },
            status: { type: "string", enum: AGENT_STATUSES },
            role: { type: "string", maxLength: MAX_ROLE_LENGTH, description: "Your standing role as the user gave it, e.g. owner of the app-api service. Unlike task, what you are doing now, it stays until changed." },
            task: { type: "string", maxLength: MAX_TASK_LENGTH },
            summary: { type: "string", maxLength: MAX_SUMMARY_LENGTH, description: "What is done so far and where things stand." },
            next_step: { type: "string", maxLength: MAX_NEXT_STEP_LENGTH },
            blocker: { type: "string", maxLength: MAX_BLOCKER_LENGTH },
            references: { type: "array", items: { type: "string", maxLength: MAX_LIST_ITEM_LENGTH }, maxItems: MAX_LIST_ITEMS, description: `Relevant files, commits or docs; up to ${MAX_LIST_ITEMS}.` },
            editing: { type: "array", items: { type: "string", maxLength: MAX_LIST_ITEM_LENGTH }, maxItems: MAX_LIST_ITEMS, description: `Files or folders you are editing now, up to ${MAX_LIST_ITEMS}; [] when done.` },
            checkpoint: { type: "string", maxLength: MAX_CHECKPOINT_LENGTH, description: "A short work record worth keeping: result, decision, what remains." },
            current_directory: { type: "string", maxLength: MAX_PATH_LENGTH, description: "Absolute folder you work in now, when it is not the one this session started in; \"\" when you are back. Your card stays in its project." },
            received_message_ids: { type: "array", items: ANY_INTEGER, maxItems: MAX_RECEIVED_IDS, description: `Optional, up to ${MAX_RECEIVED_IDS}: messages you read. Full-text deliveries are acknowledged on your next call anyway.` },
            expected_revision: { ...ANY_INTEGER, description: "Reject the update if your card moved past this revision." },
            cursor: { type: "string", description: "Omit to continue from the last delivered position; repeat a previous cursor to receive again." },
        }),
    }, (values) => runTool("check_in", () => {
        const args = values as {
            handle?: string; display_name?: string; status?: AgentStatus; role?: string; task?: string; summary?: string; next_step?: string; blocker?: string;
            references?: string[]; editing?: string[]; checkpoint?: string; current_directory?: string; received_message_ids?: number[]; expected_revision?: number; cursor?: string;
        };
        const agentId = resolveAgentId(args.handle);
        const result = store.checkIn(agentId, {
            cursor: args.cursor ?? null,
            expectedRevision: args.expected_revision ?? null,
            update: {
                displayName: args.display_name,
                status: args.status,
                role: args.role,
                task: args.task,
                summary: args.summary,
                nextStep: args.next_step,
                blocker: args.blocker,
                references: args.references,
                editing: args.editing,
                currentDirectory: args.current_directory,
            },
            checkpoint: args.checkpoint ?? null,
            receivedMessageIds: args.received_message_ids ?? [],
        });
        return shapeCheckIn(result);
    }));

    registerTool({
        name: "inspect_agent",
        description: "Read another agent's full card and recent checkpoints.",
        inputSchema: inputSchema({
            handle: HANDLE_PROPERTY,
            agent_id: { type: "string", minLength: 1 },
            checkpoint_limit: { ...POSITIVE_INTEGER, description: `Checkpoints to return, at most ${INSPECT_CHECKPOINT_MAX_LIMIT}; a larger value returns ${INSPECT_CHECKPOINT_MAX_LIMIT}.` },
            before_checkpoint_id: { ...ANY_INTEGER, description: "Page to older checkpoints." },
        }, ["agent_id"]),
    }, (values) => runTool("inspect_agent", () => {
        const args = values as { handle?: string; agent_id: string; checkpoint_limit?: number; before_checkpoint_id?: number };
        const agentId = resolveAgentId(args.handle);
        let checkpointLimit: number | null = null;
        if(args.checkpoint_limit != null) {
            checkpointLimit = Math.min(args.checkpoint_limit, INSPECT_CHECKPOINT_MAX_LIMIT);
        }
        return store.inspectAgent(agentId, {
            agentId: args.agent_id,
            checkpointLimit: checkpointLimit,
            beforeCheckpointId: args.before_checkpoint_id ?? null,
        });
    }));

    registerTool({
        name: "send_message",
        description: `Leave a message for one agent or several, or post one to the whole room. Success means stored, not read. A post to all is there for reference: nobody receives it or is waited on, the room keeps your newest ${POSTS_PER_AGENT}, edit rewrites one when it changes, and remove_posts takes it down. Send to the agents concerned unless everyone needs it. Messages are deleted within a day: write what an exchange settles into the project's docs and cite the path.`,
        inputSchema: inputSchema({
            handle: HANDLE_PROPERTY,
            to: {
                anyOf: [
                    { type: "string", minLength: 1 },
                    { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: MAX_RECIPIENTS },
                ],
                description: `An agent_id, a list of up to ${MAX_RECIPIENTS} agent_ids, or "all" to post news every agent needs.`,
            },
            kind: { type: "string", enum: MESSAGE_KINDS, description: "Default note. Use question when you need an answer, reply with reply_to." },
            text: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_LENGTH },
            topics: { type: "array", items: { type: "string" }, maxItems: MAX_TOPICS_PER_MESSAGE, description: `Up to ${MAX_TOPICS_PER_MESSAGE} snake_case topic keys, broad to narrow, e.g. webapp_login_redirect. Reuse one from similar_topics when it fits.` },
            reply_to: ANY_INTEGER,
            edit: { ...POSITIVE_INTEGER, description: "Id of one of your posts to all: rewrite it with this text, and kind and topics when given, instead of posting anew. to stays \"all\"." },
            request_id: { type: "string", maxLength: MAX_REQUEST_ID_LENGTH, description: "Reuse on retry to avoid storing the message twice." },
        }, ["to", "text"]),
    }, (values) => runTool("send_message", () => {
        const args = values as { handle?: string; to: string | string[]; kind?: MessageKind; text: string; topics?: string[]; reply_to?: number; edit?: number; request_id?: string };
        const agentId = resolveAgentId(args.handle);
        if(args.edit != null) {
            if(args.to !== RECIPIENT_ALL) {
                throw new RoomError("edit rewrites a post to all; set to \"all\"");
            }
            if(args.reply_to != null) {
                throw new RoomError("edit keeps the post's reply_to; leave reply_to out");
            }
            return store.editPost(agentId, { messageId: args.edit, text: args.text, kind: args.kind, topics: args.topics });
        }
        const sent = store.sendMessage(agentId, {
            to: args.to,
            kind: args.kind ?? "note",
            text: args.text,
            replyTo: args.reply_to ?? null,
            requestId: args.request_id ?? null,
            topics: args.topics ?? [],
        });
        // An answer is where a design question gets settled between agents, and the thread is gone
        // within a day; the first answer an agent sends through this bridge says where the outcome
        // belongs (2026-10-26 report: agents settled designs in messages and left the docs behind)
        if(args.kind == "reply" && agentsToldToRecord.has(agentId) == false) {
            agentsToldToRecord.add(agentId);
            return { ...sent, record_in_docs: RECORD_IN_DOCS };
        }
        return sent;
    }));

    registerTool({
        name: "read_messages",
        description: "Read full message text: the ids given, the newest under a topic, or by default your messages not yet received. Returned messages count as received on your next call; ids that cannot be shown come back under unavailable, with why.",
        inputSchema: inputSchema({
            handle: HANDLE_PROPERTY,
            message_ids: { type: "array", items: ANY_INTEGER, maxItems: MAX_RECEIVED_IDS, description: `Up to ${MAX_RECEIVED_IDS} ids; at most ${READ_MESSAGES_MAX_LIMIT} messages come back per call, with has_more.` },
            topic: { type: "string", description: "A topic key or its leading words, e.g. webapp: your messages and posts to the room under it and narrower topics." },
            limit: { ...POSITIVE_INTEGER, description: `Messages per call, at most ${READ_MESSAGES_MAX_LIMIT}; a larger value returns ${READ_MESSAGES_MAX_LIMIT} with has_more.` },
        }),
    }, (values) => runTool("read_messages", () => {
        const args = values as { handle?: string; message_ids?: number[]; topic?: string; limit?: number };
        const agentId = resolveAgentId(args.handle);
        // a limit over the maximum is read as "as many as allowed", not as a mistake to reject
        let limit: number | null = null;
        if(args.limit != null) {
            limit = Math.min(args.limit, READ_MESSAGES_MAX_LIMIT);
        }
        return store.readMessages(agentId, { messageIds: args.message_ids ?? null, limit: limit, topic: args.topic ?? null });
    }));

    registerTool({
        name: "remove_posts",
        description: "Take your own posts to all off the room once they no longer apply. To tell agents that something changed, edit the post instead.",
        inputSchema: inputSchema({
            handle: HANDLE_PROPERTY,
            message_ids: { type: "array", items: ANY_INTEGER, minItems: 1, maxItems: MAX_RECEIVED_IDS, description: "Ids of your posts to all; all are removed, or none when one is not yours." },
        }, ["message_ids"]),
    }, (values) => runTool("remove_posts", () => {
        const args = values as { handle?: string; message_ids: number[] };
        const agentId = resolveAgentId(args.handle);
        return store.removePosts(agentId, args.message_ids);
    }));

    registerTool({
        name: "leave",
        description: "Finish your participation, leaving a final summary. Clears your editing list.",
        inputSchema: inputSchema({
            handle: HANDLE_PROPERTY,
            summary: { type: "string", maxLength: MAX_SUMMARY_LENGTH },
            next_step: { type: "string", maxLength: MAX_NEXT_STEP_LENGTH, description: "What whoever continues should do next." },
            checkpoint: { type: "string", maxLength: MAX_CHECKPOINT_LENGTH },
        }),
    }, (values) => runTool("leave", () => {
        const args = values as { handle?: string; summary?: string; next_step?: string; checkpoint?: string };
        const agentId = resolveAgentId(args.handle);
        return store.leave(agentId, {
            summary: args.summary ?? null,
            nextStep: args.next_step ?? null,
            checkpoint: args.checkpoint ?? null,
        });
    }));

    const heartbeatTimer = setInterval(() => {
        try {
            // the version shows on the board, so a session still on an older concos can be found
            store.heartbeat([...joinedAgentIds], CONCOS_VERSION);
            // every running bridge sweeps on its heartbeat, so residue is cleared while anyone is connected
            const removed = store.cleanUp();
            if(removed.messages + removed.agents + removed.checkpoints + removed.workspaces > 0) {
                _logger.debug(`cleaned up ${JSON.stringify(removed)}`);
            }
        }
        catch(ex) {
            _logger.error(ex, "heartbeat or clean-up failed");
        }
        // a turn that fails ends without the Stop hook, so no watch wakes the session; its MCP
        // server, still running, wakes it once a message has waited too long (2026-10-27)
        for(const agentId of joinedAgentIds) {
            try {
                const wake = store.fallbackWake(agentId, WAKE_HOSTS.map((adapter) => adapter.id));
                if(wake == null) {
                    continue;
                }
                const adapter = WAKE_HOSTS.find((item) => item.id == wake.host);
                adapter?.deliverWake?.(wake.sessionId, describeWake(wake.notices, wake.unread)).catch((ex) => {
                    _logger.error(ex, "fallback wake was not delivered");
                });
            }
            catch(ex) {
                _logger.error(ex, "fallback wake check failed");
            }
        }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();

    let shuttingDown = false;
    const shutdown = (reason: string): void => {
        if(shuttingDown == true) {
            return;
        }
        shuttingDown = true;
        // exits even if closing hangs; the timer must not itself keep the process alive
        setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();
        _logger.info(`shutting down: ${reason}`);
        clearInterval(heartbeatTimer);
        try {
            store.disconnect([...joinedAgentIds]);
            database.close();
        }
        catch(ex) {
            _logger.error(ex, "shutdown cleanup failed");
        }
        process.exit(0);
    };
    // stdin ending is the one exit signal every client sends, by dying if not deliberately
    process.stdin.on("end", () => shutdown("stdin ended"));
    process.stdin.on("close", () => shutdown("stdin closed"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    serveStdio({
        name: "concos",
        version: CONCOS_VERSION,
        instructions: SERVER_INSTRUCTIONS,
        tools: tools,
        callTool: (name, values) => {
            const run = runners.get(name);
            if(run == null) {
                throw new Error(`tool ${name} is listed without a runner`);
            }
            return run(values);
        },
        logger: _logger,
    });
    _logger.info(`concos ${CONCOS_VERSION} bridge ready`);
}

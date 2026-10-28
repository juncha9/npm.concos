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
import { compareVersions, CONCOS_VERSION } from "../../_libs/version";
import { clientPidFromEnvironment, HOST_ADAPTERS } from "../hooks/adapters";
import { describeWake } from "../hooks/notices";
import { isRunning } from "../hooks/watch";
import { openDatabase } from "../store/database";
import { RoomError } from "../store/room-error";
import { RoomStore } from "../store/room-store";
import type { CheckInResult, FullMessage } from "../store/room-store";
import { InstalledVersion, loadTakeover, readHandoff } from "./handoff";
import { InstructionsUpdate } from "./instructions-update";
import type { HandoffState, TakeoverInput } from "./handoff";
import { serveStdio } from "./stdio-server";
import type { StdioServer, ToolDefinition, ToolResult } from "./stdio-server";
import { inputSchema } from "./tool-schema";
import type { ValueSchema } from "./tool-schema";

const SHUTDOWN_DEADLINE_MS = 3000;
/** Hosts whose sessions can be woken from outside (Codex): any MCP server wakes them when no watch did. */
const WAKE_HOSTS = HOST_ADAPTERS.filter((adapter) => adapter.deliverWake != null);

/**
 * check_in's answer split in two: what the call did to the caller's own card, and the room's
 * news since its cursor. Agents found one flat object hard to read when they only meant to
 * update themselves. Unread counts travel in the `inbox` field every tool adds.
 */
function shapeCheckIn(result: CheckInResult): { you: { revision: number; blocker?: string }; room: Omit<CheckInResult, "revision" | "pending_count" | "blocker"> } {
    const room: Omit<CheckInResult, "revision" | "pending_count" | "blocker"> = { changed: result.changed, cursor: result.cursor };
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
    const you: { revision: number; blocker?: string } = { revision: result.revision };
    if(result.blocker != null) {
        you.blocker = result.blocker;
    }
    return { you: you, room: room };
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
    "concos is one local room shared across projects. Your card stays in the workspace where this session started.",
    "Join at task start with the absolute starting folder and exact session name; resume a supplied handle. Use role for your standing assignment, task for current work, and current_directory when working elsewhere.",
    "Call check_in after meaningful progress, when blocked, and when context is needed; send changed fields only. Keep summary and next_step current. Do not poll on a timer. If join says hooks_manage_status_and_editing, skip calls solely to mark waiting; otherwise report working/editing and, before yielding, waiting with editing=[].",
    "Use read_messages for unread or truncated messages and inspect_agent for card details. Full texts count as received on your next call; inbox counts unread messages. has_more is available history, not an obligation to drain the room; fetch unread direct messages through read_messages.",
    "Use question for requests needing answers; answer requests with reply and reply_to, including requests received as note. Send only requested results, substantive questions, blockers, or corrections. A message can wake a waiting agent, which then rereads its whole conversation: never send receipt confirmations, 'starting' or progress notes (your card shows progress), thanks, or restatements, and send what needs no action now with wake false.",
    "Send to concerned agents. to=all posts are for room-wide news, wake nobody, and wait on nobody; edit changed posts and remove obsolete ones. Reuse relevant snake_case topics. Start with the content, not your name.",
    "Messages expire within 48 hours; read ones can expire after an hour. Record settled decisions, contracts, and plans in their owning project docs and cite the path. Call leave when your task is done.",
].join("\n");

const HANDLE_PROPERTY: ValueSchema = { type: "string", description: "Handle from join. Omit to use the last one joined in this session." };

/** Carried by an agent's first answer in a session: the thread goes, so what it settled belongs in the docs. */
const RECORD_IN_DOCS = "This thread is deleted within 48 hours. If your answer settles a design, a decision, a contract or a plan, write it into the project's docs (the file that owns it) and cite that path in the thread.";
const ANY_INTEGER = { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER } as const;
const POSITIVE_INTEGER = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;

/**
 * Serves the MCP tools over stdio until the client goes away.
 * The bridge opens the shared SQLite file directly; there is no shared server process.
 * `takeover`: an older bridge loaded this code into its own process to hand its client over.
 */
export async function runBridge(options: { takeover?: TakeoverInput } = {}): Promise<void> {
    let _logger = $logger.child({ context: "bridge", pid: process.pid });
    const dataDirectory = resolveDataDirectory();
    _logger = _logger.child({ data_directory: dataDirectory });
    const database = await openDatabase(dataDirectory);
    const store = new RoomStore(database);

    // an older bridge that loaded this code, or (before 0.1.19) started this process, carries its state
    const takeover = options.takeover;
    const handoff = takeover?.state ?? readHandoff();
    // A client reads the instructions once, at its initialize; after a hand-over that went to an
    // older bridge, and only bridges from 0.1.19 on say what they were. Changed or unknown ones go
    // with the next tool result, once (2026-10-29 user decision; the class is X:CONCOS02's).
    let seenInstructions: string | null = SERVER_INSTRUCTIONS;
    if(handoff != null) {
        seenInstructions = handoff.clientInstructions ?? null;
    }
    const instructionsUpdate = new InstructionsUpdate({
        current: SERVER_INSTRUCTIONS, version: CONCOS_VERSION, seen: seenInstructions, fromVersion: handoff?.fromVersion ?? null,
    });
    let lastHandle: string | null = handoff?.lastHandle ?? null;
    let toolAgentId: string | null = null;
    const joinedAgentIds = new Set<string>(handoff?.joinedAgentIds ?? []);
    /** Agents whose first answer through this bridge already carried `record_in_docs`. */
    const agentsToldToRecord = new Set<string>(handoff?.toldToRecord ?? []);

    const resolveAgentId = (handle: string | undefined): string => {
        const effectiveHandle = handle ?? lastHandle;
        if(effectiveHandle == null) {
            // a server the client restarted, or one whose session lost its start context, knows no one yet
            throw new RoomError("call join first: this concos server has no join yet, as after a restart. Join with the resume_handle your session was given to keep your card, or pass handle");
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
            let answer = inbox == null ? result : { ...result as object, inbox };
            const updated = instructionsUpdate.take();
            if(updated != null) {
                answer = { ...answer as object, concos_updated: updated };
            }
            return { content: [{ type: "text", text: JSON.stringify(answer) }] };
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
        description: "Join a room; keep its handle for later calls and resume_handle. Rejoining restores full cards from the start of the room view, including after context loss. hooks_manage_status_and_editing appears only on hook-bound cards. merged_from identifies a hook card merged into the returned agent_id; use that agent_id.",
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
        description: "Report changed fields; receive you (your revision; your blocker while set: send blocker \"\" once it is resolved) and room changes. Empty strings clear fields; editing replaces the list. status finished clears the blocker. Cards with detail=status update only the included fields; keep prior content. Other cards replace the prior card. room.has_more is optional history; read unread messages with read_messages. A nonempty replaced_by redirects messages from an ended card to that agent_id.",
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
            cursor: { type: "string", description: "Omit to continue from the last delivered position; set a previous cursor to replay with full cards." },
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
        description: `Leave a message for one agent or several, or post one to the whole room. Success means stored, not read. A post to all is there for reference: nobody receives it or is waited on, the room keeps your newest ${POSTS_PER_AGENT}, edit rewrites one when it changes, and remove_posts takes it down. Send to the agents concerned unless everyone needs it. Messages are deleted within 48 hours: write what an exchange settles into the project's docs and cite the path.`,
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
            wake: { type: "boolean", description: "Default true: a waiting recipient is woken for a note or reply. false when they need not act now (an outcome nobody waits on): it waits for their next turn. A question always wakes." },
        }, ["to", "text"]),
    }, (values) => runTool("send_message", () => {
        const args = values as { handle?: string; to: string | string[]; kind?: MessageKind; text: string; topics?: string[]; reply_to?: number; edit?: number; request_id?: string; wake?: boolean };
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
            wake: args.wake,
        });
        // An answer is where a design question gets settled between agents, and the thread is gone
        // within 48 hours; the first answer an agent sends through this bridge says where the outcome
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
        description: "Finish your task, leaving a final summary. Clears your editing list and blocker. A card your session's hooks hold stays in the room as finished until the session ends (left: false), so later messages still reach you; any other card leaves.",
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

    // the client this server runs under: the id it names in the environment, else the parent
    let clientPid = handoff?.clientPid ?? process.ppid;
    for(const adapter of HOST_ADAPTERS) {
        const named = clientPidFromEnvironment(adapter);
        if(named != null) {
            clientPid = named;
            break;
        }
    }

    // A newer concos installed under this running bridge takes its client over, so agents run the
    // installed version without their sessions restarting (2026-10-28 user request). From 0.1.19 it
    // is loaded into this process rather than started as another (2026-10-29 user decision).
    const installed = new InstalledVersion(process.argv[1]);
    let server: StdioServer | null = null;
    let takingOver = false;
    /** Newer code answers the client in this process now; this bridge does nothing more. */
    let retired = false;
    // the version this bridge was handed, and one that failed to take over: neither is tried again
    const skippedVersions = new Set<string>(handoff == null ? [] : [handoff.version]);
    let shuttingDown = false;
    // process listeners, named so a bridge handing over can take them off
    const onStdinEnd = (): void => shutdown("stdin ended");
    const onStdinClose = (): void => shutdown("stdin closed");
    const onInterrupt = (): void => shutdown("SIGINT");
    const onTerminate = (): void => shutdown("SIGTERM");
    /**
     * Flow:
     *  1) Hold the client's lines; load the installed version's takeover entry into this process
     *  2) The newer bridge gets ready, then asks this one to let go: stdin, timers, process
     *     listeners, the held lines and an unfinished line all pass to it at once
     *  3) Done: this bridge closes its database and retires. Failed before letting go: it answers
     *     the held lines itself and goes on. Failed after: neither can answer, so the process ends
     */
    const maybeTakeOver = (): void => {
        if(server == null || takingOver == true || retired == true || shuttingDown == true) {
            return;
        }
        const version = installed.read();
        const initializeParams = server.initializeParams();
        if(version == null || initializeParams == null || skippedVersions.has(version) == true || compareVersions(version, CONCOS_VERSION) <= 0) {
            return;
        }
        // (1) Hold and load
        takingOver = true;
        const current = server;
        const held: string[] = [];
        current.handOver((line) => held.push(line));
        let released = false;
        const state: HandoffState = {
            lastHandle, joinedAgentIds: [...joinedAgentIds], toldToRecord: [...agentsToldToRecord], clientPid, version,
            fromVersion: CONCOS_VERSION, clientInstructions: instructionsUpdate.seen(),
        };
        loadTakeover(process.argv[1], version).then((takeOver) => takeOver({
            protocol: 1,
            state: state,
            initializeParams: initializeParams,
            // (2) Let go
            release: () => {
                released = true;
                clearInterval(heartbeatTimer);
                process.stdin.off("end", onStdinEnd);
                process.stdin.off("close", onStdinClose);
                process.off("SIGINT", onInterrupt);
                process.off("SIGTERM", onTerminate);
                return { held: held.splice(0), partial: current.release() };
            },
        })).then(() => {
            // newer code that returned without taking the client would leave its lines held for good
            if(released == false) {
                throw new Error("it returned without taking the client");
            }
            // (3) Retire
            retired = true;
            try {
                database.close();
            }
            catch(ex) {
                _logger.error(ex, "closing the database after the takeover failed");
            }
        }).catch((ex: unknown) => {
            takingOver = false;
            skippedVersions.add(version);
            if(released == true) {
                _logger.error(ex, `concos ${version} failed after taking the client over; ending the bridge`);
                process.exit(1);
            }
            _logger.warn(`kept the client: concos ${version} could not take over: ${ex instanceof Error ? ex.message : String(ex)}`);
            current.takeBack();
            for(const line of held.splice(0)) {
                current.receive(line);
            }
        });
    };

    const beat = (): void => {
        maybeTakeOver();
        if(takingOver == true || retired == true) {
            return;
        }
        try {
            // the version shows on the board, so a session still on an older concos can be found
            store.heartbeat([...joinedAgentIds], CONCOS_VERSION);
            // its client's hook cards too, before their models join; a client gone keeps nothing online
            if(isRunning(clientPid) == true) {
                store.keepAliveForClient(clientPid, CONCOS_VERSION);
            }
            // every running bridge sweeps on its heartbeat, so residue is cleared while anyone is connected
            const removed = store.cleanUp();
            if(removed.messages + removed.agents + removed.checkpoints + removed.workspaces > 0) {
                _logger.debug(`cleaned up ${JSON.stringify(removed)}`);
            }
        }
        catch(ex) {
            _logger.error(ex, "heartbeat or clean-up failed");
        }
        // a turn that fails ends without the Stop hook, so no watch wakes the session. Every MCP
        // server wakes any online session left so once a message has waited too long, not only
        // the ones joined through it: one server of this version covers the machine (2026-10-27)
        const hosts = WAKE_HOSTS.map((adapter) => adapter.id);
        let candidates: string[] = [];
        try {
            candidates = store.fallbackWakeCandidates(hosts);
        }
        catch(ex) {
            _logger.error(ex, "fallback wake check failed");
        }
        for(const agentId of candidates) {
            try {
                const wake = store.fallbackWake(agentId, hosts);
                if(wake == null) {
                    continue;
                }
                const adapter = WAKE_HOSTS.find((item) => item.id == wake.host);
                const line = describeWake(wake.notices, wake.unread, adapter?.wakeCarries);
                adapter?.deliverWake?.(wake.sessionId, line.text).then(() => {
                    store.markDelivered(agentId, line.delivered);
                }).catch((ex) => {
                    _logger.error(ex, "fallback wake was not delivered");
                });
            }
            catch(ex) {
                _logger.error(ex, "fallback wake check failed");
            }
        }
    };
    // from here on this bridge takes stdin, timers and process listeners; code taking over in this
    // process gets them from the older bridge only now, when nothing above can fail any more
    const fromOlder = takeover?.release() ?? { held: [], partial: "" };
    let heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();
    // the board shows the version this bridge runs at once, not a minute after it took a client over;
    // nothing here may fail once an older bridge let go, so a busy database waits for the next beat
    if(handoff != null) {
        try {
            store.heartbeat([...joinedAgentIds], CONCOS_VERSION);
        }
        catch(ex) {
            _logger.error(ex, "first heartbeat after the takeover failed");
        }
    }

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
    process.stdin.on("end", onStdinEnd);
    process.stdin.on("close", onStdinClose);
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);

    server = serveStdio({
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
        // a request is the moment a newer install matters; idle bridges check on their heartbeat
        beforeLine: maybeTakeOver,
        initialized: takeover?.initializeParams,
        partial: fromOlder.partial,
    });
    let origin = "";
    if(takeover != null) {
        origin = ` (took over from concos ${takeover.state.fromVersion ?? "an older version"} in this process)`;
    }
    else if(handoff != null) {
        origin = " (took over from an older bridge)";
    }
    _logger.info(`concos ${CONCOS_VERSION} bridge ready${origin}`);
    if(takeover != null) {
        // what the client sent while this code got ready, then: the tools may read differently now
        for(const line of fromOlder.held) {
            server.receive(line);
        }
        server.writeLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
    }
}

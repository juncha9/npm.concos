import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
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
    MAX_SUMMARY_LENGTH,
    MAX_TASK_LENGTH,
    MAX_TOPICS_PER_MESSAGE,
    MESSAGE_KINDS,
    READ_MESSAGES_MAX_LIMIT,
} from "../../_defs";
import { $logger } from "../../_libs/logger";
import { resolveDataDirectory } from "../../_libs/paths";
import { CONCOS_VERSION } from "../../_libs/version";
import { openDatabase } from "../store/database";
import { RoomError } from "../store/room-error";
import { RoomStore } from "../store/room-store";
import type { CheckInResult, FullMessage } from "../store/room-store";

const SHUTDOWN_DEADLINE_MS = 3000;

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
    "concos is one shared local waiting room for this user. Agents across projects leave their status and messages here; working_directory identifies each agent's project.",
    "Call join once when you start a task, passing your absolute working directory and, as display_name, this session's name exactly as the user set it (not a role). Keep the handle for resume_handle after a restart; use a supplied resume_handle when available.",
    "Call check_in at task boundaries: when starting, after a meaningful step, when blocked, before waiting, and when asked about other agents. Send only changed fields. Report status=working and editing claims while working; before yielding, report status=waiting and editing=[].",
    "Answer messages with kind question. Use read_messages for the full text of a truncated message, and inspect_agent for another agent's detailed context.",
    "Tag messages about one issue with snake_case topics, broad to narrow (webapp_login_redirect), so they group together; reuse a topic from similar_topics when it fits. Durable project knowledge belongs in the project's docs, not in messages.",
    "Call leave when your task is done. Do not call check_in on a timer.",
    "An inbox field on any response counts unread questions and other messages. A message whose full text reached you counts as received on your next call; use read_messages for truncated or unread ones.",
].join("\n");

const handleArgument = z.string().optional().describe("Handle from join. Omit to use the last one joined in this session.");

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
    /**
     * Per agent: messages whose full text went out in its last response. Acknowledged when the
     * same agent calls again; lost with the bridge, so a session that died keeps them unread.
     */
    const deliveredByAgent = new Map<string, number[]>();

    const resolveAgentId = (handle: string | undefined): string => {
        const effectiveHandle = handle ?? lastHandle;
        if(effectiveHandle == null) {
            throw new RoomError("call join first");
        }
        const agentId = store.requireAgentIdByHandle(effectiveHandle);
        toolAgentId = agentId;
        joinedAgentIds.add(agentId);
        store.recordCall(agentId, deliveredByAgent.get(agentId) ?? []);
        deliveredByAgent.delete(agentId);
        return agentId;
    };

    const runTool = (toolName: string, work: () => unknown): CallToolResult => {
        toolAgentId = null;
        try {
            const result = work();
            const delivered = fullyDeliveredMessageIds(toolName, result);
            if(toolAgentId != null && delivered.length > 0) {
                deliveredByAgent.set(toolAgentId, delivered);
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

    const server = new McpServer({ name: "concos", version: CONCOS_VERSION }, { instructions: SERVER_INSTRUCTIONS });

    server.registerTool("join", {
        description: "Join a room. Returns agent_id and handle; keep the handle for later calls and for resume_handle after a restart.",
        inputSchema: {
            display_name: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH).describe("This session's name as the user set it, verbatim (e.g. \"Dev / API 01\"). Not a role; put the role in check_in task."),
            client: z.string().min(1).max(MAX_CLIENT_LENGTH).describe("Your product, e.g. Claude Code, Codex."),
            working_directory: z.string().min(1).max(MAX_PATH_LENGTH).describe("Absolute path of the folder you work in."),
            workspace_root: z.string().max(MAX_PATH_LENGTH).optional().describe("Absolute project root when it differs from working_directory."),
            resume_handle: z.string().optional().describe("Handle from an earlier join, to come back as the same agent."),
        },
    }, (args) => runTool("join", () => {
        const result = store.join({
            displayName: args.display_name,
            client: args.client,
            workingDirectory: args.working_directory,
            workspaceRoot: args.workspace_root ?? null,
            resumeHandle: args.resume_handle ?? null,
        });
        lastHandle = result.handle;
        toolAgentId = result.agent_id;
        joinedAgentIds.add(result.agent_id);
        return result;
    }));

    server.registerTool("check_in", {
        description: "Report your status and editing claims. The answer has `you` (your card's revision) and `room` (other agents' changes and new messages since your last check_in). Empty strings clear a field; editing replaces the list. Before yielding, set status waiting and editing [].",
        inputSchema: {
            handle: handleArgument,
            display_name: z.string().max(MAX_DISPLAY_NAME_LENGTH).optional().describe("Rename your card, e.g. after the user renamed this session; no new join needed."),
            status: z.enum(AGENT_STATUSES).optional(),
            task: z.string().max(MAX_TASK_LENGTH).optional(),
            summary: z.string().max(MAX_SUMMARY_LENGTH).optional().describe("What is done so far and where things stand."),
            next_step: z.string().max(MAX_NEXT_STEP_LENGTH).optional(),
            blocker: z.string().max(MAX_BLOCKER_LENGTH).optional(),
            references: z.array(z.string().max(MAX_LIST_ITEM_LENGTH)).max(MAX_LIST_ITEMS).optional().describe(`Relevant files, commits or docs; up to ${MAX_LIST_ITEMS}.`),
            editing: z.array(z.string().max(MAX_LIST_ITEM_LENGTH)).max(MAX_LIST_ITEMS).optional().describe(`Files or folders you are editing now, up to ${MAX_LIST_ITEMS}; [] when done.`),
            checkpoint: z.string().max(MAX_CHECKPOINT_LENGTH).optional().describe("A short work record worth keeping: result, decision, what remains."),
            received_message_ids: z.array(z.number().int()).max(MAX_RECEIVED_IDS).optional().describe(`Optional, up to ${MAX_RECEIVED_IDS}: messages you read. Full-text deliveries are acknowledged on your next call anyway.`),
            expected_revision: z.number().int().optional().describe("Reject the update if your card moved past this revision."),
            cursor: z.string().optional().describe("Omit to continue from the last delivered position; repeat a previous cursor to receive again."),
        },
    }, (args) => runTool("check_in", () => {
        const agentId = resolveAgentId(args.handle);
        const result = store.checkIn(agentId, {
            cursor: args.cursor ?? null,
            expectedRevision: args.expected_revision ?? null,
            update: {
                displayName: args.display_name,
                status: args.status,
                task: args.task,
                summary: args.summary,
                nextStep: args.next_step,
                blocker: args.blocker,
                references: args.references,
                editing: args.editing,
            },
            checkpoint: args.checkpoint ?? null,
            receivedMessageIds: args.received_message_ids ?? [],
        });
        return shapeCheckIn(result);
    }));

    server.registerTool("inspect_agent", {
        description: "Read another agent's full card and recent checkpoints.",
        inputSchema: {
            handle: handleArgument,
            agent_id: z.string().min(1),
            checkpoint_limit: z.number().int().min(1).optional().describe(`Checkpoints to return, at most ${INSPECT_CHECKPOINT_MAX_LIMIT}; a larger value returns ${INSPECT_CHECKPOINT_MAX_LIMIT}.`),
            before_checkpoint_id: z.number().int().optional().describe("Page to older checkpoints."),
        },
    }, (args) => runTool("inspect_agent", () => {
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

    server.registerTool("send_message", {
        description: "Leave a message for one agent, several, or the whole room. Success means stored, not read.",
        inputSchema: {
            handle: handleArgument,
            to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(MAX_RECIPIENTS)])
                .describe(`An agent_id, a list of up to ${MAX_RECIPIENTS} agent_ids, or "all".`),
            kind: z.enum(MESSAGE_KINDS).optional().describe("Default note. Use question when you need an answer, reply with reply_to."),
            text: z.string().min(1).max(MAX_MESSAGE_LENGTH),
            topics: z.array(z.string()).max(MAX_TOPICS_PER_MESSAGE).optional()
                .describe(`Up to ${MAX_TOPICS_PER_MESSAGE} snake_case topic keys, broad to narrow, e.g. webapp_login_redirect. Reuse one from similar_topics when it fits.`),
            reply_to: z.number().int().optional(),
            request_id: z.string().max(MAX_REQUEST_ID_LENGTH).optional().describe("Reuse on retry to avoid storing the message twice."),
        },
    }, (args) => runTool("send_message", () => {
        const agentId = resolveAgentId(args.handle);
        return store.sendMessage(agentId, {
            to: args.to,
            kind: args.kind ?? "note",
            text: args.text,
            replyTo: args.reply_to ?? null,
            requestId: args.request_id ?? null,
            topics: args.topics ?? [],
        });
    }));

    server.registerTool("read_messages", {
        description: "Read full message text: the ids given, the newest under a topic, or by default your messages not yet received. Returned messages count as received on your next call.",
        inputSchema: {
            handle: handleArgument,
            message_ids: z.array(z.number().int()).max(MAX_RECEIVED_IDS).optional().describe(`Up to ${MAX_RECEIVED_IDS} ids; at most ${READ_MESSAGES_MAX_LIMIT} messages come back per call, with has_more.`),
            topic: z.string().optional().describe("A topic key or its leading words, e.g. webapp: your messages under it and narrower topics."),
            limit: z.number().int().min(1).optional().describe(`Messages per call, at most ${READ_MESSAGES_MAX_LIMIT}; a larger value returns ${READ_MESSAGES_MAX_LIMIT} with has_more.`),
        },
    }, (args) => runTool("read_messages", () => {
        const agentId = resolveAgentId(args.handle);
        // a limit over the maximum is read as "as many as allowed", not as a mistake to reject
        let limit: number | null = null;
        if(args.limit != null) {
            limit = Math.min(args.limit, READ_MESSAGES_MAX_LIMIT);
        }
        return store.readMessages(agentId, { messageIds: args.message_ids ?? null, limit: limit, topic: args.topic ?? null });
    }));

    server.registerTool("leave", {
        description: "Finish your participation, leaving a final summary. Clears your editing list.",
        inputSchema: {
            handle: handleArgument,
            summary: z.string().max(MAX_SUMMARY_LENGTH).optional(),
            next_step: z.string().max(MAX_NEXT_STEP_LENGTH).optional().describe("What whoever continues should do next."),
            checkpoint: z.string().max(MAX_CHECKPOINT_LENGTH).optional(),
        },
    }, (args) => runTool("leave", () => {
        const agentId = resolveAgentId(args.handle);
        return store.leave(agentId, {
            summary: args.summary ?? null,
            nextStep: args.next_step ?? null,
            checkpoint: args.checkpoint ?? null,
        });
    }));

    const heartbeatTimer = setInterval(() => {
        try {
            store.heartbeat([...joinedAgentIds]);
            // every running bridge sweeps on its heartbeat, so residue is cleared while anyone is connected
            const removed = store.cleanUp();
            if(removed.messages + removed.agents + removed.checkpoints + removed.workspaces > 0) {
                _logger.debug(`cleaned up ${JSON.stringify(removed)}`);
            }
        }
        catch(ex) {
            _logger.error(ex, "heartbeat or clean-up failed");
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

    await server.connect(new StdioServerTransport());
    _logger.info(`concos ${CONCOS_VERSION} bridge ready`);
}

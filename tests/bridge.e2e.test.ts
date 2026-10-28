import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// runs the built bundle the way an MCP host does; `npm test` builds it first
const CLI_PATH = path.resolve("dist/cli.js");
const E2E_TIMEOUT_MS = 30000;

let dataDirectory: string;
let workDirectory: string;
const openClients: Client[] = [];

function childEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for(const [key, value] of Object.entries(process.env)) {
        if(value != null) {
            environment[key] = value;
        }
    }
    environment.CONCOS_HOME = dataDirectory;
    // a Codex session start reads the user's hooks for idle wake: the real ones would start
    // detached watches that outlive the test and hold its folder open
    environment.CODEX_HOME = path.join(dataDirectory, "codex-home");
    return environment;
}

async function connectBridge(cwd = workDirectory): Promise<Client> {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI_PATH, "mcp"],
        env: childEnvironment(),
        cwd,
        stderr: "pipe",
    });
    const client = new Client({ name: "concos-e2e", version: "0.0.0" });
    await client.connect(transport);
    openClients.push(client);
    return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    const result = await client.callTool({ name: name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    if(result.isError == true) {
        throw new Error(`${name} failed: ${content[0].text}`);
    }
    return JSON.parse(content[0].text);
}

beforeEach(() => {
    dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "concos-e2e-"));
    workDirectory = path.join(dataDirectory, "work");
    fs.mkdirSync(workDirectory);
});

afterEach(async () => {
    for(const client of openClients.splice(0)) {
        await client.close();
    }
    fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe("concos mcp over stdio", () => {
    it.each(["claude", "codex"])("keeps full recovery and status-only hook updates across %s bridge processes", async (host) => {
        const hook = (kind: string, sessionId: string, extra: Record<string, unknown> = {}) => JSON.parse(execFileSync(process.execPath,
            [CLI_PATH, "hook", kind, "--host", host], {
                env: childEnvironment(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
                input: JSON.stringify({ session_id: sessionId, cwd: workDirectory, stop_hook_active: true, ...extra }),
            }));
        const viewerStart = hook("session-start", "viewer");
        const peerStart = hook("session-start", "peer");
        const viewer = await connectBridge();
        const peer = await connectBridge();
        const viewerHandle = /handle=([\w-]+)/.exec(viewerStart.hookSpecificOutput.additionalContext)![1];
        const peerHandle = /handle=([\w-]+)/.exec(peerStart.hookSpecificOutput.additionalContext)![1];
        await callTool(viewer, "join", { display_name: "Viewer", client: host, working_directory: workDirectory, resume_handle: viewerHandle });
        const joinedPeer = await callTool(peer, "join", { display_name: "Peer", client: host, working_directory: workDirectory, resume_handle: peerHandle });
        await callTool(peer, "check_in", { role: "schema owner", task: "review migration", summary: "kept summary", editing: ["src/store.ts"], checkpoint: "back up first" });
        expect((await callTool(viewer, "inspect_agent", { agent_id: joinedPeer.agent_id })).card.recent_folders).toEqual([]);
        hook("file-edited", "peer", host == "claude"
            ? { tool_name: "Write", tool_input: { file_path: "src/store.ts" } }
            : { tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: src/store.ts\n@@\n-old\n+new\n*** End Patch" }, tool_response: "Success. Updated the following files:\nM src/store.ts" });
        const full = await callTool(viewer, "check_in", {});
        expect(full.room.agents).toEqual([expect.objectContaining({ task: "review migration", checkpoint: "back up first" })]);
        expect(full.room.agents[0]).not.toHaveProperty("recent_folders");
        hook("turn-end", "peer");
        const partial = await callTool(viewer, "check_in", {});
        expect(partial.room.agents).toEqual([expect.objectContaining({ agent_id: joinedPeer.agent_id, detail: "status", status: "waiting", editing: [] })]);
        expect(partial.room.agents[0]).not.toHaveProperty("task");
        expect(partial.room.agents[0]).not.toHaveProperty("recent_folders");
        const inspected = await callTool(viewer, "inspect_agent", { agent_id: joinedPeer.agent_id });
        expect(inspected.card).toMatchObject({ role: "schema owner", task: "review migration", summary: "kept summary" });
        expect(inspected.card.recent_folders).toEqual([{ path: "src", at: expect.any(String) }]);
        const replay = await callTool(viewer, "check_in", { cursor: full.room.cursor });
        expect(replay.room.agents[0]).toMatchObject({ task: "review migration", status: "waiting" });
        expect(replay.room.agents[0]).not.toHaveProperty("detail");
        hook("session-start", "viewer");
        const recovered = await callTool(viewer, "check_in", {});
        expect(recovered.room.agents[0]).toMatchObject({ task: "review migration", checkpoint: "back up first" });
        expect(recovered.room.agents[0]).not.toHaveProperty("detail");

        expect(viewer.getInstructions()).toContain("has_more is available history, not an obligation to drain");
        expect(viewer.getInstructions()).toContain("never send receipt confirmations");
        const tools = await viewer.listTools();
        expect(tools.tools.find((tool) => tool.name == "check_in")!.description).toContain("detail=status");
        hook("session-end", "peer");
        expect((await callTool(viewer, "inspect_agent", { agent_id: joinedPeer.agent_id })).card.recent_folders).toEqual([]);
    }, E2E_TIMEOUT_MS);

    it("shares user hooks, status and messages across projects without room selectors", async () => {
        const otherDirectory = path.join(dataDirectory, "other-project");
        fs.mkdirSync(otherDirectory);
        const start = (host: string, cwd: string) => {
            const output = JSON.parse(execFileSync(process.execPath, [CLI_PATH, "hook", "session-start", "--host", host], {
                env: childEnvironment(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
                input: JSON.stringify({ session_id: `${host}-user-session`, cwd }),
            }));
            return /handle=([\w-]+)/.exec(output.hookSpecificOutput.additionalContext)![1];
        };
        const firstHandle = start("claude", workDirectory);
        const secondHandle = start("codex", otherDirectory);
        const first = await connectBridge(workDirectory);
        const second = await connectBridge(otherDirectory);
        const joined = await callTool(first, "join", { display_name: "First", client: "Claude Code", working_directory: workDirectory, resume_handle: firstHandle });
        const peer = await callTool(second, "join", { display_name: "Second", client: "Codex", working_directory: otherDirectory, resume_handle: secondHandle });
        expect(joined.room).toBe("main");
        expect(peer.room).toBe("main");
        expect(joined.hooks_manage_status_and_editing).toBe(true);
        expect(peer.hooks_manage_status_and_editing).toBe(true);
        expect(joined.workspace_id).not.toBe(peer.workspace_id);
        expect((await first.listTools()).tools.find((tool) => tool.name == "join")!.inputSchema.properties).not.toHaveProperty("room");
        await callTool(first, "send_message", { to: peer.agent_id, kind: "question", text: "Across projects" });
        execFileSync(process.execPath, [CLI_PATH, "say", peer.agent_id, "Status from another project", "--kind", "question"], {
            cwd: workDirectory, env: childEnvironment(), stdio: "pipe",
        });
        const inbox = await callTool(second, "read_messages", {});
        expect(inbox.messages.map((message: any) => message.text)).toEqual(["Across projects", "Status from another project"]);
        const overview = JSON.parse(execFileSync(process.execPath, [CLI_PATH, "status", "--json"], {
            cwd: otherDirectory, env: childEnvironment(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        }));
        expect(overview).toHaveLength(1);
        expect(overview[0].room).toBe("main");
        expect(overview[0].agents.filter((agent: any) => !agent.human)).toHaveLength(2);
        expect(overview[0].agents.find((agent: any) => agent.agent_id == peer.agent_id).pending_count).toBe(2);
    }, E2E_TIMEOUT_MS);

    it("stores a message sent with wake false to wait for the next turn, and checks the flag's type", async () => {
        const first = await connectBridge();
        const second = await connectBridge();
        await callTool(first, "join", { display_name: "Sender", client: "Claude Code", working_directory: workDirectory });
        const reader = await callTool(second, "join", { display_name: "Reader", client: "Codex", working_directory: workDirectory });
        await expect(callTool(first, "send_message", { to: reader.agent_id, text: "done", wake: "no" })).rejects.toThrow(/wake must be true or false/);
        const quiet = await callTool(first, "send_message", { to: reader.agent_id, text: "done", wake: false });
        const loud = await callTool(first, "send_message", { to: reader.agent_id, text: "look" });
        const check = new DatabaseSync(path.join(dataDirectory, "concos.db"), { readOnly: true });
        try {
            expect(check.prepare("SELECT id, wake FROM message ORDER BY id").all()).toEqual([
                { id: quiet.message_id, wake: 0 }, { id: loud.message_id, wake: 1 },
            ]);
        }
        finally { check.close(); }
        // it still arrives, on the reader's next call
        const seen = await callTool(second, "read_messages", {});
        expect(seen.messages.map((message: any) => message.id)).toEqual([quiet.message_id, loud.message_id]);
    }, E2E_TIMEOUT_MS);

    it("posts to the room and lets only its sender rewrite or remove the post", async () => {
        const first = await connectBridge();
        const second = await connectBridge();
        await callTool(first, "join", { display_name: "Poster", client: "Claude Code", working_directory: workDirectory });
        const reader = await callTool(second, "join", { display_name: "Reader", client: "Codex", working_directory: workDirectory });
        await callTool(second, "check_in", {});
        const posted = await callTool(first, "send_message", { to: "all", kind: "notice", text: "Server restarts at 15:00" });
        expect(posted).toMatchObject({ posted: true, recipient_count: 0 });
        await expect(callTool(first, "send_message", { to: reader.agent_id, text: "edited", edit: posted.message_id })).rejects.toThrow(/set to "all"/);
        await expect(callTool(second, "send_message", { to: "all", text: "mine", edit: posted.message_id })).rejects.toThrow(/only those can be edited/);
        await callTool(first, "send_message", { to: "all", text: "Server is back", edit: posted.message_id });
        const seen = await callTool(second, "check_in", {});
        expect(seen.room.messages).toEqual([expect.objectContaining({ id: posted.message_id, to: "all", kind: "notice", text: "Server is back", edited_at: expect.any(String) })]);
        expect(seen.inbox).toBeUndefined();

        await expect(callTool(second, "remove_posts", { message_ids: [posted.message_id] })).rejects.toThrow(/not your posts to all/);
        expect(await callTool(first, "remove_posts", { message_ids: [posted.message_id] })).toEqual({ removed: [posted.message_id] });
        await expect(callTool(second, "read_messages", { message_ids: [posted.message_id] })).resolves.toEqual({
            messages: [], unavailable: [{ id: posted.message_id, reason: expect.stringMatching(/^not found: deleted/) }],
        });
    }, E2E_TIMEOUT_MS);

    it("answers the scripted commands in English", () => {
        const run = (...args: string[]) => spawnSync(process.execPath, [CLI_PATH, ...args], {
            cwd: workDirectory, env: childEnvironment(), encoding: "utf8",
        });
        expect(run("status").stdout).toContain("No agents have joined the shared waiting room yet.");
        expect(run("say").stderr).toContain("concos: say: name a recipient");
        expect(run("say", "all", "Hello", "--kind", "shout").stderr).toContain("concos: --kind must be one of");
        expect(run("say", "all").stderr).toContain("concos: say: add the message text after the recipient");
        expect(run("say", "all", "Schema is frozen").stdout).toContain("posted · Room main");
    }, E2E_TIMEOUT_MS);

    it("shows the copyright notice in the help text and under the hashbang of every built file", () => {
        const help = spawnSync(process.execPath, [CLI_PATH, "--help"], { env: childEnvironment(), encoding: "utf8" });
        expect(help.stdout.split("\n")[1]).toBe("Copyright (C) 2026 juncha9 · AGPL-3.0-or-later · https://github.com/juncha9/npm.concos");
        const distDirectory = path.dirname(CLI_PATH);
        for(const file of fs.readdirSync(distDirectory).filter((name) => name.endsWith(".js"))) {
            const [hashbang, notice] = fs.readFileSync(path.join(distDirectory, file), "utf8").split("\n");
            expect(hashbang, file).toBe("#!/usr/bin/env node");
            expect(notice, file).toBe("/*! concos | Copyright (C) 2026 juncha9 | AGPL-3.0-or-later | https://github.com/juncha9/npm.concos */");
        }
    });

    it("adds caller-specific inbox counts to every tool and keeps hook events from consuming messages", async () => {
        const hook = (kind: string, extra: Record<string, unknown> = {}) => JSON.parse(execFileSync(process.execPath,
            [CLI_PATH, "hook", kind, "--host", "claude", "--room", "e2e"], {
                env: childEnvironment(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
                input: JSON.stringify({ session_id: "host-session", cwd: workDirectory, ...extra }),
            }));
        const started = hook("session-start");
        const handle = /handle=([\w-]+)/.exec(started.hookSpecificOutput.additionalContext)![1];
        const database = new DatabaseSync(path.join(dataDirectory, "concos.db"));
        const recipient = database.prepare("SELECT id FROM agent WHERE host_session_id = 'host-session'").get() as { id: string };
        database.close();
        const sender = await connectBridge();
        const first = await callTool(sender, "join", { display_name: "sender", client: "test", working_directory: workDirectory });
        expect(first.inbox).toBeUndefined();
        const question = await callTool(sender, "send_message", { to: recipient.id, kind: "question", text: "Please review" });
        const note = await callTool(sender, "send_message", { to: recipient.id, kind: "notice", text: "FYI" });
        const receiver = await connectBridge();
        const resumed = await callTool(receiver, "join", { display_name: "receiver", client: "test", working_directory: workDirectory, resume_handle: handle });
        expect(resumed.agent_id).toBe(recipient.id);
        expect(resumed.inbox).toEqual({ questions: 1, notes: 1 });
        expect(hook("prompt").hookSpecificOutput.additionalContext).toContain(`unread for you — question #${question.message_id} from sender`);
        hook("file-edited", { tool_name: "Edit", tool_input: { file_path: path.join(workDirectory, "x.ts") } });
        // until something delivers them, every tool reports the caller's unread messages
        for(const [tool, args] of [
            ["inspect_agent", { agent_id: first.agent_id }],
            ["send_message", { to: first.agent_id, text: "reply", kind: "reply", reply_to: question.message_id }],
        ] as const) {
            const result = await callTool(receiver, tool, args);
            expect(result.inbox).toEqual({ questions: 1, notes: 1 });
        }
        // check_in delivers both in full: they leave this response's inbox and are received on the next call
        const delivered = await callTool(receiver, "check_in", {});
        expect(delivered.room.messages.map((message: any) => message.id)).toEqual([question.message_id, note.message_id]);
        expect(delivered.inbox).toBeUndefined();
        const receivedAt = () => {
            const check = new DatabaseSync(path.join(dataDirectory, "concos.db"));
            const rows = check.prepare("SELECT received_at FROM message_receipt WHERE agent_id = :id ORDER BY message_id").all({ id: recipient.id }) as { received_at: string | null }[];
            check.close();
            return rows.map((row) => row.received_at != null);
        };
        expect(receivedAt()).toEqual([false, false]);
        // Switching handles must not leak the last-joined participant's unread counts.
        const other = await callTool(receiver, "join", { display_name: "other", client: "test", working_directory: workDirectory });
        expect(other.inbox).toBeUndefined();
        expect((await callTool(receiver, "inspect_agent", { handle, agent_id: first.agent_id })).inbox).toBeUndefined();
        expect(receivedAt()).toEqual([true, true]);
        hook("turn-end");
        const inspected = await callTool(receiver, "inspect_agent", { handle, agent_id: recipient.id });
        expect(inspected.card).toMatchObject({ status: "waiting", editing: [] });
        const left = await callTool(receiver, "leave", { handle });
        expect(left.inbox).toBeUndefined();
        await callTool(receiver, "join", { display_name: "receiver", client: "test", working_directory: workDirectory, resume_handle: handle });
        const cleared = await callTool(receiver, "check_in", { received_message_ids: [question.message_id, note.message_id] });
        expect(cleared.inbox).toBeUndefined();
        expect(hook("prompt")).toEqual({});
        hook("session-end");
        // seen from another agent: a call from the ended session itself would bring it back
        expect((await callTool(sender, "inspect_agent", { agent_id: recipient.id })).card.online).toBe(false);
    }, E2E_TIMEOUT_MS);

    it("acknowledges a truncated message only after read_messages delivered its whole text, on the next call", async () => {
        const writer = await connectBridge();
        const reader = await connectBridge();
        await callTool(writer, "join", { display_name: "writer", client: "test", working_directory: workDirectory });
        const joined = await callTool(reader, "join", { display_name: "reader", client: "test", working_directory: workDirectory });
        const sent = await callTool(writer, "send_message", { to: joined.agent_id, text: "long ".repeat(200) });
        const receivedAt = () => {
            const check = new DatabaseSync(path.join(dataDirectory, "concos.db"));
            const row = check.prepare("SELECT received_at FROM message_receipt WHERE message_id = :id").get({ id: sent.message_id }) as { received_at: string | null };
            check.close();
            return row.received_at;
        };

        const preview = await callTool(reader, "check_in", {});
        expect(preview.room.messages[0]).toMatchObject({ id: sent.message_id, truncated: true });
        expect(preview.inbox).toEqual({ questions: 0, notes: 1 });
        await callTool(reader, "check_in", {});
        expect(receivedAt()).toBeNull();

        const full = await callTool(reader, "read_messages", {});
        expect(full.messages[0].text.length).toBeGreaterThan(900);
        expect(full.inbox).toBeUndefined();
        expect(receivedAt()).toBeNull();
        await callTool(reader, "check_in", {});
        expect(receivedAt()).not.toBeNull();
    }, E2E_TIMEOUT_MS);

    it("omits received direct and group messages from default check_in without hiding unread messages", async () => {
        const writer = await connectBridge();
        const reader = await connectBridge();
        const other = await connectBridge();
        await callTool(writer, "join", { display_name: "writer", client: "test", working_directory: workDirectory });
        const joined = await callTool(reader, "join", { display_name: "reader", client: "test", working_directory: workDirectory });
        const peer = await callTool(other, "join", { display_name: "other", client: "test", working_directory: workDirectory });
        await callTool(reader, "check_in", {});

        const direct = await callTool(writer, "send_message", { to: joined.agent_id, text: "direct ".repeat(80) });
        const group = await callTool(writer, "send_message", { to: [joined.agent_id, peer.agent_id], text: "group ".repeat(80) });
        const unread = await callTool(writer, "send_message", { to: joined.agent_id, text: "still unread" });
        const full = await callTool(reader, "read_messages", { message_ids: [direct.message_id, group.message_id] });
        expect(full.messages.map((message: any) => message.id)).toEqual([direct.message_id, group.message_id]);

        const next = await callTool(reader, "check_in", {});
        expect(next.room.messages).toEqual([expect.objectContaining({ id: unread.message_id, text: "still unread" })]);
        expect(next.room.read_in_full).toBeUndefined();
        expect(next.inbox).toBeUndefined();
        const others = await callTool(other, "read_messages", {});
        expect(others.messages).toEqual([expect.objectContaining({ id: group.message_id, received: false })]);

        const acknowledged = await callTool(writer, "send_message", { to: joined.agent_id, text: "acknowledged ".repeat(50) });
        const cleared = await callTool(reader, "check_in", { received_message_ids: [acknowledged.message_id] });
        expect(cleared.room.messages).toBeUndefined();
        expect(cleared.room.read_in_full).toBeUndefined();
    }, E2E_TIMEOUT_MS);

    it("replays received messages at an explicit cursor and still delivers edited room posts", async () => {
        const writer = await connectBridge();
        const reader = await connectBridge();
        await callTool(writer, "join", { display_name: "writer", client: "test", working_directory: workDirectory });
        const joined = await callTool(reader, "join", { display_name: "reader", client: "test", working_directory: workDirectory });
        const before = await callTool(reader, "check_in", {});
        const sent = await callTool(writer, "send_message", { to: joined.agent_id, text: "long ".repeat(100) });
        const first = await callTool(reader, "check_in", { cursor: before.room.cursor });
        expect(first.room.read_in_full).toEqual([sent.message_id]);
        await callTool(reader, "read_messages", { message_ids: [sent.message_id] });
        const replay = await callTool(reader, "check_in", { cursor: before.room.cursor });
        expect(replay.room).toEqual(first.room);
        expect(replay.inbox).toBeUndefined();

        const posted = await callTool(writer, "send_message", { to: "all", text: "original ".repeat(50) });
        await callTool(reader, "read_messages", { message_ids: [posted.message_id] });
        const post = await callTool(reader, "check_in", {});
        expect(post.room.messages).toEqual([expect.objectContaining({ id: posted.message_id, to: "all" })]);
        expect(post.room.read_in_full).toEqual([posted.message_id]);
        await callTool(writer, "send_message", { to: "all", edit: posted.message_id, text: "updated notice" });
        const edited = await callTool(reader, "check_in", {});
        expect(edited.room.messages).toEqual([expect.objectContaining({ id: posted.message_id, text: "updated notice", edited_at: expect.any(String) })]);
    }, E2E_TIMEOUT_MS);

    it("tells an agent with its first answer in a session to record what the thread settles in the docs", async () => {
        const asker = await connectBridge();
        const answerer = await connectBridge();
        const asked = await callTool(asker, "join", { display_name: "asker", client: "test", working_directory: workDirectory });
        const answering = await callTool(answerer, "join", { display_name: "answerer", client: "test", working_directory: workDirectory });
        const question = await callTool(asker, "send_message", { to: answering.agent_id, kind: "question", text: "which port?" });
        expect((await callTool(answerer, "send_message", { to: asked.agent_id, text: "looking into it" })).record_in_docs).toBeUndefined();
        const first = await callTool(answerer, "send_message", { to: asked.agent_id, kind: "reply", reply_to: question.message_id, text: "8080, see docs/ports.md" });
        expect(first.record_in_docs).toContain("project's docs");
        const second = await callTool(answerer, "send_message", { to: asked.agent_id, kind: "reply", reply_to: question.message_id, text: "confirmed" });
        expect(second.record_in_docs).toBeUndefined();
    }, E2E_TIMEOUT_MS);

    it("keeps a card in the project its session started in, and takes the folder it works in through check_in", async () => {
        const docs = path.join(workDirectory, "docs-repo");
        fs.mkdirSync(docs);
        const client = await connectBridge();
        const joined = await callTool(client, "join", { display_name: "Designer", client: "test", working_directory: workDirectory });
        const again = await callTool(client, "join", { display_name: "Designer", client: "test", working_directory: docs, resume_handle: joined.handle });
        expect(again).toMatchObject({ agent_id: joined.agent_id, workspace_id: joined.workspace_id });
        await callTool(client, "check_in", { current_directory: "" });
        expect((await callTool(client, "inspect_agent", { agent_id: joined.agent_id })).card.current_directory).toBeUndefined();
        await callTool(client, "check_in", { current_directory: docs });
        expect((await callTool(client, "inspect_agent", { agent_id: joined.agent_id })).card).toMatchObject({ working_directory: workDirectory, current_directory: docs });
    }, E2E_TIMEOUT_MS);

    it("counts a message read in full as received when the session calls again through a restarted server", async () => {
        const writer = await connectBridge();
        const first = await connectBridge();
        await callTool(writer, "join", { display_name: "writer", client: "test", working_directory: workDirectory });
        const joined = await callTool(first, "join", { display_name: "reader", client: "test", working_directory: workDirectory });
        const sent = await callTool(writer, "send_message", { to: joined.agent_id, kind: "question", text: "ready?" });
        expect((await callTool(first, "read_messages", {})).messages.map((message: any) => message.id)).toEqual([sent.message_id]);
        // the client restarts its concos server before the session calls again
        openClients.splice(openClients.indexOf(first), 1);
        await first.close();
        const second = await connectBridge();
        expect((await callTool(second, "check_in", { handle: joined.handle })).inbox).toBeUndefined();
        const check = new DatabaseSync(path.join(dataDirectory, "concos.db"));
        try {
            expect(check.prepare("SELECT received_at FROM message_receipt WHERE message_id = :id").get({ id: sent.message_id })).toEqual({ received_at: expect.any(String) });
        }
        finally { check.close(); }
    }, E2E_TIMEOUT_MS);

    it("reads a count over the maximum as the maximum, states the limits, and renames through check_in", async () => {
        const writer = await connectBridge();
        const reader = await connectBridge();
        const wrote = await callTool(writer, "join", { display_name: "writer", client: "test", working_directory: workDirectory });
        const joined = await callTool(reader, "join", { display_name: "reader", client: "test", working_directory: workDirectory });
        for(let index = 0; index < 12; index += 1) {
            await callTool(writer, "send_message", { to: joined.agent_id, text: `message ${index}` });
        }

        const page = await callTool(reader, "read_messages", { limit: 20 });
        expect(page.messages).toHaveLength(10);
        expect(page.has_more).toBe(true);
        const inspected = await callTool(reader, "inspect_agent", { agent_id: wrote.agent_id, checkpoint_limit: 50 });
        expect(inspected.card.agent_id).toBe(wrote.agent_id);
        const readTool = (await reader.listTools()).tools.find((tool) => tool.name == "read_messages")!;
        expect(JSON.stringify(readTool.inputSchema)).toContain("at most 10");

        await callTool(reader, "check_in", { display_name: "Dev / API 09" });
        expect((await callTool(writer, "inspect_agent", { agent_id: joined.agent_id })).card.name).toBe("Dev / API 09");
    }, E2E_TIMEOUT_MS);

    it("sends one message to a list of agents under topics, and reads a topic back with its narrower ones", async () => {
        const writer = await connectBridge();
        const first = await connectBridge();
        const second = await connectBridge();
        await callTool(writer, "join", { display_name: "writer", client: "test", working_directory: workDirectory });
        const one = await callTool(first, "join", { display_name: "one", client: "test", working_directory: workDirectory });
        const two = await callTool(second, "join", { display_name: "two", client: "test", working_directory: workDirectory });
        await callTool(writer, "send_message", { to: one.agent_id, text: "tabs first pass", topics: ["concos_board_tabs"] });
        const sent = await callTool(writer, "send_message", { to: [one.agent_id, two.agent_id], text: "layout review", topics: ["concos board"] });
        expect(sent).toMatchObject({ recipient_count: 2, similar_topics: ["concos_board_tabs"] });

        const received = await callTool(second, "check_in", {});
        expect(received.room.messages).toEqual([expect.objectContaining({ id: sent.message_id, to: "group", topics: ["concos_board"] })]);
        const byTopic = await callTool(first, "read_messages", { topic: "concos_board" });
        expect(byTopic.messages.map((message: { text: string }) => message.text)).toEqual(["tabs first pass", "layout review"]);
    }, E2E_TIMEOUT_MS);

    it("shares reported status and messages between separate bridge processes without hooks", async () => {
        const claude = await connectBridge();
        const codex = await connectBridge();

        const tools = await claude.listTools();
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
            ["check_in", "inspect_agent", "join", "leave", "read_messages", "remove_posts", "send_message"]
        );
        expect(claude.getInstructions()).toContain("check_in");

        const ui = await callTool(claude, "join", { display_name: "UI", client: "Claude Code", working_directory: workDirectory });
        const server = await callTool(codex, "join", { display_name: "Server", client: "Codex", working_directory: workDirectory });
        expect(ui.hooks_manage_status_and_editing).toBeUndefined();
        expect(server.hooks_manage_status_and_editing).toBeUndefined();
        expect(ui.room).toBe("main");
        await callTool(claude, "check_in", {});

        await callTool(codex, "check_in", { status: "working", task: "message storage", editing: ["src/messages.ts"] });
        const seen = await callTool(claude, "check_in", {});
        expect(seen.room.agents).toEqual([
            expect.objectContaining({ agent_id: server.agent_id, task: "message storage", editing: ["src/messages.ts"] }),
        ]);

        const sent = await callTool(claude, "send_message", { to: server.agent_id, kind: "question", text: "Does the response carry message_id?" });
        const received = await callTool(codex, "check_in", {});
        expect(received.room.messages).toEqual([expect.objectContaining({ id: sent.message_id, kind: "question", from: ui.agent_id })]);
        // delivered in full in this very answer, so it is no longer counted as waiting
        expect(received.inbox).toBeUndefined();

        const acknowledged = await callTool(codex, "check_in", { received_message_ids: [sent.message_id] });
        expect(acknowledged.inbox).toBeUndefined();
        expect(acknowledged.you.revision).toBeGreaterThan(0);
        expect(acknowledged.room).toMatchObject({ changed: false });

        await callTool(codex, "check_in", { status: "waiting", editing: [] });
        const waiting = await callTool(claude, "inspect_agent", { agent_id: server.agent_id });
        expect(waiting.card).toMatchObject({ status: "waiting", editing: [], online: true });

        const statusJson = execFileSync(process.execPath, [CLI_PATH, "status", "--room", "e2e", "--json"], {
            env: childEnvironment(),
            encoding: "utf8",
        });
        const overview = JSON.parse(statusJson)[0];
        expect(overview.agents.map((agent: { name: string }) => agent.name).sort()).toEqual(["Server", "UI"]);
        expect(overview.messages[0].text).toBe("Does the response carry message_id?");
    }, E2E_TIMEOUT_MS);

    it("exits when stdin closes and releases the editing claim", async () => {
        const child = spawn(process.execPath, [CLI_PATH, "mcp"], {
            env: childEnvironment(),
            stdio: ["pipe", "pipe", "pipe"],
        });
        const responses = new Map<number, any>();
        let buffered = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            buffered += chunk;
            let newline = buffered.indexOf("\n");
            while(newline >= 0) {
                const line = buffered.slice(0, newline).trim();
                buffered = buffered.slice(newline + 1);
                if(line != "") {
                    const message = JSON.parse(line);
                    responses.set(message.id, message);
                }
                newline = buffered.indexOf("\n");
            }
        });
        const request = async (id: number, method: string, params: unknown): Promise<any> => {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: id, method: method, params: params })}\n`);
            for(let attempt = 0; attempt < 200; attempt++) {
                if(responses.has(id) == true) {
                    return responses.get(id);
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error(`no response to ${method}`);
        };

        await request(1, "initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "raw", version: "0" },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
        const joined = await request(2, "tools/call", {
            name: "join",
            arguments: { display_name: "Server", client: "raw", working_directory: workDirectory },
        });
        const agentId = JSON.parse(joined.result.content[0].text).agent_id;
        await request(3, "tools/call", { name: "check_in", arguments: { editing: ["src/a.ts"] } });

        const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
        const startedAt = Date.now();
        child.stdin.end();
        const exitCode = await exited;
        expect(exitCode).toBe(0);
        expect(Date.now() - startedAt).toBeLessThan(5000);

        const database = new DatabaseSync(path.join(dataDirectory, "concos.db"));
        const row = database.prepare("SELECT editing_list, disconnected_at FROM agent WHERE id = :id").get({ id: agentId }) as {
            editing_list: string;
            disconnected_at: string | null;
        };
        database.close();
        expect(row.editing_list).toBe("[]");
        expect(row.disconnected_at).not.toBeNull();
    }, E2E_TIMEOUT_MS);

    it("answers the MCP requests it offers and stays quiet on the rest, as the SDK it replaced did", async () => {
        const child = spawn(process.execPath, [CLI_PATH, "mcp"], {
            env: childEnvironment(),
            stdio: ["pipe", "pipe", "pipe"],
        });
        const answers: any[] = [];
        let buffered = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            buffered += chunk;
            let newline = buffered.indexOf("\n");
            while(newline >= 0) {
                const line = buffered.slice(0, newline).trim();
                buffered = buffered.slice(newline + 1);
                if(line != "") {
                    answers.push(JSON.parse(line));
                }
                newline = buffered.indexOf("\n");
            }
        });
        const sendLine = (line: string): void => {
            child.stdin.write(`${line}\n`);
        };
        const answerTo = async (id: number | string): Promise<any> => {
            for(let attempt = 0; attempt < 200; attempt++) {
                const found = answers.find((answer) => answer.id == id);
                if(found != null) {
                    return found;
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error(`no answer to request ${id}`);
        };
        const callTool = async (id: number, name: string, args?: unknown): Promise<any> => {
            sendLine(JSON.stringify({ jsonrpc: "2.0", id: id, method: "tools/call", params: { name: name, arguments: args } }));
            const answer = await answerTo(id);
            return answer.result;
        };

        sendLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "raw", version: "0" } } }));
        const initialized = (await answerTo(1)).result;
        expect(initialized.protocolVersion).toBe("2025-11-25");
        expect(initialized.capabilities).toEqual({ tools: { listChanged: true } });
        expect(initialized.serverInfo.name).toBe("concos");

        sendLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
        const tools = (await answerTo(2)).result.tools;
        expect(tools.map((tool: any) => tool.name)).toEqual(["join", "check_in", "inspect_agent", "send_message", "read_messages", "remove_posts", "leave"]);
        expect(tools.every((tool: any) => tool.inputSchema.type == "object" && tool.execution.taskSupport == "forbidden")).toBe(true);

        sendLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} }));
        expect((await answerTo(3)).error).toEqual({ code: -32601, message: "Method not found" });

        expect(await callTool(4, "no_such_tool", {})).toEqual({ content: [{ type: "text", text: "Tool no_such_tool not found" }], isError: true });
        // an argument the tool does not take is refused, never dropped, and the answer lists what it takes
        const missing = await callTool(5, "join", { display_name: "", extra: true });
        expect(missing.isError).toBe(true);
        expect(missing.content[0].text).toBe("Invalid arguments for tool join: client is required; working_directory is required; display_name must not be empty; extra is not a join argument. join takes display_name, client, working_directory, workspace_root, resume_handle");
        // one another tool takes names that tool: `role` belongs to check_in, `to` to send_message
        const misplaced = await callTool(8, "join", { display_name: "Dev", client: "raw", working_directory: process.cwd(), role: "owner" });
        expect(misplaced.content[0].text).toBe("Invalid arguments for tool join: role is not a join argument; check_in takes it. join takes display_name, client, working_directory, workspace_root, resume_handle");
        const wrongTypes = await callTool(6, "check_in", { status: "sleeping", received_message_ids: [1.5], to: 3 });
        expect(wrongTypes.content[0].text).toMatch(/^Invalid arguments for tool check_in: status must be one of working, waiting, idle, finished; received_message_ids\[0\] must be an integer; to is not a check_in argument; send_message takes it\. check_in takes handle, display_name, status, role, /);
        const withoutArguments = await callTool(7, "read_messages");
        expect(withoutArguments).toEqual({ content: [{ type: "text", text: "call join first: this concos server has no join yet, as after a restart. Join with the resume_handle your session was given to keep your card, or pass handle" }], isError: true });

        // neither a broken line nor a notification is answered, and the bridge keeps serving
        const answeredBefore = answers.length;
        sendLine("{not json");
        sendLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }));
        sendLine(JSON.stringify({ jsonrpc: "2.0", id: "last", method: "ping" }));
        expect((await answerTo("last")).result).toEqual({});
        expect(answers.length).toBe(answeredBefore + 1);

        child.stdin.end();
        await new Promise((resolve) => child.on("exit", resolve));
    }, E2E_TIMEOUT_MS);
});

describe("taking over from an older bridge", () => {
    /**
     * A copy of the built bundle with its own package.json, as `npm install -g` lays it out, so the
     * test can install a "newer" version under a running bridge by rewriting that file.
     */
    function installCopy(): { cli: string; packageFile: string } {
        const root = path.join(dataDirectory, "install");
        fs.cpSync(path.resolve("dist"), path.join(root, "dist"), { recursive: true });
        fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
        const packageFile = path.join(root, "package.json");
        fs.copyFileSync(path.resolve("package.json"), packageFile);
        return { cli: path.join(root, "dist", "cli.js"), packageFile: packageFile };
    }

    function installVersion(packageFile: string, version: string): void {
        const json = JSON.parse(fs.readFileSync(packageFile, "utf8")) as Record<string, unknown>;
        fs.writeFileSync(packageFile, JSON.stringify({ ...json, version: version }, null, 2));
        // the bridge re-reads the file only when its modification time moves
        const later = new Date(Date.now() + 5000);
        fs.utimesSync(packageFile, later, later);
    }

    async function connect(cli: string): Promise<{ client: Client; log: () => string; listChanged: () => number }> {
        const transport = new StdioClientTransport({
            command: process.execPath, args: [cli, "mcp"], env: { ...childEnvironment(), CONCOS_LOG_LEVEL: "info" }, cwd: workDirectory, stderr: "pipe",
        });
        let log = "";
        transport.stderr?.on("data", (chunk: Buffer) => {
            log += chunk.toString();
        });
        const client = new Client({ name: "concos-e2e", version: "0.0.0" });
        let listChanged = 0;
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            listChanged += 1;
        });
        await client.connect(transport);
        openClients.push(client);
        return { client, log: () => log, listChanged: () => listChanged };
    }

    it("moves the client to a newer installed concos at its next call, keeping its join", async () => {
        const { cli, packageFile } = installCopy();
        const { client, log, listChanged } = await connect(cli);
        const joined = await callTool(client, "join", { display_name: "Server", client: "Codex", working_directory: workDirectory });
        installVersion(packageFile, "99.0.0");
        // no handle: the newer bridge carries the one joined through the older bridge
        const answered = await callTool(client, "check_in", { status: "working", task: "after the update" });
        expect(answered.you.revision).toBeGreaterThan(1);
        await expect.poll(() => listChanged()).toBe(1);
        expect(log()).toContain("handed the client to concos 99.0.0");
        expect(log()).toContain("took over from an older bridge");
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("check_in");
        // the same card, still working, and the version is not handed to again
        const card = await callTool(client, "inspect_agent", { agent_id: joined.agent_id });
        expect(card.card).toMatchObject({ agent_id: joined.agent_id, task: "after the update" });
        expect(log().match(/handed the client to concos/g)).toHaveLength(1);
        // closing the client ends both bridges
        const successorPid = Number(/handed the client to concos 99\.0\.0 \(pid (\d+)\)/.exec(log())?.[1]);
        await client.close();
        openClients.splice(openClients.indexOf(client), 1);
        await expect.poll(() => {
            try {
                process.kill(successorPid, 0);
                return true;
            }
            catch {
                return false;
            }
        }, { timeout: 10000 }).toBe(false);
    }, E2E_TIMEOUT_MS);

    it("keeps the client when the newer install does not start, and does not try that version again", async () => {
        const { cli, packageFile } = installCopy();
        const { client, log } = await connect(cli);
        await callTool(client, "join", { display_name: "Server", client: "Codex", working_directory: workDirectory });
        // a broken install: the running bridge has its code loaded already, a new one would not start
        fs.writeFileSync(cli, "process.exit(3);\n");
        installVersion(packageFile, "99.0.0");
        const answered = await callTool(client, "check_in", { task: "still here" });
        expect(answered.you.revision).toBeGreaterThan(1);
        expect(log()).toContain("kept the client: the newer bridge stopped (exit 3)");
        await callTool(client, "check_in", { task: "again" });
        expect(log().match(/kept the client/g)).toHaveLength(1);
    }, E2E_TIMEOUT_MS);
});

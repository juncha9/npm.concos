// Run after npm run build; --cli selects another built revision. All rooms are disposable.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as sqlite from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { values } = parseArgs({
    options: {
        cli: { type: "string", default: fileURLToPath(new URL("../dist/cli.js", import.meta.url)) },
        label: { type: "string", default: "working-tree" },
        output: { type: "string" },
        "evidence-dir": { type: "string" },
        "expect-no-rereads": { type: "boolean", default: false },
        "expect-status-cards": { type: "boolean", default: false },
    },
});
const CLI_PATH = path.resolve(values.cli);
const FIELD_LENGTH = 110;
const MAX_PAGES = 100;
const HOST_LABELS = { claude: "Claude Code", codex: "Codex" };

function scenario(name) {
    return {
        name, check_in_calls: 0, read_messages_calls: 0, followup_read_messages_calls: 0,
        request_argument_chars: 0, response_text_chars: 0, response_json_chars: 0,
        cards: 0, full_cards: 0, status_cards: 0, previews: 0, truncated_previews: 0, already_read_direct_previews: 0,
        first_page: null, pages: [],
    };
}

async function measure(host) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "concos-check-in-"));
    const workspacePaths = ["viewer", "other-a", "other-b"].map((name) => path.join(directory, name));
    for(const workspace of workspacePaths) {
        fs.mkdirSync(workspace);
    }
    const environment = { ...process.env, CONCOS_HOME: path.join(directory, "data"), CONCOS_LOG_LEVEL: "none" };
    const clients = [];
    const delivered = new Set();
    const directIds = new Set();
    const evidence = { calls: [], snapshots: {} };
    let evidenceDirectory = null;
    if(values["evidence-dir"] != null) {
        evidenceDirectory = path.resolve(values["evidence-dir"], host);
        fs.mkdirSync(evidenceDirectory, { recursive: true });
    }
    const snapshot = async (name) => {
        if(evidenceDirectory == null) {
            return;
        }
        const target = path.join(evidenceDirectory, `${name}.db`);
        assert.equal(fs.existsSync(target), false, `use a new evidence directory: ${target}`);
        const database = new sqlite.DatabaseSync(path.join(environment.CONCOS_HOME, "concos.db"), { readOnly: true });
        try {
            if(typeof sqlite.backup == "function") {
                await sqlite.backup(database, target);
            }
            else {
                database.prepare("VACUUM INTO ?").run(target);
            }
        }
        finally {
            database.close();
        }
        evidence.snapshots[name] = target;
    };

    const connect = async () => {
        const client = new Client({ name: "check-in-measure", version: "1" });
        clients.push(client);
        await client.connect(new StdioClientTransport({
            command: process.execPath, args: [CLI_PATH, "mcp"],
            cwd: directory, env: environment, stderr: "pipe",
        }));
        return client;
    };
    const hook = (kind, participant) => {
        const output = execFileSync(process.execPath, [CLI_PATH, "hook", kind, "--host", host], {
            env: environment, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
            input: JSON.stringify({ session_id: participant.session_id, cwd: participant.directory, stop_hook_active: true }),
        });
        return JSON.parse(output);
    };
    const call = async ({ client, name, args = {}, metrics = null, followup = false }) => {
        const response = await client.callTool({ name, arguments: args });
        if(response.isError == true) {
            throw new Error(`${name}: ${response.content[0].text}`);
        }
        const body = JSON.parse(response.content[0].text);
        if(metrics != null) {
            evidence.calls.push({ scenario: metrics.name, tool: name, arguments: args, response });
            metrics.request_argument_chars += JSON.stringify(args).length;
            metrics.response_text_chars += response.content.reduce((length, item) => length + (item.text ?? "").length, 0);
            metrics.response_json_chars += JSON.stringify(response).length;
            if(name == "check_in") {
                metrics.check_in_calls += 1;
                const cards = body.room.agents ?? [];
                const messages = body.room.messages ?? [];
                metrics.cards += cards.length;
                metrics.full_cards += cards.filter((card) => card.detail != "status").length;
                metrics.status_cards += cards.filter((card) => card.detail == "status").length;
                metrics.previews += messages.length;
                metrics.truncated_previews += messages.filter((message) => message.truncated == true).length;
                metrics.already_read_direct_previews += messages.filter((message) => directIds.has(message.id) && delivered.has(message.id)).length;
                metrics.pages.push({
                    cards: cards.length, messages: messages.length, has_more: body.room.has_more == true,
                    request_argument_chars: JSON.stringify(args).length, response_text_chars: response.content[0].text.length,
                });
                if(metrics.first_page == null) {
                    metrics.first_page = { agents: cards, message_ids: messages.map((message) => message.id) };
                }
            }
            if(name == "read_messages") {
                metrics.read_messages_calls += 1;
                if(followup == true) {
                    metrics.followup_read_messages_calls += 1;
                }
            }
        }
        if(name == "read_messages") {
            for(const message of body.messages) {
                delivered.add(message.id);
            }
        }
        if(name == "check_in") {
            for(const message of body.room.messages ?? []) {
                if(message.truncated != true) {
                    delivered.add(message.id);
                }
            }
        }
        return body;
    };
    const join = async ({ client, name, workspace }) => {
        const participant = { session_id: `${host}-${name}`, directory: workspace };
        const started = hook("session-start", participant);
        const context = started.hookSpecificOutput.additionalContext;
        const handle = /handle=([\w-]+)/.exec(context)?.[1];
        assert.ok(handle, "session-start must supply its handle");
        const joined = await call({ client, name: "join", args: {
            display_name: name, client: HOST_LABELS[host], working_directory: workspace, resume_handle: handle,
        } });
        return { ...joined, ...participant };
    };

    try {
        const viewerClient = await connect();
        const definitions = await viewerClient.listTools();
        const instructions = viewerClient.getInstructions() ?? "";
        const control = await connect();
        const viewer = await join({ client: viewerClient, name: "viewer", workspace: workspacePaths[0] });
        await call({ client: viewerClient, name: "check_in" });
        const peers = [];
        for(let index = 0; index < 15; index++) {
            let workspace = workspacePaths[0];
            if(index >= 9) {
                workspace = workspacePaths[2];
            }
            else if(index >= 2) {
                workspace = workspacePaths[1];
            }
            const peer = await join({ client: control, name: `peer-${index}`, workspace });
            peers.push(peer);
            const editing = [];
            if(index < 2) {
                editing.push("src/shared.ts");
            }
            await call({ client: control, name: "check_in", args: {
                handle: peer.handle, status: "working", editing,
                role: "r".repeat(FIELD_LENGTH), task: "t".repeat(FIELD_LENGTH),
                next_step: "n".repeat(FIELD_LENGTH), checkpoint: "c".repeat(FIELD_LENGTH),
            } });
        }

        const postIds = [];
        for(let index = 0; index < 6; index++) {
            let length = 80;
            if(index % 2 == 0) {
                length = 420;
            }
            const sent = await call({ client: control, name: "send_message", args: {
                handle: peers[Math.floor(index / 3)].handle, to: "all", kind: "notice",
                text: `notice-${index} `.padEnd(length, "."),
            } });
            postIds.push(sent.message_id);
        }
        const sendDirectMessages = async (label) => {
            const ids = [];
            for(let index = 0; index < 3; index++) {
                let length = 80;
                if(index < 2) {
                    length = 420;
                }
                const sent = await call({ client: control, name: "send_message", args: {
                    handle: peers[2].handle, to: viewer.agent_id,
                    text: `${label}-${index} `.padEnd(length, "."),
                } });
                ids.push(sent.message_id);
                directIds.add(sent.message_id);
            }
            return ids;
        };
        const synchronize = async (metrics, args = {}) => {
            for(let page = 0; page < MAX_PAGES; page++) {
                const response = await call({ client: viewerClient, name: "check_in", args, metrics });
                args = {};
                const readInFull = response.room.read_in_full ?? [];
                if(readInFull.length > 0) {
                    await call({ client: viewerClient, name: "read_messages", args: { message_ids: readInFull }, metrics, followup: true });
                }
                if(response.room.has_more != true) {
                    return;
                }
            }
            throw new Error("check_in did not drain within the page limit");
        };

        await sendDirectMessages("S1");
        const first = scenario("S1_first_sync");
        await snapshot("S1-before-sync");
        await synchronize(first);
        for(const peer of peers) {
            hook("turn-end", peer);
            hook("prompt", peer);
        }
        const secondIds = await sendDirectMessages("S2");
        const second = scenario("S2_hooks_then_read");
        await snapshot("S2-before-read");
        await call({ client: viewerClient, name: "read_messages", args: { message_ids: secondIds }, metrics: second });
        await snapshot("S2-before-sync");
        await synchronize(second);
        const third = scenario("S3_turn_end_report");
        await snapshot("S3-before-report");
        if(viewer.hooks_manage_status_and_editing != true) {
            await synchronize(third, { status: "waiting", editing: [] });
        }
        hook("turn-end", viewer);
        await snapshot("S3-after-hook");

        const allDirectDelivered = [...directIds].every((id) => delivered.has(id));
        const noReceivedDirectPreviews = [first, second, third].every((metrics) => metrics.already_read_direct_previews == 0);

        // These contract probes are outside S1-S3 and their measured call totals.
        const before = await call({ client: viewerClient, name: "check_in" });
        const sent = await call({ client: control, name: "send_message", args: {
            handle: peers[2].handle, to: viewer.agent_id, text: "replay ".repeat(60),
        } });
        const original = await call({ client: viewerClient, name: "check_in", args: { cursor: before.room.cursor } });
        await call({ client: viewerClient, name: "read_messages", args: { message_ids: [sent.message_id] } });
        const replay = await call({ client: viewerClient, name: "check_in", args: { cursor: before.room.cursor } });
        assert.deepEqual(replay.room, original.room, "explicit cursor must replay the same page after receipt");
        const editedId = postIds[5];
        await call({ client: control, name: "send_message", args: {
            handle: peers[1].handle, to: "all", edit: editedId, text: "edited notice",
        } });
        const edited = await call({ client: viewerClient, name: "check_in" });
        assert.ok(edited.room.messages?.some((message) => message.id == editedId && message.text == "edited notice"), "edited posts must be delivered again");
        assert.equal(allDirectDelivered, true, "every direct message must arrive in full");
        if(values["expect-no-rereads"] == true) {
            assert.equal(noReceivedDirectPreviews, true, "default check_in must omit received direct messages");
        }
        const viewerAfterHook = await call({ client: viewerClient, name: "inspect_agent", args: { agent_id: viewer.agent_id } });
        assert.equal(viewerAfterHook.card.status, "waiting");
        assert.deepEqual(viewerAfterHook.card.editing, []);
        if(values["expect-status-cards"] == true) {
            assert.equal(first.full_cards, 15, "every initial card must include content");
            assert.equal(second.status_cards, 15, "known cards with hook-only changes must be abbreviated");
            assert.equal(second.full_cards, 0);
            assert.equal(viewer.hooks_manage_status_and_editing, true);
            assert.equal(third.check_in_calls, 0, "hook-bound sessions need no waiting-only report");
            await call({ client: viewerClient, name: "join", args: {
                display_name: "viewer", client: HOST_LABELS[host], working_directory: viewer.directory, resume_handle: viewer.handle,
            } });
            const recovered = [];
            for(let page = 0; page < MAX_PAGES; page++) {
                const result = await call({ client: viewerClient, name: "check_in" });
                recovered.push(...(result.room.agents ?? []));
                if(result.room.has_more != true) break;
            }
            assert.deepEqual(recovered.map((card) => card.agent_id).sort(), peers.map((peer) => peer.agent_id).sort());
            assert.ok(recovered.every((card) => card.detail == null && card.task != null), "rejoining must restore every full card");
        }

        for(const metrics of [first, second, third]) {
            if(metrics.first_page == null) {
                continue;
            }
            metrics.first_page = {
                cards: metrics.first_page.agents.length,
                same_workspace_cards: metrics.first_page.agents.filter((card) => card.workspace_id == viewer.workspace_id).length,
                editing_claims: metrics.first_page.agents.filter((card) => (card.editing ?? []).length > 0).length,
                same_workspace_editing_claims: metrics.first_page.agents.filter((card) =>
                    card.workspace_id == viewer.workspace_id && (card.editing ?? []).length > 0).length,
                messages: metrics.first_page.message_ids.length,
            };
        }
        let evidencePath = null;
        if(evidenceDirectory != null) {
            evidencePath = path.join(evidenceDirectory, "calls-and-fixture.json");
            fs.writeFileSync(evidencePath, `${JSON.stringify({
                host, viewer, peers, post_ids: postIds, direct_ids: [...directIds],
                ...evidence,
            }, null, 2)}\n`);
        }
        return {
            host, scenarios: [first, second, third],
            server_definition: {
                instructions_chars: instructions.length,
                tool_count: definitions.tools.length,
                tool_description_chars: definitions.tools.reduce((total, tool) => total + (tool.description ?? "").length, 0),
                tools_json_chars: JSON.stringify(definitions.tools).length,
            },
            evidence_path: evidencePath,
            checks: {
                all_direct_messages_delivered: allDirectDelivered,
                received_direct_messages_omitted: noReceivedDirectPreviews,
                explicit_cursor_replays_after_receipt: true,
                edited_posts_redelivered: true,
                hook_only_waiting_supported: viewer.hooks_manage_status_and_editing == true,
                waiting_and_empty_editing_after_hook: true,
                full_cards_restored_on_rejoin: values["expect-status-cards"] == true ? true : null,
            },
        };
    }
    finally {
        await Promise.allSettled(clients.map((client) => client.close()));
        const resolved = fs.realpathSync(directory);
        assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith("concos-check-in-"));
        fs.rmSync(resolved, { recursive: true });
    }
}

const results = [];
for(const host of Object.keys(HOST_LABELS)) {
    results.push(await measure(host));
}
const report = {
    label: values.label, cli: CLI_PATH, node: process.version, platform: process.platform,
    fixture: { peers: 15, peers_per_workspace: [2, 7, 6], card_field_chars: FIELD_LENGTH, posts: 6, long_posts: 3, direct_messages_per_batch: 3, long_direct_messages_per_batch: 2 },
    accounting: {
        requests: "JSON.stringify(arguments).length; viewer calls only",
        responses: "content text length and serialized MCP result length, including follow-up reads",
        excluded: "setup, peer calls/hooks, contract probes and fixed tools/instructions cost",
        continuation: "S1 and S2 read all pages for comparison; S3 skips a waiting-only report only when join advertises hook management",
        host_tokens: null,
        host_tokens_reason: "SDK and hook adapters only; no model or actual host conversation is invoked",
    },
    results,
};
const serialized = JSON.stringify(report, null, 2);
if(values.output != null) {
    fs.writeFileSync(path.resolve(values.output), `${serialized}\n`);
}
process.stdout.write(`${serialized}\n`);

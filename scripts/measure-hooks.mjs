// Run after npm run build. Uses only disposable local data and never invokes a model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "concos-measure-"));
const environment = { ...process.env, CONCOS_HOME: path.join(directory, "data"), CONCOS_LOG_LEVEL: "none" };
const clients = [];
try {
    const hook = (kind) => {
        const start = performance.now();
        execFileSync(process.execPath, [cli, "hook", kind, "--host", "codex"], {
            env: environment, input: JSON.stringify({ session_id: "measure", cwd: directory }), stdio: ["pipe", "pipe", "pipe"],
        });
        return performance.now() - start;
    };
    const coldMs = hook("session-start");
    const samples = Array.from({ length: 20 }, () => hook("prompt")).sort((a, b) => a - b);
    const connect = async () => {
        const client = new Client({ name: "measure", version: "0" });
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: environment, stderr: "pipe" }));
        clients.push(client);
        return client;
    };
    const reader = await connect();
    const sender = await connect();
    const call = async (client, name, args = {}) => {
        const result = await client.callTool({ name, arguments: args });
        if(result.isError) throw new Error(result.content[0].text);
        return { body: JSON.parse(result.content[0].text), chars: result.content[0].text.length };
    };
    const receiver = await call(reader, "join", { display_name: "receiver", client: "measure", working_directory: directory });
    const sending = await call(sender, "join", { display_name: "sender", client: "measure", working_directory: directory });
    await call(reader, "check_in");
    const empty = await call(reader, "check_in");
    await call(sender, "send_message", { to: receiver.body.agent_id, kind: "question", text: "Question" });
    // before anything delivers it, any tool answer carries only the unread counts
    const countsOnly = await call(reader, "inspect_agent", { agent_id: sending.body.agent_id });
    // check_in delivers the whole message, which then counts as received on the next call
    const withBody = await call(reader, "check_in");
    const acknowledged = await call(reader, "check_in");
    const { inbox, ...withoutInbox } = countsOnly.body;
    console.log(JSON.stringify({
        node: process.version, platform: process.platform,
        hook_ms: { cold: +coldMs.toFixed(1), median: +samples[10].toFixed(1), p95: +samples[18].toFixed(1), samples: samples.length },
        response_chars: { empty: empty.chars, question_with_body: withBody.chars, acknowledged: acknowledged.chars },
        inbox_overhead_chars: countsOnly.chars - JSON.stringify(withoutInbox).length,
        delivered_message_ids: withBody.body.room.messages.map((message) => message.id),
        acknowledged_inbox: acknowledged.body.inbox ?? null,
        tools_chars: JSON.stringify((await reader.listTools()).tools).length,
        instructions_chars: reader.getInstructions().length,
    }, null, 2));
}
finally {
    for(const client of clients) await client.close();
    fs.rmSync(directory, { recursive: true, force: true });
}

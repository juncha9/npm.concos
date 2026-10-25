import type { Logger } from "../../_libs/logger";
import { checkArguments } from "./tool-schema";
import type { InputSchema } from "./tool-schema";

/** Newest first: a client asking for a revision not listed gets the newest. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: InputSchema;
}

export interface ToolResult {
    content: { type: "text"; text: string }[];
    isError?: boolean;
}

/**
 * MCP over stdio for a server that offers tools only: one JSON-RPC message per line on stdin and on
 * stdout. Answers initialize, ping, tools/list and tools/call, each like the MCP SDK the bridge was
 * first built on. Notifications, responses from the client and lines that are not JSON-RPC get no
 * answer; any other request gets "Method not found".
 */
export function serveStdio(options: {
    name: string;
    version: string;
    instructions: string;
    tools: ToolDefinition[];
    callTool: (name: string, values: Record<string, unknown>) => ToolResult;
    logger: Logger;
}): void {
    const { logger } = options;
    let stdoutBroken = false;
    // the client is gone; stdin's end shuts the bridge down, so later answers are dropped
    process.stdout.on("error", () => {
        stdoutBroken = true;
    });
    const send = (id: string | number, outcome: { result: unknown } | { error: { code: number; message: string } }): void => {
        if(stdoutBroken == true) {
            return;
        }
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: id, ...outcome })}\n`);
    };
    const toolError = (text: string): ToolResult => ({ content: [{ type: "text", text: text }], isError: true });

    const answer = (id: string | number, method: string, params: Record<string, unknown>): void => {
        if(method == "initialize") {
            let protocolVersion = SUPPORTED_PROTOCOL_VERSIONS[0];
            if(typeof params.protocolVersion == "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion) == true) {
                protocolVersion = params.protocolVersion;
            }
            send(id, {
                result: {
                    protocolVersion: protocolVersion,
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: options.name, version: options.version },
                    instructions: options.instructions,
                },
            });
            return;
        }
        if(method == "ping") {
            send(id, { result: {} });
            return;
        }
        if(method == "tools/list") {
            const tools = options.tools.map((tool) => ({ ...tool, execution: { taskSupport: "forbidden" } }));
            send(id, { result: { tools: tools } });
            return;
        }
        if(method == "tools/call") {
            const tool = options.tools.find((candidate) => candidate.name == params.name);
            if(tool == null) {
                send(id, { result: toolError(`Tool ${String(params.name)} not found`) });
                return;
            }
            // an argument meant for another tool says which one takes it, e.g. role belongs to check_in
            const check = checkArguments(tool.inputSchema, params.arguments, (name) => {
                const takers = options.tools.filter((other) => other.name != tool.name && Object.hasOwn(other.inputSchema.properties, name)).map((other) => other.name);
                if(takers.length == 0) {
                    return `${name} is not a ${tool.name} argument`;
                }
                return `${name} is not a ${tool.name} argument; ${takers.join(", ")} ${takers.length == 1 ? "takes" : "take"} it`;
            });
            if(check.ok == false) {
                let text = `Invalid arguments for tool ${tool.name}: ${check.problems.join("; ")}`;
                if(check.unknown.length > 0) {
                    text += `. ${tool.name} takes ${Object.keys(tool.inputSchema.properties).join(", ")}`;
                }
                send(id, { result: toolError(text) });
                return;
            }
            send(id, { result: options.callTool(tool.name, check.values) });
            return;
        }
        send(id, { error: { code: METHOD_NOT_FOUND, message: "Method not found" } });
    };

    const receive = (line: string): void => {
        let message: unknown;
        try {
            message = JSON.parse(line);
        }
        catch {
            logger.warn("ignored a line that is not JSON");
            return;
        }
        if(typeof message != "object" || message == null || Array.isArray(message) == true) {
            logger.warn("ignored a message that is not a JSON-RPC object");
            return;
        }
        const fields = message as Record<string, unknown>;
        if(fields.jsonrpc != "2.0") {
            logger.warn("ignored a message without jsonrpc 2.0");
            return;
        }
        // no method: a response to a request this server never sends; no id: a notification
        if(typeof fields.method != "string" || (typeof fields.id != "string" && typeof fields.id != "number")) {
            return;
        }
        let params: Record<string, unknown> = {};
        if(typeof fields.params == "object" && fields.params != null) {
            params = fields.params as Record<string, unknown>;
        }
        try {
            answer(fields.id, fields.method, params);
        }
        catch(ex) {
            logger.error(ex, `request ${fields.method} failed`);
            send(fields.id, { error: { code: INTERNAL_ERROR, message: "Internal error" } });
        }
    };

    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
        buffer += chunk;
        for(let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
            const line = buffer.slice(0, end).replace(/\r$/, "");
            buffer = buffer.slice(end + 1);
            if(line.trim() != "") {
                receive(line);
            }
        }
    });
}

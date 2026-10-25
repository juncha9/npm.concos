import { parseArgs } from "node:util";
import { MESSAGE_KINDS } from "./_defs";
import type { MessageKind } from "./_defs";
import { $logger } from "./_libs/logger";
import { CONCOS_VERSION } from "./_libs/version";
import { RoomError } from "./modules/store/room-error";

const HELP_TEXT = `concos ${CONCOS_VERSION} — Agent waiting room
Copyright (C) 2026 juncha9 · AGPL-3.0-or-later · https://github.com/juncha9/npm.concos

Usage
  concos                                    Open the interactive menu (terminal)
  concos ui                                 Open registration, status and messages
  concos config [--host <client>]            Open the supported MCP clients list
  concos setup                              Open the same registration form
  concos setup --host <client> [--apply]     Preview user settings; --apply writes them
  concos setup --host claude|codex --hooks on|off [--apply]
                                            Hooks: status, edited files, message reminders
  concos setup --host claude --wake on|off [--apply]
                                            Claude Code only: wake a waiting session for a message to it
  concos setup --host <client> --remove [--apply]
                                            Unregister: remove the concos MCP entry and hooks only
  concos mcp                                Run the MCP bridge over stdio
  concos status [--json]                     Show participants and recent messages
  concos say <to[,to...]|all> <text> [--kind note|question|notice] [--topic <key>]... [--as <name>]
  concos --version

Clients: claude, codex, gemini, cursor, copilot.
One shared waiting room for this user on this computer.
Recipients: agent_id or display name. CONCOS_HOME overrides the local data directory.`;

function writeOutput(text: string): void {
    process.stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);

    if((command == null && process.stdin.isTTY && process.stdout.isTTY) || command == "ui" || command == "config") {
        const { values } = parseArgs({ args: rest, options: {
            host: { type: "string" }, room: { type: "string" }, scope: { type: "string" },
        } });
        if(values.scope != null && values.scope != "user") throw new RoomError("concos uses user-wide registration; remove --scope.");
        const { runMenu } = await import("./modules/cli/menu");
        await runMenu({ input: process.stdin, output: process.stdout, host: values.host, startWithSetup: command == "config" });
        return;
    }

    if(command == "hook") {
        const { runHook } = await import("./modules/hooks/handler");
        await runHook(rest);
        return;
    }

    if(command == "mcp") {
        const { runBridge } = await import("./modules/mcp/bridge");
        const { values } = parseArgs({ args: rest, options: { room: { type: "string" } } });
        await runBridge();
        return;
    }

    if(command == "setup") {
        const { runSetup } = await import("./modules/cli/setup");
        await runSetup(rest);
        return;
    }

    if(command == "status") {
        const { runStatus } = await import("./modules/cli/human-commands");
        const { supportsUnicode } = await import("./modules/cli/prompter");
        const { values } = parseArgs({ args: rest, options: { room: { type: "string" }, json: { type: "boolean" } } });
        const output = await runStatus({
            room: values.room ?? null, json: values.json == true, language: "en",
            columns: process.stdout.columns, color: process.stdout.isTTY == true && process.env.NO_COLOR == null,
            unicode: supportsUnicode(),
        });
        writeOutput(output);
        return;
    }

    if(command == "say") {
        const { runSay } = await import("./modules/cli/human-commands");
        const { values, positionals } = parseArgs({
            args: rest,
            allowPositionals: true,
            options: {
                room: { type: "string" }, kind: { type: "string" }, as: { type: "string" },
                topic: { type: "string", multiple: true },
            },
        });
        const [to, ...words] = positionals;
        if(to == null) {
            throw new RoomError(`${command}: name a recipient (agent_id, display name or all)`);
        }
        let kind: MessageKind = "note";
        const text = words.join(" ");
        if(values.kind != null) {
            if((MESSAGE_KINDS as readonly string[]).includes(values.kind) == false) {
                throw new RoomError(`--kind must be one of ${MESSAGE_KINDS.join(", ")}`);
            }
            kind = values.kind as MessageKind;
        }
        if(text == "") {
            throw new RoomError("say: add the message text after the recipient");
        }
        // several recipients are separated by commas: "Dev / API 01,Dev / API 02"
        const recipients = to.split(",").map((recipient) => recipient.trim()).filter((recipient) => recipient != "");
        const output = await runSay({
            room: values.room ?? null, to: recipients, text: text, kind: kind, senderName: values.as ?? null, language: "en", topics: values.topic ?? [],
        });
        writeOutput(output);
        return;
    }

    if(command == "--version" || command == "-v" || command == "version") {
        writeOutput(CONCOS_VERSION);
        return;
    }

    writeOutput(HELP_TEXT);
    if(command != null && command != "help" && command != "--help" && command != "-h") {
        process.exitCode = 1;
    }
}

main().catch((ex: unknown) => {
    process.exitCode = process.argv[2] == "hook" ? 0 : 1;
    if(process.argv[2] == "hook") process.stdout.write("{}\n");
    if(ex instanceof RoomError) {
        process.stderr.write(`concos: ${ex.message}\n`);
        return;
    }
    // parseArgs rejects unknown options with a TypeError carrying a usage message
    if(ex instanceof TypeError && "code" in ex && String(ex.code).startsWith("ERR_PARSE_ARGS") == true) {
        process.stderr.write(`concos: ${ex.message}\n`);
        return;
    }
    $logger.error(ex, "concos failed");
});

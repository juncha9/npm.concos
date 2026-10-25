import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { applyEdits, getNodeValue, modify, parseTree } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { NODE_FLAGS, SETTINGS_BACKUP_RETENTION_MS, SHARED_ROOM, WAKE_IDLE_MS, WAKE_WATCH_MS } from "../../_defs";
import { getHostAdapter } from "../hooks/adapters";
import type { HookRegistration, HostAdapter } from "../hooks/types";
import { RoomError } from "../store/room-error";
import { HOOK_CLIENTS, MCP_CLIENTS, getMcpClient } from "./clients";

export interface SetupChange {
    path: string;
    before: string | null;
    after: string;
    additions: { key: string; value: unknown }[];
    removals: { key: string; value: unknown }[];
    /** What to know before applying; shown with the preview. */
    notes: string[];
}

export interface HookStatus {
    state: "on" | "partial" | "off";
    present: number;
    expected: number;
}

const HOOK_COMMAND_PREFIX = "concos hook ";
const CODEX_HOOK_TRUST_NOTE = "Codex runs new or changed hooks only after you trust them: open /hooks in Codex.";
export const UPDATED_MESSAGE = "Registration updated. Sessions started from now on use it; restart running sessions to switch.";

/** What a client runs to start concos: the program, and what goes before concos's own arguments. */
interface Launch {
    command: string;
    args: string[];
}

/**
 * Node itself on the cli.js running now, with `NODE_FLAGS`, so no `concos` shim stands in front
 * of each concos process: on Windows that is a cmd.exe (about 4 MB) for every MCP server, and a
 * shell chain for every Claude Code hook. The `concos` command is kept where argv names no built
 * cli.js: run through the link npm makes on macOS and Linux (which node already runs directly, and
 * which follows the active node), from a copy npx unpacked into its cache, or not as the CLI.
 */
function currentLaunch(): Launch {
    const script = process.argv[1] ?? "";
    const builtCli = isConcosScript(script) && fs.existsSync(script);
    if(builtCli == false || script.split(/[\\/]/).includes("_npx")) {
        return { command: "concos", args: [] };
    }
    return { command: process.execPath, args: [...NODE_FLAGS, path.resolve(script)] };
}

const isConcosScript = (file: string) => path.basename(file) == "cli.js" && path.basename(path.dirname(file)) == "dist" && /concos/i.test(file);

/** The concos arguments after node, its flags and a concos cli.js; null when `command` and `args` start something else. */
function directArguments(command: unknown, args: unknown): string[] | null {
    if(typeof command != "string" || /^node(\.exe)?$/i.test(path.basename(command)) == false || Array.isArray(args) == false) {
        return null;
    }
    if(args.every((arg) => typeof arg == "string") == false) {
        return null;
    }
    const words = args as string[];
    const script = words.findIndex((word) => word.startsWith("--") == false);
    if(script < 0 || isConcosScript(words[script]) == false) {
        return null;
    }
    return words.slice(script + 1);
}

/** Whether a handler or server entry starts the way `expected` does: the same command, and the same `args` or none. */
function sameStart(entry: unknown, expected: Record<string, unknown>): boolean {
    const current = entry as { command?: unknown; args?: unknown } | null;
    return current?.command == expected.command && JSON.stringify(current?.args ?? null) == JSON.stringify(expected.args ?? null);
}

/**
 * Whether a registered handler or server entry should become `expected`: it starts otherwise,
 * unless this run can only offer the `concos` command (a copy run through npx) and the entry
 * starts node directly on a node and cli.js that are still there.
 */
function startOutdated(entry: unknown, expected: Record<string, unknown>, launch: Launch): boolean {
    if(sameStart(entry, expected)) {
        return false;
    }
    const current = entry as { command?: unknown; args?: unknown };
    const rest = directArguments(current.command, current.args);
    if(launch.command == "concos" && rest != null) {
        const words = current.args as string[];
        return fs.existsSync(current.command as string) == false || fs.existsSync(words[words.length - rest.length - 1]) == false;
    }
    return true;
}

export interface SetupTarget {
    host: string;
    home?: string;
    /** Accepted by older callers; registration is now user-only. */
    scope?: "project" | "user";
    directory?: string;
}

export const HOST_LABELS: Record<string, string> = Object.fromEntries(MCP_CLIENTS.map((client) => [client.id, client.label]));

/** A settings path under the user's home; Codex and Copilot honor their own home overrides. */
function userPath(input: SetupTarget, relative: string): string {
    if(input.scope == "project") throw new RoomError("concos uses user-wide registration. Remove --scope project and register once for this user.");
    if(input.home == null) {
        const override = input.host == "codex" ? process.env.CODEX_HOME : input.host == "copilot" ? process.env.COPILOT_HOME : undefined;
        if(override) return path.join(path.resolve(override), ...relative.split("/").slice(1));
    }
    return path.join(input.home ?? os.homedir(), relative);
}

export function resolveMcpPath(input: SetupTarget): string {
    return userPath(input, getMcpClient(input.host).userMcp);
}

export function resolveHooksPath(input: SetupTarget): string {
    return userPath(input, hookAdapter(input.host).setup.userHooks);
}

function loadChange(file: string): SetupChange {
    const before = readFile(file);
    return { path: file, before, after: before ?? (file.endsWith(".toml") ? "" : "{}\n"), additions: [], removals: [], notes: [] };
}

function record(value: unknown, label: string): Record<string, any> {
    if(value == null || typeof value != "object" || Array.isArray(value)) throw new RoomError(`${label} must be an object; settings were not changed`);
    return value as Record<string, any>;
}

function readFile(file: string): string | null {
    try {
        if(!fs.lstatSync(file).isFile()) throw new RoomError(`${file} must be a regular file`);
        return fs.readFileSync(file, "utf8");
    }
    catch(ex) {
        if((ex as NodeJS.ErrnoException).code == "ENOENT") return null;
        throw ex;
    }
}

function json(change: SetupChange): Record<string, any> {
    const errors: ParseError[] = [];
    const tree = parseTree(change.after.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
    if(errors.length > 0 || tree == null) throw new RoomError(`${change.path}: invalid JSON; settings were not changed`);
    const nodes = [tree];
    while(nodes.length > 0) {
        const node = nodes.pop()!;
        if(node.type == "object") {
            const keys = new Set<string>();
            for(const property of node.children ?? []) {
                const key: string = property.children![0].value;
                if(keys.has(key)) throw new RoomError(`${change.path}: duplicate JSON key ${JSON.stringify(key)}; settings were not changed`);
                keys.add(key);
            }
        }
        nodes.push(...(node.children ?? []));
    }
    return record(getNodeValue(tree), change.path);
}

/** The indentation a JSON file already uses (its first indented line), so added entries match it. */
function indentationOf(source: string): { insertSpaces: boolean; tabSize: number } {
    const indent = /\n([ \t]+)\S/.exec(source)?.[1];
    if(indent == null) {
        return { insertSpaces: true, tabSize: 2 };
    }
    if(indent.startsWith("\t") == true) {
        return { insertSpaces: false, tabSize: 1 };
    }
    return { insertSpaces: true, tabSize: indent.length };
}

/** Edits one value in place, keeping comments, layout and indentation; `insert` adds an array element at that index. */
function editJson(change: SetupChange, keys: (string | number)[], value: unknown, insert = false): void {
    const bom = change.after.startsWith("\uFEFF") ? "\uFEFF" : "";
    const source = change.after.slice(bom.length);
    change.after = bom + applyEdits(source, modify(source, keys, value, {
        formattingOptions: { ...indentationOf(source), eol: change.after.includes("\r\n") ? "\r\n" : "\n" },
        isArrayInsertion: insert,
    }));
}

function setJson(change: SetupChange, keys: (string | number)[], value: unknown, insert = false): void {
    editJson(change, keys, value, insert);
    change.additions.push({ key: keys.join("."), value });
}

/** `value` is what was there, for the preview. */
function removeJson(change: SetupChange, keys: (string | number)[], value: unknown): void {
    editJson(change, keys, undefined);
    change.removals.push({ key: keys.join("."), value });
}

/** Reads only concos metadata for the menu, never another server's environment or credentials. */
export function inspectSetup(input: SetupTarget): { registered: boolean; room: string | null } {
    const adapter = getMcpClient(input.host);
    const file = loadChange(resolveMcpPath(input));
    const registered = hasRegistration(file, adapter.mcpFormat);
    return { registered, room: registered ? SHARED_ROOM : null };
}

function compatibleServer(entry: unknown): boolean {
    if(entry == null || typeof entry != "object" || Array.isArray(entry)) return false;
    const server = entry as Record<string, unknown>;
    if(Object.hasOwn(server, "url") || (Object.hasOwn(server, "type") && server.type != "stdio")) return false;
    // node started on a concos cli.js directly, as registration writes it since 2026-10-26
    if(server.command != "concos") {
        return JSON.stringify(directArguments(server.command, server.args)) == JSON.stringify(["mcp"]);
    }
    if(!Array.isArray(server.args) || server.args[0] != "mcp") return false;
    return server.args.length == 1 || (server.args.length == 3 && server.args[1] == "--room" && typeof server.args[2] == "string");
}

/** The server entry for `launch`. */
function serverEntry(launch: Launch): { command: string; args: string[] } {
    return { command: launch.command, args: [...launch.args, "mcp"] };
}

/** Inspection and registration must agree about conflicts, including null or malformed entries. */
function hasRegistration(file: SetupChange, format: "json" | "toml"): boolean {
    let data: Record<string, any>;
    if(format == "toml") {
        try { data = parseToml(file.after); }
        catch { throw new RoomError(`${file.path}: invalid TOML; settings were not changed`); }
    }
    else data = json(file);
    const key = format == "toml" ? "mcp_servers" : "mcpServers";
    const servers = data[key] === undefined ? {} : record(data[key], `${file.path}: ${key}`);
    if(!Object.hasOwn(servers, "concos")) return false;
    if(!compatibleServer(servers.concos)) throw new RoomError(`${file.path}: ${key}.concos already exists with different settings`);
    return true;
}

const isRecord = (value: unknown): value is Record<string, any> => value != null && typeof value == "object" && Array.isArray(value) == false;

/** The fields concos reads or writes in a hook handler, and their types. */
const HANDLER_FIELDS = [["type", "string"], ["command", "string"], ["timeout", "number"], ["async", "boolean"], ["asyncRewake", "boolean"]] as const;

/** `inspectSettings` for one file: `servers` checks its MCP server list, `hooks` its hooks section. */
function settingsProblems(file: string, parts: { servers: boolean; hooks: boolean }): string[] {
    const toml = file.endsWith(".toml");
    let data: Record<string, any>;
    try {
        const change = loadChange(file);
        if(toml == true) {
            try { data = parseToml(change.after); }
            catch { return [`${file}: invalid TOML`]; }
        }
        else data = json(change);
    }
    catch(ex) {
        if((ex instanceof RoomError) == false) throw ex;
        return [ex.message.replace(/; settings were not changed$/, "")];
    }
    const problems: string[] = [];
    const check = (valid: boolean, key: string, shape: string) => {
        if(valid == false) problems.push(`${file}: ${key} must be ${shape}`);
        return valid;
    };
    const objectShape = toml ? "a table" : "an object";
    if(parts.servers == true) {
        const key = toml ? "mcp_servers" : "mcpServers";
        if(data[key] !== undefined && check(isRecord(data[key]), key, objectShape)) {
            for(const [name, server] of Object.entries(data[key])) check(isRecord(server), `${key}.${name}`, objectShape);
        }
        // Codex also reads hooks from config.toml
        if(toml == true && data.hooks !== undefined) check(isRecord(data.hooks), "hooks", objectShape);
    }
    if(parts.hooks == true && data.hooks !== undefined && check(isRecord(data.hooks), "hooks", objectShape)) {
        for(const [event, groups] of Object.entries(data.hooks)) {
            if(check(Array.isArray(groups), `hooks.${event}`, "a list") == false) continue;
            (groups as unknown[]).forEach((value, groupIndex) => {
                const at = `hooks.${event}[${groupIndex}]`;
                if(check(isRecord(value), at, "an object") == false) return;
                const group = value as Record<string, any>;
                if(group.matcher !== undefined) check(typeof group.matcher == "string", `${at}.matcher`, "a string");
                if(check(Array.isArray(group.hooks), `${at}.hooks`, "a list") == false) return;
                (group.hooks as unknown[]).forEach((entry, handlerIndex) => {
                    if(check(isRecord(entry), `${at}.hooks[${handlerIndex}]`, "an object") == false) return;
                    const handler = entry as Record<string, any>;
                    for(const [field, type] of HANDLER_FIELDS) {
                        if(handler[field] !== undefined) check(typeof handler[field] == type, `${at}.hooks[${handlerIndex}].${field}`, `a ${type}`);
                    }
                    // a Claude Code handler in exec form
                    if(handler.args !== undefined) {
                        check(Array.isArray(handler.args) && handler.args.every((arg: unknown) => typeof arg == "string"), `${at}.hooks[${handlerIndex}].args`, "a list of strings");
                    }
                });
            });
        }
    }
    return problems;
}

/**
 * What keeps concos from using a client's settings, one `<file>: <problem>` line each: a file
 * that does not parse or repeats a key, or an MCP server list or hooks section in another shape
 * than concos reads and writes. Other settings are not checked; concos keeps them byte for byte.
 */
export function inspectSettings(input: SetupTarget): string[] {
    const mcpPath = resolveMcpPath(input);
    const hooksPath = (HOOK_CLIENTS as readonly string[]).includes(input.host) ? resolveHooksPath(input) : null;
    const problems = settingsProblems(mcpPath, { servers: true, hooks: hooksPath == mcpPath });
    if(hooksPath != null && hooksPath != mcpPath) {
        problems.push(...settingsProblems(hooksPath, { servers: false, hooks: true }));
    }
    return problems;
}

const SHOWN_PROBLEMS = 10;

/** Refuses a client `inspectSettings` finds problems in, before anything is planned or written. */
export function ensureUsableSettings(input: SetupTarget): void {
    const problems = inspectSettings(input);
    if(problems.length == 0) {
        return;
    }
    const label = HOST_LABELS[input.host] ?? input.host;
    const shown = problems.slice(0, SHOWN_PROBLEMS);
    if(problems.length > shown.length) {
        shown.push(`…and ${problems.length - shown.length} more`);
    }
    throw new RoomError([
        `${label} settings need fixing before concos can use them:`,
        ...shown.map((line) => `  ${line}`),
        `concos changed nothing. Fix the file, then try ${label} again.`,
    ].join("\n"));
}

/** Builds the complete change without writing. Existing commands and comments are retained. */
export function planSetup(input: SetupTarget & { room?: string }): SetupChange[] {
    const adapter = getMcpClient(input.host);
    const config = adapter;
    const mcpFile = loadChange(resolveMcpPath(input));
    if(hasRegistration(mcpFile, config.mcpFormat)) return [];
    const server: Record<string, unknown> = serverEntry(currentLaunch());
    // Codex does not pass CONCOS_HOME to MCP servers, while its hooks receive it: a moved data
    // folder has to be named here, or MCP and hooks would use different databases
    if(config.id == "codex" && process.env.CONCOS_HOME) {
        server.env = { CONCOS_HOME: path.resolve(process.env.CONCOS_HOME) };
    }
    if(config.mcpFormat == "toml") {
        appendTomlServer(mcpFile, server);
    }
    else {
        setJson(mcpFile, ["mcpServers", "concos"], adapter.id == "copilot" ? { ...server, tools: ["*"] }
            : adapter.id == "cursor" ? { type: "stdio", ...server } : server);
    }
    return mcpFile.additions.length > 0 ? [mcpFile] : [];
}

/** Appends `[mcp_servers.concos]` to a TOML change, in the file's line endings so a CRLF file does not turn mixed. */
function appendTomlServer(change: SetupChange, server: Record<string, unknown>): void {
    const eol = change.after.includes("\r\n") ? "\r\n" : "\n";
    const table = stringifyToml({ mcp_servers: { concos: server } }).replace(/\r?\n/g, eol);
    change.after += `${change.after.endsWith("\n") || change.after == "" ? "" : eol}${eol}${table}`;
    // Inline tables and dotted keys can make an appended table invalid; fail before any writes.
    try { parseToml(change.after); }
    catch { throw new RoomError(`${change.path}: cannot append concos to this TOML layout; add the server table manually`); }
    change.additions.push({ key: "mcp_servers.concos", value: server });
}

/** A line naming the concos server table, `[mcp_servers.concos]`, or with `subTable` one under it. */
function concosTableHeader(line: string, subTable: boolean): boolean {
    const name = String.raw`\[\s*mcp_servers\s*\.\s*(?:concos|"concos"|'concos')\s*`;
    return new RegExp(subTable ? `^\\s*${name}\\.` : `^\\s*${name}\\]\\s*(?:#.*)?$`).test(line);
}

/**
 * Takes the `[mcp_servers.concos]` table, its sub-tables and the blank line registration put
 * before it out of a TOML file, line by line so every other byte stays. Comments and blank lines
 * right above the next table belong to that table and stay. The result must parse to the same
 * settings minus concos, or nothing changes: a server written as an inline table or dotted keys
 * is left for the user to remove.
 */
function removeTomlTable(change: SetupChange, value: unknown): void {
    const lines = change.after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const text = (line: string) => line.replace(/\r?\n$/, "");
    const manual = new RoomError(`${change.path}: cannot take concos out of this TOML layout; remove the [mcp_servers.concos] table by hand`);
    const start = lines.findIndex((line) => concosTableHeader(text(line), false));
    if(start < 0) {
        throw manual;
    }
    let end = start + 1;
    while(end < lines.length && (/^\s*\[/.test(text(lines[end])) == false || concosTableHeader(text(lines[end]), true))) {
        end += 1;
    }
    // comments and blank lines just above the next table are that table's
    if(end < lines.length) {
        while(end > start + 1 && /^\s*(#.*)?$/.test(text(lines[end - 1]))) {
            end -= 1;
        }
    }
    let from = start;
    if(from > 0 && text(lines[from - 1]).trim() == "") {
        from -= 1;
    }
    const after = [...lines.slice(0, from), ...lines.slice(end)].join("");
    // an mcp_servers left empty and one that is gone read the same
    const withoutEmptyServers = (data: Record<string, any>) => {
        if(data.mcp_servers != null && Object.keys(data.mcp_servers).length == 0) delete data.mcp_servers;
        return data;
    };
    const expected = parseToml(change.after) as Record<string, any>;
    delete expected.mcp_servers.concos;
    let parsed: Record<string, any>;
    try { parsed = parseToml(after) as Record<string, any>; }
    catch { throw manual; }
    if(JSON.stringify(withoutEmptyServers(parsed)) != JSON.stringify(withoutEmptyServers(expected))) {
        throw manual;
    }
    change.after = after;
    change.removals.push({ key: "mcp_servers.concos", value: value });
}

/**
 * Builds the change that takes concos out of a client, without writing: its MCP server entry,
 * and for Claude Code and Codex every concos hook, idle wake included. Only what concos would
 * have written goes: a server named concos that runs something else is refused, and everything
 * around ours stays.
 */
export function planUnregister(input: SetupTarget): SetupChange[] {
    const adapter = getMcpClient(input.host);
    const changes: SetupChange[] = [];
    const mcpFile = loadChange(resolveMcpPath(input));
    const key = adapter.mcpFormat == "toml" ? "mcp_servers" : "mcpServers";
    let data: Record<string, any>;
    if(adapter.mcpFormat == "toml") {
        try { data = parseToml(mcpFile.after); }
        catch { throw new RoomError(`${mcpFile.path}: invalid TOML; settings were not changed`); }
    }
    else data = json(mcpFile);
    const servers = data[key] === undefined ? {} : record(data[key], `${mcpFile.path}: ${key}`);
    if(Object.hasOwn(servers, "concos") == true) {
        if(compatibleServer(servers.concos) == false) {
            throw new RoomError(`${mcpFile.path}: ${key}.concos runs something else, so it was left as it is`);
        }
        if(adapter.mcpFormat == "toml") removeTomlTable(mcpFile, servers.concos);
        else removeJson(mcpFile, [key, "concos"], servers.concos);
        changes.push(mcpFile);
    }
    if((HOOK_CLIENTS as readonly string[]).includes(input.host) == false) {
        return changes;
    }
    changes.push(...planHooks(input, "off"));
    return changes;
}

function hookAdapter(host: string) {
    if(!(HOOK_CLIENTS as readonly string[]).includes(host)) {
        throw new RoomError(`Hooks are available for ${HOOK_CLIENTS.join(", ")}.`);
    }
    return getHostAdapter(host);
}

/**
 * One concos handler in its own group, so each handler keeps its own trust. Claude Code starts a
 * handler with `args` itself, with no shell (exec form, checked on 2.1.310), so node starts
 * directly; Codex runs every hook in the session's shell (PowerShell, cmd or sh), where only the
 * plain `concos` command reads the same.
 */
function hookEntry(adapter: HostAdapter, registration: HookRegistration, launch = currentLaunch()) {
    const words = ["hook", registration.kind, "--host", adapter.id];
    const handler: Record<string, unknown> = { type: "command" };
    if(adapter.id == "claude" && launch.command != "concos") {
        handler.command = launch.command;
        handler.args = [...launch.args, ...words];
    }
    else {
        handler.command = `concos ${words.join(" ")}`;
    }
    if(registration.timeout != null) {
        handler.timeout = registration.timeout;
    }
    if(registration.async == true) {
        handler.async = true;
    }
    if(registration.asyncRewake == true) {
        handler.asyncRewake = true;
    }
    const group: Record<string, unknown> = {};
    if(registration.matcher != null) {
        group.matcher = registration.matcher;
    }
    group.hooks = [handler];
    return { event: registration.event, kind: registration.kind, handler: handler, group: group };
}

/** What concos registers for one client. */
function expectedHooks(host: string) {
    const adapter = hookAdapter(host);
    return adapter.registrations.map((registration) => hookEntry(adapter, registration));
}

/** The idle wake handler for a client that can wake a waiting session. */
function expectedWake(host: string) {
    const adapter = hookAdapter(host);
    if(adapter.wake == null) {
        const clients = HOOK_CLIENTS.filter((id) => getHostAdapter(id).wake != null).map((id) => HOST_LABELS[id]);
        throw new RoomError(`Idle wake is available for ${clients.join(" and ")}.`);
    }
    return hookEntry(adapter, adapter.wake);
}

/**
 * The event a concos hook handler runs (`hook <kind>`), in any form: `concos hook …`, also an
 * older one (e.g. with --room), or node started directly on a concos cli.js. Null for any other handler.
 */
function concosHookKind(handler: unknown): string | null {
    const current = handler as { command?: unknown; args?: unknown } | null;
    let words = directArguments(current?.command, current?.args);
    if(words == null && typeof current?.command == "string" && current.command.startsWith(HOOK_COMMAND_PREFIX) == true) {
        words = current.command.split(/\s+/).slice(1);
    }
    if(words == null || words[0] != "hook" || words[1] == null) {
        return null;
    }
    return words[1];
}

/** A concos hook handler; with `kind`, one for that event. */
function isConcosHandler(handler: unknown, kind?: string): boolean {
    const found = concosHookKind(handler);
    return found != null && (kind == null || found == kind);
}

function handlersOf(group: unknown): unknown[] {
    const handlers = (group as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(handlers) ? handlers : [];
}

function hookLists(data: Record<string, any>, file: string): Record<string, unknown[]> {
    const hooks = data.hooks == null ? {} : record(data.hooks, `${file} hooks`);
    for(const [event, groups] of Object.entries(hooks)) {
        if(!Array.isArray(groups)) throw new RoomError(`${file}: hooks.${event} must be a list; settings were not changed`);
    }
    return hooks as Record<string, unknown[]>;
}

/** Codex also reads hooks from config.toml; concos hooks there and in hooks.json would run twice. */
function concosHooksInCodexConfig(input: SetupTarget): boolean {
    let parsed: Record<string, any>;
    try {
        parsed = parseToml(loadChange(resolveMcpPath(input)).after);
    }
    catch {
        return false;
    }
    const hooks = parsed.hooks == null || typeof parsed.hooks != "object" ? {} : parsed.hooks;
    // `hooks.state` holds Codex's trust records, not hooks
    return Object.values(hooks).some((groups) => Array.isArray(groups)
        && groups.some((group) => handlersOf(group).some((handler) => isConcosHandler(handler))));
}

/**
 * Removes the handlers `matches` picks, and the groups and event lists that become empty, from
 * the end so earlier indexes stay valid. Returns whether a handler kept after a removed one
 * moved up, which makes Codex ask for its trust again.
 */
function removeHandlers(change: SetupChange, hooks: Record<string, unknown[]>, matches: (handler: unknown) => boolean): boolean {
    let shifted = false;
    for(const [event, groups] of Object.entries(hooks)) {
        // matching handlers per group; a group of only those goes as a whole
        const ours = groups.map((group) => handlersOf(group).filter(matches).length);
        const onlyOurs = (index: number) => ours[index] > 0 && ours[index] == handlersOf(groups[index]).length;
        if(ours.every((count) => count == 0)) {
            continue;
        }
        if(groups.every((_, index) => onlyOurs(index))) {
            removeJson(change, ["hooks", event], groups);
            continue;
        }
        let keptAfter = false;
        for(let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex -= 1) {
            if(onlyOurs(groupIndex)) {
                removeJson(change, ["hooks", event, groupIndex], groups[groupIndex]);
                shifted ||= keptAfter;
                continue;
            }
            const handlers = handlersOf(groups[groupIndex]);
            let keptHandlerAfter = false;
            for(let handlerIndex = handlers.length - 1; handlerIndex >= 0; handlerIndex -= 1) {
                if(matches(handlers[handlerIndex]) == false) {
                    keptHandlerAfter = true;
                    continue;
                }
                removeJson(change, ["hooks", event, groupIndex, "hooks", handlerIndex], handlers[handlerIndex]);
                shifted ||= keptHandlerAfter;
            }
            keptAfter = true;
        }
    }
    return shifted;
}

/** Reads only concos entries; other hooks are neither shown nor changed. A handler in an older form counts; `planUpdate` rewrites it. */
export function inspectHooks(input: SetupTarget): HookStatus {
    const expected = expectedHooks(input.host);
    const file = loadChange(resolveHooksPath(input));
    const hooks = hookLists(json(file), file.path);
    const present = expected.filter((item) => (hooks[item.event] ?? [])
        .some((group) => handlersOf(group).some((handler) => isConcosHandler(handler, item.kind)))).length;
    let state: HookStatus["state"] = "partial";
    if(present == expected.length) {
        state = "on";
    }
    else if(present == 0) {
        state = "off";
    }
    return { state: state, present: present, expected: expected.length };
}

/**
 * Builds the hook change without writing.
 *
 * Turning on adds each missing concos handler at the end of its event's list: Codex records trust
 * by list position and command, so inserting earlier would make the user trust their own hooks
 * again. An older concos command for the same event is rewritten where it stands. Turning off
 * removes concos handlers and the groups and event lists that become empty.
 */
export function planHooks(input: SetupTarget, mode: "on" | "off"): SetupChange[] {
    const change = loadChange(resolveHooksPath(input));
    if(mode == "on") {
        if(inspectSetup(input).registered == false) {
            throw new RoomError("Register concos MCP for this client before turning on hooks.");
        }
        addHooks(change, input);
    }
    else {
        // every concos handler, the idle wake included
        const shifted = removeHandlers(change, hookLists(json(change), change.path), (handler) => isConcosHandler(handler));
        if(shifted && input.host == "codex") {
            change.notes.push("Hooks listed after the removed ones move up; Codex will ask you to trust them again in /hooks.");
        }
    }
    return change.additions.length + change.removals.length > 0 ? [change] : [];
}

/** Whether the client can wake a waiting session. */
export function hasWake(host: string): boolean {
    return hookAdapter(host).wake != null;
}

export function inspectWake(input: SetupTarget): boolean {
    const item = expectedWake(input.host);
    const file = loadChange(resolveHooksPath(input));
    return (hookLists(json(file), file.path)[item.event] ?? [])
        .some((group) => handlersOf(group).some((handler) => isConcosHandler(handler, item.kind)));
}

/**
 * Idle wake, kept apart from the other hooks: it goes on only over hooks that are
 * on, and turning hooks off removes it too.
 */
export function planWake(input: SetupTarget, mode: "on" | "off"): SetupChange[] {
    const item = expectedWake(input.host);
    const change = loadChange(resolveHooksPath(input));
    if(mode == "on") {
        if(inspectHooks(input).state != "on") {
            throw new RoomError("Turn on hooks before idle wake.");
        }
        addWake(change, input);
    }
    else {
        const shifted = removeHandlers(change, hookLists(json(change), change.path), (handler) => isConcosHandler(handler, "watch"));
        if(shifted && input.host == "codex") {
            change.notes.push("Hooks listed after the removed ones move up; Codex will ask you to trust them again in /hooks.");
        }
    }
    return change.additions.length + change.removals.length > 0 ? [change] : [];
}

/** Adds each missing concos hook handler to `change`, the client's hooks file, as `planHooks` describes. */
function addHooks(change: SetupChange, input: SetupTarget): void {
    if(input.host == "codex" && concosHooksInCodexConfig(input)) {
        throw new RoomError(`${resolveMcpPath(input)} already has concos hooks; keep those, or remove them before turning hooks on here.`);
    }
    const before = change.additions.length;
    for(const item of expectedHooks(input.host)) {
        const groups = hookLists(json(change), change.path)[item.event];
        if(groups == null) {
            setJson(change, ["hooks", item.event], [item.group]);
            continue;
        }
        if(groups.some((group) => handlersOf(group).some((handler) => sameStart(handler, item.handler)))) {
            continue;
        }
        const groupIndex = groups.findIndex((group) => handlersOf(group).some((handler) => isConcosHandler(handler, item.kind)));
        if(groupIndex >= 0) {
            const handlerIndex = handlersOf(groups[groupIndex]).findIndex((handler) => isConcosHandler(handler, item.kind));
            setJson(change, ["hooks", item.event, groupIndex, "hooks", handlerIndex], item.handler);
            continue;
        }
        setJson(change, ["hooks", item.event, groups.length], item.group, true);
    }
    if(change.additions.length > before && input.host == "codex") {
        change.notes.push(CODEX_HOOK_TRUST_NOTE);
    }
    if(change.additions.length > before && input.host == "claude") {
        change.notes.push("Claude Code runs them in folders you have trusted.");
    }
}

/** Adds the idle wake handler to `change`, the client's hooks file, after the other hooks; an older form is rewritten where it stands. */
function addWake(change: SetupChange, input: SetupTarget): void {
    const item = expectedWake(input.host);
    const groups = hookLists(json(change), change.path)[item.event] ?? [];
    if(groups.some((group) => handlersOf(group).some((handler) => sameStart(handler, item.handler)))) {
        return;
    }
    const groupIndex = groups.findIndex((group) => handlersOf(group).some((handler) => isConcosHandler(handler, item.kind)));
    if(groupIndex >= 0) {
        const handlerIndex = handlersOf(groups[groupIndex]).findIndex((handler) => isConcosHandler(handler, item.kind));
        setJson(change, ["hooks", item.event, groupIndex, "hooks", handlerIndex], item.handler);
        return;
    }
    setJson(change, ["hooks", item.event, groups.length], item.group, true);
    change.notes.push(
        `A waiting ${HOST_LABELS[input.host]} session wakes by itself when a question, an answer to its question, or a note or notice addressed to it arrives: `
        + `after ${WAKE_IDLE_MS / 1000} seconds without input, for up to ${WAKE_WATCH_MS / 60_000} minutes after each turn.`
        + (input.host == "codex" ? " concos sends one line to that session with codex queue to wake it." : ""),
    );
    if(input.host == "codex" && change.notes.includes(CODEX_HOOK_TRUST_NOTE) == false) {
        change.notes.push(CODEX_HOOK_TRUST_NOTE);
    }
}

/**
 * Everything a client gets at once, in one preview: MCP unless it is already registered, the
 * hooks for Claude Code and Codex, and with `wake` their idle wake. The hooks and idle
 * wake share one change, since both go into the hooks file.
 */
export function planRegistration(input: SetupTarget, options: { wake: boolean }): SetupChange[] {
    if(options.wake == true) expectedWake(input.host);
    const changes = inspectSetup(input).registered ? [] : planSetup(input);
    if((HOOK_CLIENTS as readonly string[]).includes(input.host) == false) {
        return changes;
    }
    const hooks = loadChange(resolveHooksPath(input));
    addHooks(hooks, input);
    if(options.wake == true) {
        addWake(hooks, input);
    }
    if(hooks.additions.length > 0) {
        changes.push(hooks);
    }
    return changes;
}

/**
 * Brings what is registered to the way this CLI registers now (`currentLaunch`): the MCP server
 * entry, and each concos hook handler rewritten where it stands. Adds nothing missing, so hooks
 * turned off stay off. Empty when the registration is up to date or there is none.
 */
export function planUpdate(input: SetupTarget): SetupChange[] {
    const adapter = getMcpClient(input.host);
    const launch = currentLaunch();
    const changes: SetupChange[] = [];
    const mcpFile = loadChange(resolveMcpPath(input));
    if(hasRegistration(mcpFile, adapter.mcpFormat) == false) {
        return changes;
    }
    const key = adapter.mcpFormat == "toml" ? "mcp_servers" : "mcpServers";
    const data = adapter.mcpFormat == "toml" ? parseToml(mcpFile.after) as Record<string, any> : json(mcpFile);
    const server = data[key].concos as Record<string, unknown>;
    const expected = serverEntry(launch);
    if(startOutdated(server, expected, launch)) {
        // the entry keeps what else it has (env, tools, type)
        const updated = { ...server, ...expected };
        if(adapter.mcpFormat == "toml") {
            removeTomlTable(mcpFile, server);
            appendTomlServer(mcpFile, updated);
        }
        else {
            mcpFile.removals.push({ key: `${key}.concos`, value: server });
            setJson(mcpFile, [key, "concos"], updated);
        }
        changes.push(mcpFile);
    }
    if((HOOK_CLIENTS as readonly string[]).includes(input.host) == false) {
        return changes;
    }
    const wake = hookAdapter(input.host).wake;
    const targets = new Map<string, Record<string, unknown>>(expectedHooks(input.host).map((item) => [item.kind, item.handler]));
    if(wake != null) {
        targets.set(wake.kind, expectedWake(input.host).handler);
    }
    const hooksFile = loadChange(resolveHooksPath(input));
    for(const [event, groups] of Object.entries(hookLists(json(hooksFile), hooksFile.path))) {
        groups.forEach((group, groupIndex) => {
            handlersOf(group).forEach((handler, handlerIndex) => {
                const target = targets.get(concosHookKind(handler) ?? "");
                if(target == null || startOutdated(handler, target, launch) == false) {
                    return;
                }
                hooksFile.removals.push({ key: `hooks.${event}.${groupIndex}.hooks.${handlerIndex}`, value: handler });
                setJson(hooksFile, ["hooks", event, groupIndex, "hooks", handlerIndex], target);
            });
        });
    }
    if(hooksFile.additions.length > 0) {
        if(input.host == "codex") {
            hooksFile.notes.push(CODEX_HOOK_TRUST_NOTE);
        }
        changes.push(hooksFile);
    }
    return changes;
}

function verifyUnchanged(file: string, expected: string | null): void {
    if(readFile(file) !== expected) throw new RoomError(`${file} changed since preview; run setup again`);
}

/** Publishes complete contents, checking again after writing the temporary file. */
function replaceSettings(file: string, before: string | null, after: string, replaced?: () => void): void {
    const temporary = `${file}.concos-mcp-tmp-${randomUUID()}`;
    try {
        fs.writeFileSync(temporary, after, { encoding: "utf8", flag: "wx", mode: before == null ? 0o600 : fs.statSync(file).mode });
        verifyUnchanged(file, before);
        if(before == null) {
            // Unlike rename, linking a new file cannot overwrite a file created after the check.
            try { fs.linkSync(temporary, file); }
            catch(ex) {
                if((ex as NodeJS.ErrnoException).code == "EEXIST") throw new RoomError(`${file} changed since preview; run setup again`);
                throw ex;
            }
        }
        else fs.renameSync(temporary, file);
        replaced?.();
    }
    finally { fs.rmSync(temporary, { force: true }); }
}

/**
 * Copies a settings file to `<file>.concos-mcp-backup-<UTC time>`, the time format of the
 * database backups, so the newest sorts last; `-2`, `-3`, … follow when that name is taken.
 * The copy never overwrites an existing file.
 */
function backupSettings(file: string, stamp: string): void {
    for(let attempt = 1; ; attempt += 1) {
        const target = `${file}.concos-mcp-backup-${stamp}${attempt == 1 ? "" : `-${attempt}`}`;
        try {
            fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
            return;
        }
        catch(ex) {
            if((ex as NodeJS.ErrnoException).code != "EEXIST") throw ex;
        }
    }
}

/**
 * What follows a settings file's name in a concos backup of it: `.concos-mcp-backup-<UTC time>`
 * with `-2`, `-3`, … for a taken name (groups: date, hours, minutes, seconds, milliseconds,
 * attempt), or `.concos-backup-<uuid>` as concos named them before 0.1.7 (no groups).
 */
const SETTINGS_BACKUP_SUFFIX = /^\.concos-mcp-backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-(\d+))?$|^\.concos-backup-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/**
 * Keeps one concos backup of each settings file, the newest, until it is
 * `SETTINGS_BACKUP_RETENTION_MS` old (2026-10-26 user decision). A backup is a full copy of the
 * file, so it keeps other servers' secrets after the file itself dropped them. A backup's time is
 * the one in its name; one named before 0.1.7 has none, so its file time stands in. Files that only
 * look like backups stay, and one that cannot be removed is left for the next pass.
 */
export function pruneSettingsBackups(files: string[], nowMs: number = Date.now()): void {
    for(const file of new Set(files)) {
        const directory = path.dirname(file);
        const name = path.basename(file);
        let entries: string[];
        try { entries = fs.readdirSync(directory); }
        catch { continue; }
        const backups: { entry: string; timeMs: number; attempt: number }[] = [];
        for(const entry of entries) {
            if(entry.startsWith(name) == false) continue;
            const match = SETTINGS_BACKUP_SUFFIX.exec(entry.slice(name.length));
            if(match == null) continue;
            if(match[1] != null) {
                backups.push({ entry, timeMs: Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`), attempt: Number(match[6] ?? 1) });
                continue;
            }
            try { backups.push({ entry, timeMs: fs.statSync(path.join(directory, entry)).mtimeMs, attempt: 1 }); }
            catch {
                // removed by someone else since the listing
            }
        }
        backups.sort((left, right) => right.timeMs - left.timeMs || right.attempt - left.attempt);
        backups.forEach((backup, index) => {
            if(index == 0 && nowMs - backup.timeMs < SETTINGS_BACKUP_RETENTION_MS) return;
            try { fs.rmSync(path.join(directory, backup.entry), { force: true }); }
            catch {
                // open in another program; the next pass removes it
            }
        });
    }
}

/** Never writes a settings file that concos itself could not read back. */
function verifyReadable(change: SetupChange): void {
    if(change.path.endsWith(".toml")) {
        try { parseToml(change.after); }
        catch { throw new RoomError(`${change.path}: the change would not be valid TOML; settings were not changed`); }
        return;
    }
    json(change);
}

/** Verifies the preview and that every result reads back, backs up originals, and replaces each file atomically. */
export function applySetup(changes: SetupChange[]): void {
    for(const change of changes) {
        verifyUnchanged(change.path, change.before);
        verifyReadable(change);
    }
    // one time for every file this change touches, so its backups read as one set
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const applied: SetupChange[] = [];
    try {
        for(const change of changes) {
            verifyUnchanged(change.path, change.before);
            fs.mkdirSync(path.dirname(change.path), { recursive: true });
            if(change.before != null) backupSettings(change.path, stamp);
            replaceSettings(change.path, change.before, change.after, () => applied.push(change));
        }
    }
    catch(ex) {
        const recovery: string[] = [];
        for(const change of applied.reverse()) {
            try {
                if(readFile(change.path) !== change.after) {
                    recovery.push(`${change.path}: newer settings kept`);
                    continue;
                }
                if(change.before == null) fs.rmSync(change.path);
                else replaceSettings(change.path, change.after, change.before);
            }
            catch(error) { recovery.push(`${change.path}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        if(recovery.length > 0) throw new RoomError(`${ex instanceof Error ? ex.message : String(ex)}\nSome files could not be restored; original backups were kept:\n${recovery.join("\n")}`);
        throw ex;
    }
    // only after every file is written: a failed apply keeps all backups for recovery
    pruneSettingsBackups(changes.map((change) => change.path));
}

function writeChanges(changes: SetupChange[]): void {
    for(const change of changes) {
        let text = `${change.path}\n`;
        if(change.additions.length > 0) {
            text += `${JSON.stringify(change.additions, null, 2)}\n`;
        }
        if(change.removals.length > 0) {
            text += `Remove\n${JSON.stringify(change.removals, null, 2)}\n`;
        }
        for(const note of change.notes) {
            text += `${note}\n`;
        }
        process.stdout.write(text);
    }
}

export async function runSetup(args: string[]): Promise<void> {
    const { values } = parseArgs({ args, options: {
        host: { type: "string" }, room: { type: "string" }, scope: { type: "string", default: "user" }, apply: { type: "boolean" },
        hooks: { type: "string" }, wake: { type: "string" }, remove: { type: "boolean" },
    } });
    if(values.scope != "user") throw new RoomError("concos uses user-wide registration. Remove --scope and register once for this user.");
    // unregister: the MCP entry and every concos hook, nothing else
    if(values.remove == true) {
        if(values.host == null) throw new RoomError("--remove needs --host <client>.");
        const target = { host: values.host };
        ensureUsableSettings(target);
        const removal = planUnregister(target);
        if(removal.length == 0) {
            process.stdout.write(`concos is not registered for ${HOST_LABELS[values.host] ?? values.host}.\n`);
            return;
        }
        writeChanges(removal);
        if(values.apply) {
            applySetup(removal);
            process.stdout.write("Removed concos from this client. Existing files were saved as .concos-mcp-backup-*.\n");
        }
        else process.stdout.write("Preview only. Add --apply to remove concos from this client.\n");
        return;
    }
    // hooks, or idle wake on top of them; turning either on brings what it
    // stands on (MCP, and the hooks for idle wake) in the same preview
    const toggle = values.wake != null
        ? { option: "--wake", name: "idle wake", mode: values.wake, wake: true, plan: planWake, alreadyOn: "Idle wake is already on.", nothingOn: "Idle wake is not on." }
        : values.hooks != null
            ? { option: "--hooks", name: "hooks", mode: values.hooks, wake: false, plan: planHooks, alreadyOn: "concos hooks are already on.", nothingOn: "There are no concos hooks to remove." }
            : null;
    if(toggle != null) {
        if(toggle.mode != "on" && toggle.mode != "off") throw new RoomError(`${toggle.option} must be on or off.`);
        const target = { host: values.host ?? "" };
        // naming the client first gives an unknown one the hooks message, not the MCP one
        resolveHooksPath(target);
        ensureUsableSettings(target);
        let toggleChanges: SetupChange[];
        if(toggle.mode == "on") toggleChanges = planRegistration(target, { wake: toggle.wake });
        else toggleChanges = toggle.plan(target, toggle.mode);
        if(toggleChanges.length == 0) {
            process.stdout.write(`${toggle.mode == "on" ? toggle.alreadyOn : toggle.nothingOn}\n`);
            return;
        }
        writeChanges(toggleChanges);
        const registering = toggleChanges.some((change) => change.path == resolveMcpPath(target));
        if(values.apply) {
            applySetup(toggleChanges);
            const done = registering ? `Registered MCP and turned ${toggle.name} on` : `Turned ${toggle.name} ${toggle.mode}`;
            process.stdout.write(`${done}. Existing files were saved as .concos-mcp-backup-*.\n`);
        }
        else process.stdout.write(`Preview only. Add --apply to ${registering ? "register MCP and " : ""}turn ${toggle.name} ${toggle.mode}.\n`);
        return;
    }
    if(values.host == null && !values.apply) {
        const { runMenu } = await import("./menu");
        await runMenu({ input: process.stdin, output: process.stdout, startWithSetup: true });
        return;
    }
    ensureUsableSettings({ host: values.host ?? "" });
    const changes = planSetup({ host: values.host ?? "" });
    if(changes.length == 0) {
        // registered: bring an older form to the current one
        const update = planUpdate({ host: values.host ?? "" });
        if(update.length == 0) {
            process.stdout.write("concos MCP is already registered.\n");
            return;
        }
        writeChanges(update);
        if(values.apply) {
            applySetup(update);
            process.stdout.write(`${UPDATED_MESSAGE} Existing files were saved as .concos-mcp-backup-*.\n`);
        }
        else process.stdout.write("Preview only. Add --apply to update the registration.\n");
        return;
    }
    writeChanges(changes);
    if(values.apply) {
        applySetup(changes);
        process.stdout.write("MCP registered. Existing files were saved as .concos-mcp-backup-*. Enable concos MCP in your client, then open a new session.\n");
    }
    else if(currentLaunch().command == "concos") process.stdout.write("Preview only. Add --apply to register MCP. The installed concos command must be on PATH.\n");
    else process.stdout.write("Preview only. Add --apply to register MCP.\n");
}

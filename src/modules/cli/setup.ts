import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { applyEdits, getNodeValue, modify, parseTree } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { SHARED_ROOM, WAKE_HOURLY_LIMIT, WAKE_IDLE_MS, WAKE_WATCH_MS } from "../../_defs";
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
    if(server.command != "concos" || !Array.isArray(server.args) || server.args[0] != "mcp") return false;
    return server.args.length == 1 || (server.args.length == 3 && server.args[1] == "--room" && typeof server.args[2] == "string");
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

/** Builds the complete change without writing. Existing commands and comments are retained. */
export function planSetup(input: SetupTarget & { room?: string }): SetupChange[] {
    const adapter = getMcpClient(input.host);
    const config = adapter;
    const mcpFile = loadChange(resolveMcpPath(input));
    if(hasRegistration(mcpFile, config.mcpFormat)) return [];
    const server: Record<string, unknown> = { command: "concos", args: ["mcp"] };
    // Codex does not pass CONCOS_HOME to MCP servers, while its hooks receive it: a moved data
    // folder has to be named here, or MCP and hooks would use different databases
    if(config.id == "codex" && process.env.CONCOS_HOME) {
        server.env = { CONCOS_HOME: path.resolve(process.env.CONCOS_HOME) };
    }
    if(config.mcpFormat == "toml") {
        // the appended table keeps the file's line endings, so a CRLF file does not turn mixed
        const eol = mcpFile.after.includes("\r\n") ? "\r\n" : "\n";
        const table = stringifyToml({ mcp_servers: { concos: server } }).replace(/\r?\n/g, eol);
        mcpFile.after += `${mcpFile.after.endsWith("\n") || mcpFile.after == "" ? "" : eol}${eol}${table}`;
        // Inline tables and dotted keys can make an appended table invalid; fail before any writes.
        try { parseToml(mcpFile.after); }
        catch { throw new RoomError(`${mcpFile.path}: cannot append concos to this TOML layout; add the server table manually`); }
        mcpFile.additions.push({ key: "mcp_servers.concos", value: server });
    }
    else {
        setJson(mcpFile, ["mcpServers", "concos"], adapter.id == "copilot" ? { ...server, tools: ["*"] }
            : adapter.id == "cursor" ? { type: "stdio", ...server } : server);
    }
    return mcpFile.additions.length > 0 ? [mcpFile] : [];
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
 * around ours stays. A hooks file concos cannot edit safely is left alone while the MCP entry
 * still goes, with a note saying why.
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
    try {
        changes.push(...planHooks(input, "off"));
    }
    catch(ex) {
        if((ex instanceof RoomError) == false || changes.length == 0) {
            throw ex;
        }
        changes[0].notes.push(`Hooks were left in place, and their file untouched: ${ex.message.replace(/; settings were not changed$/, "")}.`);
    }
    return changes;
}

function hookAdapter(host: string) {
    if(!(HOOK_CLIENTS as readonly string[]).includes(host)) {
        throw new RoomError(`Hooks are available for ${HOOK_CLIENTS.join(", ")}.`);
    }
    return getHostAdapter(host);
}

/** One concos handler in its own group, so each handler keeps its own trust. */
function hookEntry(adapter: HostAdapter, registration: HookRegistration) {
    const command = `${HOOK_COMMAND_PREFIX}${registration.kind} --host ${adapter.id}`;
    const handler: Record<string, unknown> = { type: "command", command: command };
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
    return { event: registration.event, kind: registration.kind, command: command, handler: handler, group: group };
}

/** What concos registers for one client. */
function expectedHooks(host: string) {
    const adapter = hookAdapter(host);
    return adapter.registrations.map((registration) => hookEntry(adapter, registration));
}

/** The idle wake handler, for the one client that can wake a waiting session. */
function expectedWake(host: string) {
    const adapter = hookAdapter(host);
    if(adapter.wake == null) {
        throw new RoomError("Idle wake is available for Claude Code only.");
    }
    return hookEntry(adapter, adapter.wake);
}

const commandOf = (handler: unknown) => (handler as { command?: unknown } | null)?.command;

/** A concos hook handler; with `kind`, one for that event, in any older form (e.g. with --room). */
function isConcosHandler(handler: unknown, kind?: string): boolean {
    const command = (handler as { command?: unknown } | null)?.command;
    if(typeof command != "string" || command.startsWith(HOOK_COMMAND_PREFIX) == false) {
        return false;
    }
    return kind == null || command.startsWith(`${HOOK_COMMAND_PREFIX}${kind} `);
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

/** Reads only concos entries; other hooks are neither shown nor changed. */
export function inspectHooks(input: SetupTarget): HookStatus {
    const expected = expectedHooks(input.host);
    const file = loadChange(resolveHooksPath(input));
    const hooks = hookLists(json(file), file.path);
    const present = expected.filter((item) => (hooks[item.event] ?? [])
        .some((group) => handlersOf(group).some((handler) => commandOf(handler) == item.command))).length;
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

/** Whether the client can wake a waiting session (Claude Code). */
export function hasWake(host: string): boolean {
    return hookAdapter(host).wake != null;
}

export function inspectWake(input: SetupTarget): boolean {
    const item = expectedWake(input.host);
    const file = loadChange(resolveHooksPath(input));
    return (hookLists(json(file), file.path)[item.event] ?? [])
        .some((group) => handlersOf(group).some((handler) => commandOf(handler) == item.command));
}

/**
 * Claude Code idle wake, kept apart from the other hooks: it goes on only over hooks that are
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
        removeHandlers(change, hookLists(json(change), change.path), (handler) => isConcosHandler(handler, "watch"));
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
        if(groups.some((group) => handlersOf(group).some((handler) => commandOf(handler) == item.command))) {
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
        change.notes.push("Codex runs new or changed hooks only after you trust them: open /hooks in Codex.");
    }
    if(change.additions.length > before && input.host == "claude") {
        change.notes.push("Claude Code runs them in folders you have trusted.");
    }
}

/** Adds the idle wake handler to `change`, the client's hooks file, after the other hooks. */
function addWake(change: SetupChange, input: SetupTarget): void {
    const item = expectedWake(input.host);
    const groups = hookLists(json(change), change.path)[item.event] ?? [];
    if(groups.some((group) => handlersOf(group).some((handler) => commandOf(handler) == item.command))) {
        return;
    }
    setJson(change, ["hooks", item.event, groups.length], item.group, true);
    change.notes.push(
        `A waiting Claude Code session wakes by itself when a question for it, or an answer to its question, arrives: `
        + `after ${WAKE_IDLE_MS / 1000} seconds without input, at most ${WAKE_HOURLY_LIMIT} times an hour, `
        + `for up to ${WAKE_WATCH_MS / 60_000} minutes after each turn. Codex sessions do not wake.`,
    );
}

/**
 * Everything a client gets at once, in one preview: MCP unless it is already registered, the
 * hooks for Claude Code and Codex, and with `wake` Claude Code's idle wake. The hooks and idle
 * wake share one change, since both go into the hooks file. With `skipBrokenHooks`, a hooks file
 * concos cannot edit safely (invalid, duplicate keys, an odd shape) is left alone and MCP is still
 * registered, with a note saying why; otherwise that stops the whole plan.
 */
export function planRegistration(input: SetupTarget, options: { wake: boolean; skipBrokenHooks: boolean }): SetupChange[] {
    const changes = inspectSetup(input).registered ? [] : planSetup(input);
    if((HOOK_CLIENTS as readonly string[]).includes(input.host) == false) {
        return changes;
    }
    let hooks: SetupChange;
    try {
        hooks = loadChange(resolveHooksPath(input));
        addHooks(hooks, input);
        if(options.wake == true) {
            addWake(hooks, input);
        }
    }
    catch(ex) {
        if(options.skipBrokenHooks == false || (ex instanceof RoomError) == false || changes.length == 0) {
            throw ex;
        }
        changes[0].notes.push(`Hooks were left out, and their file untouched: ${ex.message.replace(/; settings were not changed$/, "")}. Fix it, then turn hooks on from this client's row.`);
        return changes;
    }
    if(hooks.additions.length > 0) {
        changes.push(hooks);
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
    const applied: SetupChange[] = [];
    try {
        for(const change of changes) {
            verifyUnchanged(change.path, change.before);
            fs.mkdirSync(path.dirname(change.path), { recursive: true });
            if(change.before != null) fs.copyFileSync(change.path, `${change.path}.concos-mcp-backup-${randomUUID()}`, fs.constants.COPYFILE_EXCL);
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
    // hooks, or Claude Code's idle wake on top of them; turning either on brings what it
    // stands on (MCP, and the hooks for idle wake) in the same preview
    const toggle = values.wake != null
        ? { option: "--wake", name: "idle wake", mode: values.wake, wake: true, plan: planWake, alreadyOn: "Idle wake is already on.", nothingOn: "Idle wake is not on." }
        : values.hooks != null
            ? { option: "--hooks", name: "hooks", mode: values.hooks, wake: false, plan: planHooks, alreadyOn: "concos hooks are already on.", nothingOn: "There are no concos hooks to remove." }
            : null;
    if(toggle != null) {
        if(toggle.mode != "on" && toggle.mode != "off") throw new RoomError(`${toggle.option} must be on or off.`);
        const target = { host: values.host ?? "" };
        let toggleChanges: SetupChange[];
        if(toggle.mode == "on") {
            // naming the client first gives an unknown one the hooks message, not the MCP one
            resolveHooksPath(target);
            toggleChanges = planRegistration(target, { wake: toggle.wake, skipBrokenHooks: false });
        }
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
    const changes = planSetup({ host: values.host ?? "" });
    if(changes.length == 0) {
        process.stdout.write("concos MCP is already registered.\n");
        return;
    }
    writeChanges(changes);
    if(values.apply) {
        applySetup(changes);
        process.stdout.write("MCP registered. Existing files were saved as .concos-mcp-backup-*. Enable concos MCP in your client, then open a new session.\n");
    }
    else process.stdout.write("Preview only. Add --apply to register MCP. The installed concos command must be on PATH.\n");
}

import type { Readable, Writable } from "node:stream";
import { MAX_MESSAGE_LENGTH, MAX_RECIPIENTS } from "../../_defs";
import { RoomError } from "../store/room-error";
import { normalizeTopics } from "../store/room-store";
import { readRoomOverviews, runSay } from "./human-commands";
import { showRoomBoard } from "./room-board";
import { participantName } from "./status-renderer";
import { Prompter, PromptBackError, PromptClosedError, supportsUnicode } from "./prompter";
import type { SelectItem } from "./prompter";
import { HOOK_CLIENTS, MCP_CLIENTS, getMcpClient } from "./clients";
import { applySetup, ensureUsableSettings, hasWake, HOST_LABELS, inspectHooks, inspectSettings, inspectSetup, inspectWake, planHooks, planRegistration, planSetup, planUnregister, planUpdate, planWake, pruneSettingsBackups, resolveHooksPath, resolveMcpPath, UPDATED_MESSAGE } from "./setup";
import type { SetupChange, SetupTarget } from "./setup";
import { checkForSelfUpdate, showSelfUpdate } from "./self-update";
import type { AvailableUpdate, SelfUpdateOptions } from "./self-update";

export interface MenuOptions {
    input: Readable;
    output: Writable;
    home?: string;
    host?: string;
    startWithSetup?: boolean;
    /** Registry and npm discovery overrides for isolated tests; false skips the lookup. */
    selfUpdate?: SelfUpdateOptions | false;
}

type SetupDraft = SetupTarget;

const hasHooks = (host: string) => (HOOK_CLIENTS as readonly string[]).includes(host);

function hookSummary(draft: SetupTarget): string {
    try {
        const hooks = inspectHooks(draft);
        if(hooks.state == "partial") {
            return `Hooks ${hooks.present}/${hooks.expected}`;
        }
        if(hasWake(draft.host) && inspectWake(draft)) {
            return `Hooks ${hooks.state} · Wake on`;
        }
        return `Hooks ${hooks.state}`;
    }
    catch { return "Hooks need attention"; }
}

function registrationSummary(draft: SetupTarget): { hint: string; hintStatus?: "success"; hintWarning?: string } {
    try {
        if(inspectSettings(draft).length > 0) {
            return { hint: "Settings file needs fixing" };
        }
        const status = inspectSetup(draft);
        if(status.registered == false) {
            return { hint: "Not registered" };
        }
        // in yellow after the green status, so a registration that works still shows it can be updated
        const update = planUpdate(draft).length > 0 ? { hintWarning: "Update available" } : {};
        if(hasHooks(draft.host) == false) {
            return { hint: "MCP registered", hintStatus: "success", ...update };
        }
        return { hint: `MCP registered · ${hookSummary(draft)}`, hintStatus: "success", ...update };
    }
    catch { return { hint: "Configuration needs attention" }; }
}

function previewChanges(prompter: Prompter, changes: SetupChange[]): void {
    const writeEntries = (title: string, path: string, entries: { key: string; value: unknown }[]) => {
        prompter.write(`\n${title}\n\n  ${path}\n`);
        for(const entry of entries) {
            prompter.write(`  ${entry.key}\n`);
            prompter.write(`${JSON.stringify(entry.value, null, 2).split("\n").map((line) => `    ${line}`).join("\n")}\n`);
        }
    };
    for(const change of changes) {
        if(change.additions.length > 0) writeEntries("Settings to add", change.path, change.additions);
        if(change.removals.length > 0) writeEntries("Settings to remove", change.path, change.removals);
        for(const note of change.notes) prompter.write(`\n${note}\n`);
    }
    prompter.write("\nExisting configuration files will be backed up before applying.\n");
}

/**
 * Hooks for a client whose MCP is registered, and idle wake on top of
 * them: each turned on or off after a preview.
 */
async function editHooks(prompter: Prompter, draft: SetupDraft): Promise<void> {
    const label = HOST_LABELS[draft.host];
    const hooks = inspectHooks(draft);
    const canWake = hasWake(draft.host);
    const wakeOn = canWake && inspectWake(draft);
    prompter.write("Hooks come on with the first registration and can be turned off here.\n"
        + "They record this client's working and waiting status and edited files,\n"
        + "and at the end of a turn remind the agent once about unread questions sent to it.\n");
    if(canWake) {
        prompter.write("Idle wake wakes a waiting session by itself when a message addressed to it arrives.\n");
    }
    const items: SelectItem<"on" | "off" | "wake-on" | "wake-off" | "remove" | "back">[] = [];
    if(hooks.state != "on") {
        items.push({ value: "on", label: "Turn on hooks", hint: hooks.state == "partial" ? `${hooks.present} of ${hooks.expected} are on` : undefined });
    }
    if(hooks.state != "off") {
        items.push({ value: "off", label: "Turn off hooks" });
    }
    if(canWake && hooks.state == "on" && wakeOn == false) {
        items.push({ value: "wake-on", label: "Turn on idle wake" });
    }
    if(wakeOn) {
        items.push({ value: "wake-off", label: "Turn off idle wake" });
    }
    items.push({ value: "remove", label: "Unregister concos", hint: "MCP entry and hooks" });
    items.push({ separator: true }, { value: "back", label: "Back" });
    const action = await prompter.select(`${label} · Hooks`, items, { cancelValue: "back" });
    if(action == "back") return;

    const steps = {
        "on": { plan: () => planHooks(draft, "on"), question: "Turn on these hooks?", done: `Hooks turned on for ${label}.` },
        "off": { plan: () => planHooks(draft, "off"), question: "Remove these hooks?", done: `Hooks turned off for ${label}.` },
        "wake-on": { plan: () => planWake(draft, "on"), question: "Turn on idle wake?", done: `Idle wake turned on for ${label}.` },
        "wake-off": { plan: () => planWake(draft, "off"), question: "Remove idle wake?", done: `Idle wake turned off for ${label}.` },
        "remove": { plan: () => planUnregister(draft), question: "Remove concos from this client?", done: `concos removed from ${label}.` },
    };
    await applyStep(prompter, steps[action]);
}

/** A registered client without hooks: it can only be unregistered. */
async function editRegistered(prompter: Prompter, draft: SetupDraft): Promise<void> {
    const label = HOST_LABELS[draft.host];
    const action = await prompter.select(`${label} · Registered`, [
        { value: "remove", label: "Unregister concos", hint: "MCP entry" },
        { separator: true },
        { value: "back", label: "Back" },
    ], { cancelValue: "back" });
    if(action == "back") return;
    await applyStep(prompter, { plan: () => planUnregister(draft), question: "Remove concos from this client?", done: `concos removed from ${label}.` });
}

/** Previews a settings change, applies it once confirmed, and reports. */
async function applyStep(prompter: Prompter, step: { plan: () => SetupChange[]; question: string; done: string }): Promise<void> {
    const changes = step.plan();
    previewChanges(prompter, changes);
    if(!await prompter.askYesNo(step.question, false)) return;
    applySetup(changes);
    prompter.write(`\n${step.done}\n`);
    await prompter.pause();
}

async function editSetup(prompter: Prompter, draft: SetupDraft): Promise<void> {
    // the list comes back where it was drawn, not below the client's page it returns from
    const top = prompter.mark();
    for(;;) {
        try {
            prompter.eraseTo(top);
            prompter.write("\nUser-wide registration · One shared waiting room\n");
            const host = await prompter.select("MCP · Registration", [
                ...MCP_CLIENTS.map((adapter) => ({
                    value: adapter.id, label: HOST_LABELS[adapter.id],
                    ...registrationSummary({ ...draft, host: adapter.id }),
                })),
                { separator: true },
                { value: "back", label: "Back" },
            ], { defaultValue: draft.host, cancelValue: "back" });
            if(host == "back") return;
            draft.host = host;
            // settings concos cannot read as they should are reported here, and the client does not open
            ensureUsableSettings(draft);
            // a first registration brings the hooks and idle wake in the same preview;
            // a registered client changes them from its hooks menu, so hooks turned off stay off
            let changes = planSetup(draft);
            if(changes.length > 0 && hasHooks(draft.host)) {
                changes = planRegistration(draft, { wake: hasWake(draft.host) });
            }
            if(changes.length == 0) {
                // registered in an older way: offered once each time the client is opened
                const update = planUpdate(draft);
                if(update.length > 0) {
                    prompter.write("\nThis registration can be updated to how this concos starts now.\n");
                    previewChanges(prompter, update);
                    if(await prompter.askYesNo("Update the registration?", false)) {
                        applySetup(update);
                        prompter.write(`\n${UPDATED_MESSAGE}\n`);
                        await prompter.pause();
                        continue;
                    }
                }
                else {
                    prompter.write("\nThis client already has the same registration.\n");
                }
                if(hasHooks(draft.host)) {
                    await editHooks(prompter, draft);
                }
                else {
                    await editRegistered(prompter, draft);
                }
                continue;
            }
            previewChanges(prompter, changes);
            // choosing an unregistered client already asks for it; Enter goes on with the preview just shown
            if(!await prompter.askYesNo("Register these settings?", true)) continue;
            applySetup(changes);
            let registered = "MCP";
            if(hasHooks(draft.host) && changes.some((change) => change.path == resolveHooksPath(draft))) {
                registered = hasWake(draft.host) && inspectWake(draft) ? "MCP, hooks and idle wake" : "MCP and hooks";
            }
            prompter.write(`\n${registered} registered for ${HOST_LABELS[draft.host]}.\n`);
            prompter.write("Available across your projects. Enable concos MCP in your client, then start a task in a new session.\n");
            await prompter.pause();
        }
        catch(error) {
            if(error instanceof PromptClosedError) throw error;
            if(error instanceof PromptBackError) continue;
            prompter.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
            await prompter.pause();
        }
    }
}

async function showStatus(prompter: Prompter, options: MenuOptions): Promise<void> {
    const output = options.output as Writable & { isTTY?: boolean; columns?: number };
    const input = options.input as Readable & { isTTY?: boolean };
    await showRoomBoard(prompter, {
        language: "en", columns: output.columns,
        color: input.isTTY == true && output.isTTY == true && process.env.NO_COLOR == null,
        unicode: supportsUnicode(),
        send: (agentId) => sendFromMenu(prompter, agentId),
    });
}

/** The board's send flow: `presetTo` skips the recipient list, for sends started from an agent's detail view. */
async function sendFromMenu(prompter: Prompter, presetTo?: string): Promise<void> {
    const room = (await readRoomOverviews())[0];
    // ended sessions are not offered: nothing reads their messages unless the session comes back
    const activeAgents = (room?.agents ?? []).filter((agent) => !agent.human && !agent.left && !agent.ended);
    if(presetTo == null && activeAgents.length == 0) {
        if(room == null || !room.agents.some((agent) => !agent.human)) {
            prompter.write("\nNo agents have joined yet. Register MCP, then start a task in your client.\n");
        }
        else {
            prompter.write("\nNo agent is active right now. Ended sessions are on the Agents tab, under Show ended sessions.\n");
        }
        await prompter.pause();
        return;
    }
    const agentRow = (agent: (typeof activeAgents)[number]): SelectItem<string> => ({
        value: agent.agent_id, label: agent.name, hint: `${agent.client} · ${agent.agent_id} · ${agent.online ? agent.status : "offline"}`,
    });
    const nameOf = (agentId: string) => {
        const agent = room?.agents.find((agent) => agent.agent_id == agentId);
        return agent == null ? agentId : participantName(agent.name, agent.client, agent.human);
    };
    // "all", or the agent ids picked
    let to: string[] = [];
    if(presetTo != null) {
        to = [presetTo];
    }
    else {
        const recipients: SelectItem<string>[] = [{ value: "all", label: "All agents", hint: "Posted for reference" }];
        if(activeAgents.length > 1) {
            recipients.push({ value: "several", label: "Several agents", hint: "Pick them one by one" });
        }
        recipients.push(...activeAgents.map(agentRow), { separator: true }, { value: "back", label: "Back" });
        const picked = await prompter.select("Recipient", recipients, { cancelValue: "back" });
        if(picked == "back") return;
        if(picked != "several") {
            to = [picked];
        }
        else {
            // one pick per round; a picked agent leaves the list
            while(to.length < Math.min(activeAgents.length, MAX_RECIPIENTS)) {
                const remaining = activeAgents.filter((agent) => to.includes(agent.agent_id) == false);
                const items: SelectItem<string>[] = [...remaining.map(agentRow), { separator: true }];
                if(to.length > 0) {
                    items.push({ value: "done", label: `Done · ${to.length} selected` });
                }
                items.push({ value: "back", label: "Back" });
                const question = to.length == 0 ? "Recipients" : `Recipients · ${to.map(nameOf).join(", ")}`;
                const next = await prompter.select(question, items, { cancelValue: "back" });
                if(next == "back") return;
                if(next == "done") break;
                to.push(next);
            }
        }
    }
    const text = await prompter.askRequired("Message");
    if(text.length > MAX_MESSAGE_LENGTH) throw new RoomError(`Message must contain at most ${MAX_MESSAGE_LENGTH} characters.`);
    // A mistyped topic is asked again instead of dropping the text already typed.
    let topics: string[] = [];
    for(;;) {
        const typed = await prompter.ask("Topics (snake_case, comma-separated; Enter for none)");
        try {
            topics = normalizeTopics(typed.split(","));
            break;
        }
        catch(error) {
            if(!(error instanceof RoomError)) throw error;
            prompter.write(`  ${error.message}\n`);
        }
    }
    let recipientLabel = "All agents";
    if(to.includes("all") == false) {
        recipientLabel = to.map((agentId) => `${nameOf(agentId)} (${agentId})`).join(", ");
    }
    let summary = `\nRecipient: ${recipientLabel}\nText: ${text}\n`;
    if(topics.length > 0) {
        summary += `Topics: ${topics.join(", ")}\n`;
    }
    prompter.write(summary);
    if(!await prompter.askYesNo("Send this message?", false)) return;
    prompter.write(`\n${await runSay({ room: room?.room ?? null, to, text, kind: "note", senderName: null, language: "en", topics })}\n\n`);
    await prompter.pause();
}

/** Keyboard menu and line-mode equivalent; setting previews always precede writes. */
export async function runMenu(options: MenuOptions): Promise<void> {
    if(options.host != null) getMcpClient(options.host);
    // backups of a client nobody registers again expire here, not only when concos writes its settings
    pruneSettingsBackups(MCP_CLIENTS.flatMap((client) => {
        const target = { host: client.id, home: options.home };
        if(hasHooks(client.id)) return [resolveMcpPath(target), resolveHooksPath(target)];
        return [resolveMcpPath(target)];
    }));
    const draft: SetupDraft = { host: options.host ?? "codex", home: options.home };
    const prompter = new Prompter(options.input, options.output);
    let selected: "setup" | "status" | "update" | "quit" = "status";
    let startWithSetup = options.startWithSetup ?? false;
    let update: AvailableUpdate | null | undefined;
    const top = prompter.mark();
    try {
        for(;;) {
            try {
                prompter.eraseTo(top);
                if(!startWithSetup && update === undefined) {
                    update = options.selfUpdate === false ? null : await checkForSelfUpdate(options.selfUpdate);
                }
                // the board first, where the cursor starts: registering is done once (2026-10-26 user decision)
                const action: "setup" | "status" | "update" | "quit" = startWithSetup ? "setup" : await prompter.select("concos · Shared waiting room", [
                    { value: "status", label: "Enter concos", hint: "Agents · Messages" },
                    { value: "setup", label: "Register MCP", hint: "Set up once for this user" },
                    ...(update != null ? [{ value: "update" as const, label: "Update concos", hint: `${update.currentVersion} → ${update.latestVersion}` }] : []),
                    { separator: true },
                    { value: "quit", label: "Quit" },
                ], { defaultValue: selected, cancelValue: "quit" });
                startWithSetup = false;
                if(action == "quit") return;
                selected = action;
                if(action == "setup") await editSetup(prompter, draft);
                else if(action == "status") await showStatus(prompter, options);
                else if(action == "update") {
                    if(update != null && await showSelfUpdate(prompter, update, options.selfUpdate || undefined)) return;
                }
            }
            catch(error) {
                if(error instanceof PromptClosedError) return;
                if(error instanceof PromptBackError) continue;
                prompter.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
                await prompter.pause();
            }
        }
    }
    catch(error) {
        if(!(error instanceof PromptClosedError) && !(error instanceof PromptBackError)) throw error;
    }
    finally { prompter.close(); }
}

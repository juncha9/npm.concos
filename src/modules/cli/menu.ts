import type { Readable, Writable } from "node:stream";
import { MAX_MESSAGE_LENGTH, MAX_RECIPIENTS } from "../../_defs";
import { RoomError } from "../store/room-error";
import { normalizeTopics } from "../store/room-store";
import { readRoomOverviews, runSay } from "./human-commands";
import { showRoomBoard } from "./room-board";
import { participantName } from "./status-renderer";
import type { RoomOverviewAgent } from "../store/room-store";
import { Prompter, PromptBackError, PromptClosedError, supportsUnicode } from "./prompter";
import type { SelectItem } from "./prompter";
import { HOOK_CLIENTS, MCP_CLIENTS, getMcpClient } from "./clients";
import { applySetup, ensureUsableSettings, hasWake, HOST_LABELS, inspectHooks, inspectSettings, inspectSetup, inspectWake, planHooks, planRegistration, planSetup, planUnregister, planUpdate, planWake, pruneSettingsBackups, resolveHooksPath, resolveMcpPath, UPDATED_MESSAGE } from "./setup";
import type { SetupChange, SetupTarget } from "./setup";
import { checkForSelfUpdate, showSelfUpdate } from "./self-update";
import { changedHunks, comparableText, hunkHeader, maskSecrets } from "./settings-diff";
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

/**
 * Each file's change as a diff, removed lines in red and added ones in green (2026-10-26 user
 * request: "git diff처럼, 색깔도"). Only changed lines show, since the lines around them belong to
 * other servers. A summary of the files, the settings they touch and why ends the preview, right
 * above the question, so a long diff cannot push it off the screen (UI review, 2026-10-27).
 */
function previewChanges(prompter: Prompter, changes: SetupChange[]): void {
    const paint = prompter.paint;
    for(const change of changes) {
        prompter.write(`\n${paint.bold(`Changes to ${change.path}`)}\n`);
        const before = comparableText(change.path, change.before ?? "");
        const after = comparableText(change.path, change.after);
        for(const hunk of changedHunks(before.text, after.text)) {
            prompter.write(`  ${paint.accent(hunkHeader(hunk))}\n`);
            for(const line of hunk.lines) {
                if(line.kind == "add") {
                    prompter.write(`  ${paint.success(`+${maskSecrets(line.text)}`)}\n`);
                }
                else {
                    prompter.write(`  ${paint.danger(`-${maskSecrets(line.text)}`)}\n`);
                }
            }
        }
        if(before.formatted == true || after.formatted == true) {
            prompter.write(`${paint.dim("  Both versions shown formatted, one value per line; line numbers are of that form.")}\n`);
        }
    }
    prompter.write(`\n${paint.bold("Summary")}\n`);
    for(const change of changes) {
        const keys = [...new Set([...change.removals, ...change.additions].map((entry) => entry.key))];
        let line = `  ${change.path}`;
        if(keys.length > 0) {
            line += paint.dim(` · ${keys.join(" · ")}`);
        }
        prompter.write(`${line}\n`);
    }
    for(const note of changes.flatMap((change) => change.notes)) {
        prompter.write(`\n${note}\n`);
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

/** An answer started from a message's detail: the message answered and the topics it carried. */
interface SendReply {
    messageId: number;
    topics: string[];
}

/** The send form's values. One unsent draft is kept while the menu runs, for the next send opened the same way. */
interface SendDraft {
    /** The source card's agent id, or `reply:<id>` when answering a message. */
    origin: string;
    /** "all", or the agent ids picked */
    to: string[];
    text: string;
    topics: string[];
}

async function showStatus(prompter: Prompter, options: MenuOptions, drafts: { saved: SendDraft | null }): Promise<void> {
    const output = options.output as Writable & { isTTY?: boolean; columns?: number };
    const input = options.input as Readable & { isTTY?: boolean };
    await showRoomBoard(prompter, {
        language: "en", columns: output.columns,
        color: input.isTTY == true && output.isTTY == true && process.env.NO_COLOR == null,
        unicode: supportsUnicode(),
        send: (agentId: string, reply?: SendReply) => sendFromMenu(prompter, drafts, agentId, reply),
    });
}

/** "all", or the agent ids picked one per round; null when the person goes back. */
async function pickRecipients(
    prompter: Prompter,
    activeAgents: RoomOverviewAgent[],
    nameOf: (agentId: string) => string
): Promise<string[] | null> {
    const agentRow = (agent: RoomOverviewAgent): SelectItem<string> => ({
        value: agent.agent_id, label: agent.name, hint: `${agent.client} · ${agent.agent_id} · ${agent.online ? agent.status : "offline"}`,
    });
    // a post is there for reference: saying so here keeps it from reading as a message to everyone
    const recipients: SelectItem<string>[] = [{ value: "all", label: "Post to the room", hint: "Agents see it on check_in; nobody is notified" }];
    if(activeAgents.length > 1) {
        recipients.push({ value: "several", label: "Several agents", hint: "Pick them one by one" });
    }
    recipients.push(...activeAgents.map(agentRow), { separator: true }, { value: "back", label: "Back" });
    const picked = await prompter.select("Recipient", recipients, { cancelValue: "back" });
    if(picked == "back") {
        return null;
    }
    if(picked != "several") {
        return [picked];
    }
    // one pick per round; a picked agent leaves the list
    const to: string[] = [];
    while(to.length < Math.min(activeAgents.length, MAX_RECIPIENTS)) {
        const remaining = activeAgents.filter((agent) => to.includes(agent.agent_id) == false);
        const items: SelectItem<string>[] = [...remaining.map(agentRow), { separator: true }];
        if(to.length > 0) {
            items.push({ value: "done", label: `Done · ${to.length} selected` });
        }
        items.push({ value: "back", label: "Back" });
        const question = to.length == 0 ? "Recipients" : `Recipients · ${to.map(nameOf).join(", ")}`;
        const next = await prompter.select(question, items, { cancelValue: "back" });
        if(next == "back") {
            return null;
        }
        if(next == "done") {
            break;
        }
        to.push(next);
    }
    return to;
}

/**
 * The board's send form: To, Message and Topics with their values, then Send (UI review,
 * 2026-10-27). Picking a row edits it and comes back with the cursor on the next row, so Enter
 * down the list fills the form in order; Esc inside an edit keeps the value. Leaving without
 * sending keeps the draft for the next send opened the same way. `presetTo` fills To, for sends
 * started from an agent's card; `reply` makes the message an answer to the one read.
 */
async function sendFromMenu(prompter: Prompter, drafts: { saved: SendDraft | null }, presetTo: string, reply?: SendReply): Promise<void> {
    const room = (await readRoomOverviews())[0];
    // ended sessions are not offered: nothing reads their messages unless the session comes back
    const activeAgents = (room?.agents ?? []).filter((agent) => !agent.human && !agent.left && !agent.ended);
    const nameOf = (agentId: string) => {
        const agent = room?.agents.find((agent) => agent.agent_id == agentId);
        return agent == null ? agentId : participantName(agent.name, agent.client, agent.human);
    };

    let origin = presetTo;
    if(reply != null) {
        origin = `reply:${reply.messageId}`;
    }
    const fresh: SendDraft = { origin: origin, to: [presetTo], text: "", topics: reply?.topics ?? [] };
    let draft: SendDraft = { ...fresh };
    if(drafts.saved != null && drafts.saved.origin == origin) {
        draft = { ...drafts.saved };
    }
    const changed = () => JSON.stringify(draft) != JSON.stringify(fresh);

    type Row = "to" | "message" | "topics" | "send" | "discard" | "back";
    let cursor: Row = "send";
    if(draft.text === "") {
        cursor = "message";
    }
    if(draft.to.length == 0) {
        cursor = "to";
    }
    // what is wrong with a row, shown on it until the next pick
    let problem: { row: Row; text: string } | null = null;
    const previousTransient = prompter.transient;
    // the form shows every value, so answered edits leave no lines behind
    prompter.transient = true;
    try {
        for(;;) {
            let toHint = "(required)";
            if(draft.to.includes("all")) {
                toHint = "Post to the room";
            }
            else if(draft.to.length > 0) {
                toHint = draft.to.map((agentId) => `${nameOf(agentId)} (${agentId})`).join(", ");
            }
            let textHint = "(required)";
            if(draft.text !== "") {
                textHint = draft.text.length > 60 ? `${draft.text.slice(0, 59)}…` : draft.text;
            }
            // nothing until To is filled: that row already says it is required
            let sendHint = "";
            if(draft.to.length > 0) {
                sendHint = `to ${draft.to.length} agent${draft.to.length == 1 ? "" : "s"}`;
            }
            if(draft.to.includes("all")) {
                sendHint = "Agents see it on check_in; nobody is notified";
            }
            else if(reply != null) {
                sendHint = `as an answer to #${reply.messageId}`;
            }
            const withProblem = (row: Row) => problem?.row == row ? { hintWarning: problem.text } : {};
            const items: SelectItem<Row>[] = [
                { value: "to", label: "To", hint: toHint, ...withProblem("to") },
                { value: "message", label: "Message", hint: textHint, ...withProblem("message") },
                { value: "topics", label: "Topics", hint: draft.topics.length == 0 ? "none" : draft.topics.join(", "), ...withProblem("topics") },
                { separator: true },
                { value: "send", label: draft.to.includes("all") ? "Post" : "Send", hint: sendHint },
            ];
            if(changed() == true) {
                items.push({ value: "discard", label: "Discard draft", hint: "Drops what you entered" });
                items.push({ value: "back", label: "Back", hint: "Keeps the draft for the next send" });
            }
            else {
                items.push({ value: "back", label: "Back" });
            }
            const question = reply != null ? `Answer to #${reply.messageId}` : "New message";
            const row: Row = await prompter.select(question, items, { defaultValue: cursor, cancelValue: "back" });
            problem = null;
            cursor = row;
            if(row == "back") {
                if(changed() == true) {
                    drafts.saved = draft;
                }
                return;
            }
            try {
                if(row == "discard") {
                    if(await prompter.askYesNo("Discard this draft?", false) == true) {
                        if(drafts.saved?.origin == origin) {
                            drafts.saved = null;
                        }
                        return;
                    }
                    cursor = "send";
                }
                else if(row == "to") {
                    const picked = await pickRecipients(prompter, activeAgents, nameOf);
                    if(picked != null) {
                        draft.to = picked;
                        cursor = "message";
                    }
                }
                else if(row == "message") {
                    const typed = await prompter.ask("Message", { initialValue: draft.text });
                    if(typed.length > MAX_MESSAGE_LENGTH) {
                        problem = { row: "message", text: `At most ${MAX_MESSAGE_LENGTH} characters` };
                    }
                    else {
                        draft.text = typed;
                        cursor = "topics";
                    }
                }
                else if(row == "topics") {
                    let question = "Topics (snake_case, comma-separated; clear for none)";
                    if(prompter.isInteractive == false) {
                        question = "Topics (snake_case, comma-separated; - for none)";
                    }
                    const typed = await prompter.ask(question, { initialValue: draft.topics.join(", ") });
                    if(typed == "-" || typed == "") {
                        draft.topics = [];
                    }
                    else if(typed !== "") {
                        draft.topics = normalizeTopics(typed.split(","));
                    }
                    cursor = "send";
                }
                else if(draft.to.length == 0) {
                    problem = { row: "to", text: "Pick who gets it" };
                    cursor = "to";
                }
                else if(draft.text === "") {
                    problem = { row: "message", text: "Write the message" };
                    cursor = "message";
                }
                else {
                    break;
                }
            }
            catch(error) {
                if(error instanceof RoomError) {
                    // a mistyped topic: the form keeps everything entered and says what to fix
                    problem = { row: "topics", text: error.message };
                    continue;
                }
                // Esc inside an edit is one level back: the form, with the value unchanged
                if((error instanceof PromptBackError) == false) {
                    throw error;
                }
            }
        }
    }
    finally {
        prompter.transient = previousTransient;
    }

    const result = await runSay({
        room: room?.room ?? null, to: draft.to, text: draft.text, kind: reply != null ? "reply" : "note",
        senderName: null, language: "en", topics: draft.topics, replyTo: reply?.messageId ?? null,
    });
    if(drafts.saved?.origin == origin) {
        drafts.saved = null;
    }
    prompter.write(`\n${result}\n\n`);
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
    // the send form's unsent draft, kept while the menu runs
    const sendDrafts: { saved: SendDraft | null } = { saved: null };
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
                let action: "setup" | "status" | "update" | "quit" = "setup";
                if(startWithSetup == false) {
                    const previousTransient = prompter.transient;
                    prompter.transient = true;
                    try {
                        action = await prompter.select("concos · Shared waiting room", [
                            { value: "status", label: "Enter concos", hint: "Agents · Messages" },
                            { value: "setup", label: "Register MCP", hint: "Set up once for this user" },
                            ...(update != null ? [{ value: "update" as const, label: "Update concos", hint: `${update.currentVersion} → ${update.latestVersion}` }] : []),
                            { separator: true },
                            { value: "quit", label: "Quit" },
                        ], { defaultValue: selected, cancelValue: "quit" });
                    }
                    finally {
                        prompter.transient = previousTransient;
                    }
                }
                startWithSetup = false;
                if(action == "quit") return;
                selected = action;
                if(action == "setup") await editSetup(prompter, draft);
                else if(action == "status") await showStatus(prompter, options, sendDrafts);
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

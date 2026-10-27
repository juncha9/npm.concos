// Adapted from an in-house MCP tool's terminal interface. Copyright © 2026 Alkemic Studio, the author's
// company, which brings it into concos under concos's license (AGPL-3.0-or-later).
import fs from "node:fs";
import type { Readable, Writable } from "node:stream";

/**
 * Input ended before a prompt was answered — Ctrl+D, Ctrl+C, or a piped script running out.
 * The `config` loop treats it as leaving, not as a failure.
 */
export class PromptClosedError extends Error {
    constructor() {
        super("input closed before the prompt was answered");
        this.name = "PromptClosedError";
    }
}

/**
 * Esc was pressed in a prompt that has no cancel value of its own — "back one level". The
 * caller decides what the level above is: the form puts the setting back as it was, a
 * confirmation returns to the menu that opened it.
 */
export class PromptBackError extends Error {
    constructor() {
        super("esc pressed — back one level");
        this.name = "PromptBackError";
    }
}

export interface SelectChoice<T extends string> {
    value: T;
    label: string;
    /** Text after the label; dimmed unless a status is set. */
    hint?: string;
    /** Completed state: a check mark, with green text on color terminals. */
    hintStatus?: "success";
    /** Text after the hint that asks for attention (e.g. Update available), yellow on color terminals. */
    hintWarning?: string;
    /**
     * Draws the row itself instead of label and hint: one array of styled parts per screen
     * line, each cut to the terminal width. The pointer column is still drawn in front of the
     * first line; `width` is the columns left after it. Line mode prints the same text
     * unstyled. `label` stays what a line-mode answer matches and what an answered prompt shows.
     */
    lines?: (active: boolean, width: number) => LinePart[][];
    /** What a line-mode answer may type besides the number and the label; defaults to `value`. */
    key?: string;
    /**
     * A text field on the row, on a terminal: while the row is active, typed characters (digits and
     * `j`/`k` too) edit `text`; Backspace deletes one, Ctrl+U clears it, and Esc clears it before
     * it goes back. The caller keeps the object, so the text outlives a refresh that rebuilds the
     * items, and reads it when the row is picked. Line mode picks the row as any other.
     */
    input?: { text: string; placeholder?: string };
}

/** A non-selectable divider between groups of choices. */
export interface SelectSeparator {
    separator: true;
    /** Read-only text at this point in the list; ANSI styles and embedded newlines are preserved. */
    lines?: (width: number) => string[];
    /** Group heading in place of the divider rule, with a blank line above it after the first group. */
    label?: string;
    /** Dimmed text after the heading. */
    hint?: string;
    /** Draws the heading inside a rule across the list, `── label · hint ────`, to set groups apart. */
    rule?: boolean;
}

export type SelectItem<T extends string> = SelectChoice<T> | SelectSeparator;

/** One tab of a tabbed list. */
export interface SelectTab<T extends string> {
    value: T;
    label: string;
    /** What a line-mode answer may type to switch to it besides the label; defaults to `value`. */
    key?: string;
    /** Recent activity on this tab, shown with the attention color. */
    attention?: boolean;
}

/** Sibling lists shown as tabs: a bar under the question, the active tab bracketed. */
export interface SelectTabs<T extends string> {
    items: SelectTab<T>[];
    active: T;
}

export interface SelectOptions<T extends string> {
    /** Where the cursor starts, and what Enter picks on an empty line-mode answer. */
    defaultValue?: T;
    /** Returned on Esc. Without it Esc throws `PromptBackError`. */
    cancelValue?: T;
    /**
     * TTY only: reloads the question, items and tabs every `intervalMs` while the list is open.
     * The cursor stays on the same value, and the list redraws only when its lines change.
     */
    refresh?: { intervalMs: number; load: () => { question: string; banner?: LinePart[][]; items: SelectItem<T>[]; tabs?: SelectTabs<T>; preface?: string[] } };
    /** Styled lines under the question, such as status bars; their plain text off a TTY. */
    banner?: LinePart[][];
    /**
     * Detail text before the choices, with ANSI styles and embedded newlines allowed. On a TTY,
     * it wraps to the available columns; PgUp/PgDn and Home/End scroll only this text while the
     * question, choice viewport and footer stay in place. Up/Down still move between choices.
     * Off a TTY the unstyled text precedes the numbered choices.
     */
    preface?: string[];
    /**
     * Tab / → and Shift+Tab / ← finish the list with the next or previous tab's value, so the
     * caller can show that tab's list in its place. Line mode accepts a tab's key or label.
     */
    tabs?: SelectTabs<T>;
    /** Repaints cached visual state between refreshes; it must not reload data. TTY only. */
    animation?: { intervalMs: number; frame: () => { question?: string; tabs?: SelectTabs<T>; preface?: string[] } };
}

/** The subset of `tty.ReadStream` the key-driven prompts need; absent on pipes and in tests. */
interface TtyInput {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
}

/** The subset of `tty.WriteStream` the renderer reads. */
interface TtyOutput {
    isTTY?: boolean;
    columns?: number;
    rows?: number;
}

const ESC = "\u001b";
const KEY_UP = [`${ESC}[A`, `${ESC}OA`, "k"];
const KEY_DOWN = [`${ESC}[B`, `${ESC}OB`, "j"];
const KEY_LEFT = [`${ESC}[D`, `${ESC}OD`];
const KEY_RIGHT = [`${ESC}[C`, `${ESC}OC`];
const KEY_HOME = [`${ESC}[H`, `${ESC}OH`, `${ESC}[1~`];
const KEY_END = [`${ESC}[F`, `${ESC}OF`, `${ESC}[4~`];
const KEY_PAGE_UP = `${ESC}[5~`;
const KEY_PAGE_DOWN = `${ESC}[6~`;
const KEY_DELETE = [`${ESC}[3~`];
const KEY_ENTER = ["\r", "\n"];
const KEY_TAB = "\t";
const KEY_SHIFT_TAB = `${ESC}[Z`;
const KEY_BACKSPACE = ["\u007f", "\b"];
const KEY_CTRL_C = "\u0003";
const KEY_CTRL_D = "\u0004";
const KEY_CTRL_U = "\u0015";

/** Off a TTY, a line holding just the Esc byte — or the word — stands for the Esc key, so scripts can go back. */
const ESCAPE_LINES = [ESC, "ESC"];

const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Splits a raw-mode chunk into keys: one character, or one whole escape sequence. */
function splitKeys(chunk: string): string[] {
    const keys: string[] = [];
    let index = 0;

    while(index < chunk.length) {
        const isSequence = chunk[index] === ESC && (chunk[index + 1] === "[" || chunk[index + 1] === "O");
        if(isSequence == true) {
            let end = index + 2;
            while(end < chunk.length && /[0-9;]/.test(chunk[end]) == true) {
                end += 1;
            }
            keys.push(chunk.slice(index, end + 1));
            index = end + 1;
            continue;
        }

        const codePoint = chunk.codePointAt(index) ?? 0;
        const character = String.fromCodePoint(codePoint);
        keys.push(character);
        index += character.length;
    }

    return keys;
}

/** Terminal columns a code point occupies — two for CJK, Hangul and the wide emoji blocks. */
function charWidth(codePoint: number): number {
    if(codePoint < 0x1100) {
        return 1;
    }

    const isWide = codePoint <= 0x115f
        || codePoint === 0x2329
        || codePoint === 0x232a
        || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
        || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
        || (codePoint >= 0xf900 && codePoint <= 0xfaff)
        || (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
        || (codePoint >= 0xff00 && codePoint <= 0xff60)
        || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
        || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
        || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
        || (codePoint >= 0x20000 && codePoint <= 0x3fffd);

    if(isWide == true) {
        return 2;
    }

    return 1;
}

export function displayWidth(text: string): number {
    let width = 0;
    for(const character of text) {
        width += charWidth(character.codePointAt(0) ?? 0);
    }

    return width;
}

/** Wraps detail text without counting SGR codes as columns or letting a style escape its row. */
function wrapPreface(preface: string[], width: number): string[] {
    const lines: string[] = [];
    for(const text of preface) {
        let style = "";
        for(const source of text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) {
            let line = style;
            let used = 0;
            const finishLine = (): void => {
                let end = "";
                if(style != "") {
                    end = `${ESC}[0m`;
                }
                lines.push(`${line}${end}`);
                line = style;
                used = 0;
            };
            for(const token of source.match(/\u001b\[[0-?]*[ -/]*[@-~]|./gu) ?? []) {
                if(token.startsWith(ESC) == true) {
                    if(token.endsWith("m") == true) {
                        if(token == `${ESC}[m` || token == `${ESC}[0m`) {
                            style = "";
                        }
                        else {
                            style += token;
                        }
                        line += token;
                    }
                    continue;
                }
                if(token < " " || token == "\u007f") {
                    continue;
                }
                const columns = charWidth(token.codePointAt(0) ?? 0);
                if(used > 0 && used + columns > width) {
                    finishLine();
                }
                if(columns > width) {
                    line += "?";
                    used += 1;
                }
                else {
                    line += token;
                    used += columns;
                }
            }
            finishLine();
        }
    }
    return lines;
}

/** Pads with spaces to `width` terminal columns, counting wide characters as two. */
export function padToWidth(text: string, width: number): string {
    const missing = width - displayWidth(text);
    if(missing <= 0) {
        return text;
    }

    return `${text}${" ".repeat(missing)}`;
}

/**
 * Label column width per item, measured within its group — the run of choices between
 * separators. One width for the whole list would push the hints of short action labels
 * ("Quit") out to wherever the longest host row ends.
 */
function groupLabelWidths<T extends string>(items: SelectItem<T>[]): number[] {
    const widths = items.map(() => 0);
    let groupStart = 0;

    for(let index = 0; index <= items.length; index += 1) {
        const atBoundary = index === items.length || "value" in items[index] == false;
        if(atBoundary == false) {
            continue;
        }

        let groupWidth = 0;
        for(let member = groupStart; member < index; member += 1) {
            const item = items[member] as SelectChoice<T>;
            groupWidth = Math.max(groupWidth, displayWidth(item.label));
        }
        for(let member = groupStart; member < index; member += 1) {
            widths[member] = groupWidth;
        }

        groupStart = index + 1;
    }

    return widths;
}

/**
 * Legacy Windows consoles render `❯` / `✔` as boxes; Windows Terminal, the VS Code
 * terminal and every non-Windows terminal draw them. Same rule inquirer's `figures` uses.
 */
export function supportsUnicode(): boolean {
    if(process.platform !== "win32") {
        return true;
    }

    return process.env.WT_SESSION != null
        || process.env.TERM_PROGRAM === "vscode"
        || process.env.TERMINAL_EMULATOR === "JetBrains-JediTerm"
        || process.env.ConEmuTask != null;
}

/** Terminal styles; every function returns its text unchanged off a TTY or under NO_COLOR. */
export interface Style {
    accent(text: string): string;
    success(text: string): string;
    warning(text: string): string;
    danger(text: string): string;
    dim(text: string): string;
    bold(text: string): string;
    /** Swapped foreground and background, for a row that must stand out as a whole. */
    inverse(text: string): string;
}

function createStyle(enabled: boolean): Style {
    const paint = (open: number, close: number) => {
        return (text: string): string => {
            if(enabled == false || text === "") {
                return text;
            }
            return `${ESC}[${open}m${text}${ESC}[${close}m`;
        };
    };

    return {
        accent: paint(36, 39),
        success: paint(32, 39),
        warning: paint(33, 39),
        danger: paint(31, 39),
        dim: paint(2, 22),
        bold: paint(1, 22),
        inverse: paint(7, 27),
    };
}

/** One piece of a rendered line: plain text and the style it is drawn with. */
export interface LinePart {
    text: string;
    paint?: (text: string) => string;
}

/**
 * Prompts over any stream pair, with one `data` listener owning the input.
 *
 * On a TTY, choices are an arrow-key list, text fields are a small line editor of their own,
 * and every answered prompt collapses to a single `✔ question · answer` line, so a view
 * reads as a summary of what was set there. Off a TTY — a pipe, a test, Git Bash's
 * mintty without winpty — every prompt is a plain line read and a list is numbered, which is
 * what lets the whole UI run over scripted stdin.
 *
 * Esc means "back one level" in every prompt: a list returns its cancel value when it has
 * one, everything else throws `PromptBackError` for the caller to handle.
 *
 * One listener instead of `readline`: raw-mode keys and cooked-mode lines would otherwise be
 * seen by two consumers at once.
 */
export class Prompter {
    private readonly timers = new Set<NodeJS.Timeout>();
    private lineBuffer = "";
    private readonly pendingLines: string[] = [];
    private lineWaiter: ((line: string | null) => void) | null = null;
    private inputEnded = false;
    private readonly onInputData = (chunk: string): void => { this.onData(chunk); };
    private readonly onInputEnd = (): void => {
        if(this.lineBuffer != "") {
            this.onData("\n");
        }
        this.inputEnded = true;
        this.lineWaiter?.(null);
        this.lineWaiter = null;
        this.keyHandler?.(KEY_CTRL_D);
    };

    /** Set while a key-driven prompt (select, text, secret) owns the input. */
    private keyHandler: ((key: string) => void) | null = null;

    /**
     * When true, an answered prompt leaves nothing behind on a TTY instead of its
     * `✔ question · answer` line. The settings form sets it: the form itself shows every
     * value, so it can redraw in place rather than scroll a trail of edits.
     */
    transient = false;

    private readonly interactive: boolean;
    /**
     * Rows the lasting output (`write`, answered lines) has moved the cursor down, a long line
     * counting every row it wraps onto; `mark` and `eraseTo` measure from it. Prompts erase
     * themselves and add nothing.
     */
    private writtenRows = 0;
    /** Columns already used on the row being written, when the output so far does not end in a newline. */
    private openRowWidth = 0;
    private readonly style: Style;
    /** `caret`: where typing goes in a row's text field, since the terminal cursor stays hidden in a list. */
    private readonly symbols: { question: string; pointer: string; tick: string; rule: string; ellipsis: string; caret: string };

    constructor(private readonly input: Readable, private readonly output: Writable) {
        const ttyInput = input as TtyInput;
        const ttyOutput = output as TtyOutput;
        this.interactive = ttyInput.isTTY == true && ttyInput.setRawMode != null && ttyOutput.isTTY == true;
        this.style = createStyle(this.interactive == true && process.env.NO_COLOR == null);

        if(supportsUnicode() == true) {
            this.symbols = { question: "?", pointer: "❯", tick: "✔", rule: "─", ellipsis: "…", caret: "▏" };
        }
        else {
            this.symbols = { question: "?", pointer: ">", tick: "√", rule: "-", ellipsis: "...", caret: "_" };
        }

        this.inputEnded = input.readableEnded;
        input.setEncoding("utf8");
        input.on("data", this.onInputData);
        input.on("end", this.onInputEnd);
    }

    /** Stops reading so the process can exit once the command is done. */
    close(): void {
        for(const timer of this.timers) clearInterval(timer);
        this.timers.clear();
        if(this.interactive == true) {
            (this.input as TtyInput).setRawMode?.(false);
            this.output.write(`${ESC}[?25h`);
        }
        this.input.pause();
        this.input.off("data", this.onInputData);
        this.input.off("end", this.onInputEnd);
    }

    write(text: string): void {
        this.output.write(text);
        this.countRows(text);
    }

    /** Where the lasting output stands now, for `eraseTo`. */
    mark(): number {
        return this.writtenRows;
    }

    /**
     * Erases what was written after `mark`, so a list comes back where it was drawn instead of
     * below the views it led to. The cursor cannot climb above the window: rows that scrolled
     * past its top stay in the scrollback, where a long preview can still be read. No-op off a TTY.
     */
    eraseTo(mark: number): void {
        if(this.interactive == false) {
            return;
        }
        const wrappedRows = this.openRowWidth > 0 ? Math.floor((this.openRowWidth - 1) / this.columns()) : 0;
        const rowsUp = this.writtenRows + wrappedRows - mark;
        if(rowsUp <= 0 && this.openRowWidth == 0) {
            return;
        }
        this.output.write(`${rowsUp > 0 ? `${ESC}[${rowsUp}A` : ""}\r${ESC}[J`);
        this.writtenRows = Math.min(this.writtenRows, mark);
        this.openRowWidth = 0;
    }

    /** Adds the rows `text` moves the cursor down, wrapped at the terminal's width, to `writtenRows`. */
    private countRows(text: string): void {
        if(this.interactive == false) {
            return;
        }
        const columns = this.columns();
        const lines = text.replace(ANSI_PATTERN, "").split("\n");
        lines.forEach((line, index) => {
            // a carriage return starts the row over
            const returned = line.lastIndexOf("\r");
            const width = (returned >= 0 ? 0 : this.openRowWidth) + displayWidth(line.slice(returned + 1));
            if(index == lines.length - 1) {
                this.openRowWidth = width;
                return;
            }
            this.writtenRows += Math.max(1, Math.ceil(width / columns));
            this.openRowWidth = 0;
        });
    }

    /**
     * Erases the last `lineCount` lines written above the cursor, so a view shown in between
     * (a detail card) leaves the screen when the list it came from returns. No-op off a TTY,
     * where the transcript is the record.
     */
    eraseLines(lineCount: number): void {
        if(this.interactive == false || lineCount <= 0) {
            return;
        }
        this.output.write(`${ESC}[${lineCount}A\r${ESC}[J`);
        this.writtenRows = Math.max(0, this.writtenRows - lineCount);
        this.openRowWidth = 0;
    }

    /** Styling for callers that print around the prompts; plain text off a TTY. */
    get paint(): Style {
        return this.style;
    }

    get isInteractive(): boolean { return this.interactive; }
    get motionEnabled(): boolean { return this.interactive && process.env.TERM != "dumb" && process.env.CONCOS_REDUCED_MOTION != "1"; }

    /** Keeps a report visible until Enter on a TTY; Esc goes back. Pipes need no extra answer. */
    async pause(): Promise<void> {
        if(this.interactive == false) {
            return;
        }
        if(this.inputEnded == true) {
            throw new PromptClosedError();
        }

        const prompt = this.fitLine([{ text: "Press Enter to continue · Esc to go back", paint: this.style.dim }], this.columns() - 1);
        await this.readAnswer(prompt);
    }

    /**
     * Free-text prompt. A string is an Enter default; `initialValue` is editable on a TTY
     * with the cursor at its end, and an Enter default in line mode.
     *
     * @throws {PromptBackError} On Esc.
     * @throws {PromptClosedError} If the input closes before a line arrives.
     */
    async ask(question: string, value?: string | { initialValue: string }): Promise<string> {
        let defaultValue: string | undefined;
        let initialValue: string | undefined;
        if(typeof value == "string") {
            defaultValue = value;
        }
        else if(value != null) {
            initialValue = value.initialValue;
            if(this.interactive == false) {
                defaultValue = initialValue;
            }
        }
        let suffix = "";
        if(defaultValue != null && defaultValue !== "") {
            suffix = ` ${this.style.dim(`(${defaultValue})`)}`;
        }

        const prompt = `${this.style.accent(this.symbols.question)} ${this.style.bold(question)}${suffix} `;
        const line = await this.readAnswer(prompt, { initialValue });

        let answer = line.trim();
        if(answer === "" && defaultValue != null) {
            answer = defaultValue;
        }

        let shown = answer;
        if(shown === "") {
            shown = this.style.dim("(empty)");
        }
        this.writeAnswered(question, shown);
        return answer;
    }

    /** Like `ask`, re-asking until something non-empty is entered. */
    async askRequired(question: string, defaultValue?: string): Promise<string> {
        for(;;) {
            const answer = await this.ask(question, defaultValue);
            if(answer !== "") {
                return answer;
            }

            this.write(`  ${this.style.dim("A value is required.")}\n`);
        }
    }

    /**
     * Typed `y` / `n`, Enter for the capitalized default.
     *
     * @throws {PromptBackError} On Esc.
     * @throws {PromptClosedError} If the input closes before a line arrives.
     */
    async askYesNo(question: string, defaultValue: boolean): Promise<boolean> {
        // the answer Enter gives stands out in color
        const highlight = (letter: string) => this.style.bold(this.style.accent(letter));
        let hint = `${this.style.dim("(y/")}${highlight("N")}${this.style.dim(")")}`;
        if(defaultValue == true) {
            hint = `${this.style.dim("(")}${highlight("Y")}${this.style.dim("/n)")}`;
        }

        for(;;) {
            const prompt = `${this.style.accent(this.symbols.question)} ${this.style.bold(question)} ${hint} `;
            const line = await this.readAnswer(prompt);

            const normalized = line.trim().toLowerCase();
            let answer: boolean | null = null;
            if(normalized === "") {
                answer = defaultValue;
            }
            else if(normalized === "y" || normalized === "yes") {
                answer = true;
            }
            else if(normalized === "n" || normalized === "no") {
                answer = false;
            }

            if(answer != null) {
                let shown = "no";
                if(answer == true) {
                    shown = "yes";
                }
                this.writeAnswered(question, shown);
                return answer;
            }

            this.write(`  ${this.style.dim("Answer y or n.")}\n`);
        }
    }

    /**
     * Picks one of `items`. On a TTY: ↑/↓ (or k/j) move, 1–9 jump, Enter picks, Esc returns
     * `cancelValue`. Off a TTY: a numbered list, answered by number, key or label.
     *
     * @throws {PromptBackError} On Esc when there is no `cancelValue`.
     * @throws {PromptClosedError} On Ctrl+C or when the input closes.
     */
    async select<T extends string>(question: string, items: SelectItem<T>[], options?: SelectOptions<T>): Promise<T> {
        const choices = items.filter((item): item is SelectChoice<T> => "value" in item);
        if(choices.length === 0) {
            throw new Error("select needs at least one choice");
        }
        if(this.interactive && this.inputEnded) throw new PromptClosedError();

        let startIndex = items.findIndex((item) => "value" in item && item.value === options?.defaultValue);
        if(startIndex < 0) {
            startIndex = items.findIndex((item) => "value" in item);
        }

        if(this.interactive == true) {
            const picked = await this.selectWithKeys(question, items, startIndex, options?.cancelValue, options?.refresh, options?.tabs, options?.animation, options?.banner, options?.preface);
            return picked;
        }

        const picked = await this.selectWithLines(question, items, startIndex, options?.cancelValue, options?.tabs, options?.banner, options?.preface);
        return picked;
    }

    /**
     * Reads a value without echoing it on a TTY. Empty means "none", or "keep" when the
     * caller says a value already exists.
     *
     * @throws {PromptBackError} On Esc.
     * @throws {PromptClosedError} On Ctrl+C or when the input closes.
     */
    async askSecret(question: string): Promise<string> {
        const prompt = `${this.style.accent(this.symbols.question)} ${this.style.bold(question)} `;
        const answer = await this.readAnswer(prompt, { secret: true });

        let shown = this.style.dim("(empty)");
        if(answer !== "") {
            shown = "•".repeat(Math.min(answer.length, 8));
        }
        this.writeAnswered(question, shown);
        return answer;
    }

    // ── shared input ───────────────────────────────────────────────────────

    /**
     * One typed answer, through the line editor on a TTY and a plain line otherwise. The
     * prompt is gone from the screen when this returns; the caller writes the summary line.
     *
     * @throws {PromptBackError} On Esc, or an Esc line off a TTY.
     * @throws {PromptClosedError} When the input closes.
     */
    private async readAnswer(prompt: string, options: { secret?: boolean; initialValue?: string } = {}): Promise<string> {
        if(this.interactive && this.inputEnded) throw new PromptClosedError();
        if(this.interactive == true) {
            const typed = await this.editLine(prompt, options);
            return typed;
        }

        this.output.write(prompt);
        const line = await this.readLine();
        if(line == null) {
            throw new PromptClosedError();
        }
        if(ESCAPE_LINES.includes(line.trim()) == true) {
            throw new PromptBackError();
        }

        return line;
    }

    // ── line mode ──────────────────────────────────────────────────────────

    private readLine(): Promise<string | null> {
        const queued = this.pendingLines.shift();
        if(queued != null) {
            return Promise.resolve(queued);
        }

        if(this.inputEnded == true) {
            return Promise.resolve(null);
        }

        return new Promise((resolve) => {
            this.lineWaiter = resolve;
        });
    }

    private onData(chunk: string): void {
        if(this.keyHandler != null) {
            for(const key of splitKeys(chunk)) {
                // A key that finishes the prompt hands the rest of the chunk to whatever
                // reads next; there is no next reader yet, so it is dropped, as a TTY would.
                if(this.keyHandler == null) {
                    break;
                }
                this.keyHandler(key);
            }
            return;
        }

        this.lineBuffer += chunk;

        let newlineIndex = this.lineBuffer.indexOf("\n");
        while(newlineIndex >= 0) {
            const line = this.lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
            this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);

            if(this.lineWaiter != null) {
                const waiter = this.lineWaiter;
                this.lineWaiter = null;
                waiter(line);
            }
            else {
                this.pendingLines.push(line);
            }

            newlineIndex = this.lineBuffer.indexOf("\n");
        }
    }

    private async selectWithLines<T extends string>(
        question: string,
        items: SelectItem<T>[],
        startIndex: number,
        cancelValue: T | undefined,
        tabs: SelectTabs<T> | undefined,
        banner: LinePart[][] | undefined,
        preface: string[] | undefined,
    ): Promise<T> {
        const choices = items.filter((item): item is SelectChoice<T> => "value" in item);
        const labelWidths = groupLabelWidths(items);

        this.output.write(`${this.symbols.question} ${question}\n`);
        for(const line of banner ?? []) {
            this.output.write(`  ${line.map((part) => part.text).join("")}\n`);
        }
        if(tabs != null) {
            const bar = tabs.items.map((tab) => {
                if(tab.value === tabs.active) {
                    return `[${tab.label}]`;
                }
                return tab.label;
            });
            this.output.write(`  ${bar.join("  ")}\n`);
        }

        for(const line of preface ?? []) {
            this.output.write(`${line.replace(ANSI_PATTERN, "")}\n`);
        }

        let number = 0;
        for(let index = 0; index < items.length; index += 1) {
            const item = items[index];
            if("value" in item == false) {
                if(item.lines != null) {
                    for(const line of item.lines(this.columns() - 1)) {
                        this.output.write(`${line.replace(ANSI_PATTERN, "")}\n`);
                    }
                    continue;
                }
                if(item.label != null) {
                    let heading = `  ${item.label}`;
                    if(item.hint != null && item.hint !== "") {
                        heading += `  ${item.hint}`;
                    }
                    this.output.write(`\n${heading}\n`);
                }
                else {
                    this.output.write("\n");
                }
                continue;
            }

            number += 1;
            const numbering = `  ${String(number).padStart(2)}) `;
            if(item.lines != null) {
                // the row's own lines, unstyled; later lines keep their place under the first
                item.lines(false, this.columns() - 1 - numbering.length).forEach((parts, lineIndex) => {
                    const text = parts.map((part) => part.text).join("");
                    let indent = numbering;
                    if(lineIndex > 0) {
                        indent = " ".repeat(numbering.length);
                    }
                    this.output.write(`${`${indent}${text}`.trimEnd()}\n`);
                });
                continue;
            }
            let line = `${numbering}${padToWidth(item.label, labelWidths[index])}`;
            if(item.hint != null && item.hint !== "") {
                line += `  ${item.hintStatus == "success" ? `${this.symbols.tick} ` : ""}${item.hint}`;
            }
            if(item.hintWarning != null) {
                line += item.hint != null && item.hint !== "" ? ` · ${item.hintWarning}` : `  ${item.hintWarning}`;
            }
            this.output.write(`${line.trimEnd()}\n`);
        }

        const defaultChoice = items[startIndex] as SelectChoice<T>;
        const defaultNumber = choices.indexOf(defaultChoice) + 1;

        for(;;) {
            this.output.write(`Choice (${defaultNumber}): `);

            const line = await this.readLine();
            if(line == null) {
                throw new PromptClosedError();
            }

            const answer = line.trim();
            if(ESCAPE_LINES.includes(answer) == true) {
                if(cancelValue == null) {
                    throw new PromptBackError();
                }
                return cancelValue;
            }

            if(answer === "") {
                return defaultChoice.value;
            }

            const index = Number(answer);
            if(Number.isInteger(index) == true && index >= 1 && index <= choices.length) {
                return choices[index - 1].value;
            }

            const lowered = answer.toLowerCase();
            const matched = choices.find((choice) => {
                const key = choice.key ?? choice.value;
                return key.toLowerCase() === lowered || choice.label.toLowerCase() === lowered;
            });
            if(matched != null) {
                return matched.value;
            }

            const matchedTab = tabs?.items.find((tab) => {
                const key = tab.key ?? tab.value;
                return key.toLowerCase() === lowered || tab.label.toLowerCase() === lowered;
            });
            if(matchedTab != null) {
                return matchedTab.value;
            }

            this.output.write(`  Pick a number from 1 to ${choices.length}.\n`);
        }
    }

    // ── TTY rendering ──────────────────────────────────────────────────────

    /** The terminal's real size; a guess only when it reports none, since a guess larger than the window breaks every redraw. */
    private columns(): number {
        const columns = (this.output as TtyOutput).columns;
        if(columns == null || columns < 1) {
            return 80;
        }

        return columns;
    }

    private rows(): number {
        const rows = (this.output as TtyOutput).rows;
        if(rows == null || rows < 1) {
            return 24;
        }

        return rows;
    }

    /** Joins styled parts, cutting the text (not the styles) once `width` columns are used. */
    private fitLine(parts: LinePart[], width: number): string {
        const paintPart = (part: LinePart, text: string): string => {
            if(part.paint != null) {
                return part.paint(text);
            }
            return text;
        };

        const totalWidth = parts.reduce((sum, part) => sum + displayWidth(part.text), 0);
        if(totalWidth <= width) {
            return parts.map((part) => paintPart(part, part.text)).join("");
        }

        // a cut line ends in an ellipsis, drawn in the style of the part it cuts
        const budget = Math.max(0, width - displayWidth(this.symbols.ellipsis));
        let used = 0;
        let line = "";
        for(const part of parts) {
            let text = "";
            for(const character of part.text) {
                const characterWidth = charWidth(character.codePointAt(0) ?? 0);
                if(used + characterWidth > budget) {
                    return line + paintPart(part, `${text.trimEnd()}${this.symbols.ellipsis}`);
                }
                used += characterWidth;
                text += character;
            }
            line += paintPart(part, text);
        }

        return line;
    }

    /** The one-line record an answered prompt leaves behind on a TTY. */
    private writeAnswered(question: string, answer: string): void {
        if(this.interactive == false || this.transient == true) {
            return;
        }

        this.write(`${this.style.success(this.symbols.tick)} ${question} ${this.style.dim("·")} ${this.style.accent(answer)}\n`);
    }

    /**
     * A one-line editor in raw mode: insert at the cursor, Backspace / Delete, ← / →,
     * Home / End, Ctrl+U clears, Enter answers, Esc goes back. Cooked mode cannot do this —
     * the terminal either swallows Esc or stuffs the byte into the value. With `secret` the
     * characters are collected but never drawn.
     *
     * The field redraws from the prompt on every key; the cursor is placed by row and
     * column from the widths, since a long value wraps.
     */
    private editLine(prompt: string, options: { secret?: boolean; initialValue?: string }): Promise<string> {
        const { secret = false, initialValue = "" } = options;
        const ttyInput = this.input as TtyInput;
        const promptWidth = displayWidth(prompt.replace(ANSI_PATTERN, ""));
        const columns = this.columns();

        /** Code points, so a wide character is one unit for the cursor. */
        let buffer = Array.from(initialValue);
        let cursor = buffer.length;
        /** Row the terminal cursor is on, relative to the prompt's first row. */
        let cursorRow = 0;

        const draw = (): void => {
            let text = "";
            if(cursorRow > 0) {
                text += `${ESC}[${cursorRow}A`;
            }
            text += `\r${ESC}[J${prompt}`;

            let shown = "";
            let widthToCursor = promptWidth;
            if(secret == false) {
                shown = buffer.join("");
                widthToCursor += displayWidth(buffer.slice(0, cursor).join(""));
            }
            text += shown;

            const widthToEnd = promptWidth + displayWidth(shown);
            const endRow = Math.floor(widthToEnd / columns);
            const endColumn = widthToEnd % columns;
            // A full final row still has pending wrap; this puts the cursor on the counted next row.
            if(endColumn == 0) {
                text += "\r\n";
            }
            cursorRow = Math.floor(widthToCursor / columns);
            const cursorColumn = widthToCursor % columns;

            if(endRow > cursorRow) {
                text += `${ESC}[${endRow - cursorRow}A`;
            }
            if(endColumn > cursorColumn) {
                text += `${ESC}[${endColumn - cursorColumn}D`;
            }
            else if(cursorColumn > endColumn) {
                text += `${ESC}[${cursorColumn - endColumn}C`;
            }

            this.output.write(text);
        };

        return new Promise<string>((resolve, reject) => {
            const finish = (): void => {
                this.keyHandler = null;
                ttyInput.setRawMode?.(false);
                let text = "";
                if(cursorRow > 0) {
                    text += `${ESC}[${cursorRow}A`;
                }
                this.output.write(`${text}\r${ESC}[J`);
            };

            this.keyHandler = (key: string) => {
                if(key === KEY_CTRL_C || key === KEY_CTRL_D) {
                    finish();
                    reject(new PromptClosedError());
                    return;
                }

                if(KEY_ENTER.includes(key) == true) {
                    finish();
                    resolve(buffer.join(""));
                    return;
                }

                if(key === ESC) {
                    finish();
                    reject(new PromptBackError());
                    return;
                }

                if(KEY_BACKSPACE.includes(key) == true) {
                    if(cursor > 0) {
                        buffer.splice(cursor - 1, 1);
                        cursor -= 1;
                    }
                }
                else if(KEY_DELETE.includes(key) == true) {
                    buffer.splice(cursor, 1);
                }
                else if(KEY_LEFT.includes(key) == true) {
                    cursor = Math.max(0, cursor - 1);
                }
                else if(KEY_RIGHT.includes(key) == true) {
                    cursor = Math.min(buffer.length, cursor + 1);
                }
                else if(KEY_HOME.includes(key) == true) {
                    cursor = 0;
                }
                else if(KEY_END.includes(key) == true) {
                    cursor = buffer.length;
                }
                else if(key === KEY_CTRL_U) {
                    buffer = [];
                    cursor = 0;
                }
                else if(key.startsWith(ESC) == true || (key.codePointAt(0) ?? 0) < 0x20) {
                    // Any other escape sequence or control character — nothing to insert.
                    return;
                }
                else {
                    buffer.splice(cursor, 0, key);
                    cursor += 1;
                }

                draw();
            };

            ttyInput.setRawMode?.(true);
            draw();
        });
    }

    private selectWithKeys<T extends string>(
        initialQuestion: string,
        initialItems: SelectItem<T>[],
        startIndex: number,
        cancelValue: T | undefined,
        refresh: SelectOptions<T>["refresh"],
        initialTabs: SelectTabs<T> | undefined,
        animation: SelectOptions<T>["animation"],
        initialBanner: LinePart[][] | undefined,
        preface: string[] | undefined,
    ): Promise<T> {
        const ttyInput = this.input as TtyInput;
        let question = initialQuestion;
        let banner = initialBanner;
        let items = initialItems;
        let tabs = initialTabs;
        let selectableIndexes: number[] = [];
        let labelWidths: number[] = [];
        let ruleWidth = 0;
        /** Set when a refresh load throws; shown on the footer until a later load succeeds. */
        let refreshError: string | null = null;

        const layout = (): void => {
            selectableIndexes = items.flatMap((item, index) => {
                if("value" in item) {
                    return [index];
                }
                return [];
            });
            labelWidths = groupLabelWidths(items);
            ruleWidth = Math.min(Math.max(...labelWidths), 24);
        };
        layout();

        let active = startIndex;
        let renderedLines = 0;
        let drawnText = "";
        /** First body line shown when the list is taller than the terminal. */
        let scrollTop = 0;
        let viewportHeight = 0;
        let bodyLineCount = 0;
        let followSelection = true;
        let readingText = false;
        let anchorValue: string | null = null;
        let anchorStart = 0;
        let anchorHeaderHeight = 0;
        let prefaceScrollTop = 0;
        let prefaceHeight = 0;
        let prefaceLineCount = 0;
        const hasPreface = preface != null && preface.length > 0;
        const bounds = new Map<number, { start: number; end: number }>();
        /** First body line of the active row in the last build, for the trace. */
        let tracedActiveStart = 0;

        // CONCOS_BOARD_TRACE=<file>: one JSON line per draw, refresh, key and resize, to find where a
        // real terminal and this list disagree (2026-10-26, a board that shifted only on real
        // terminals). Values and counts only, never the text of a row or what was typed.
        const tracePath = process.env.CONCOS_BOARD_TRACE;
        const valueAt = (index: number): string | null => {
            const item = items[index];
            if(item != null && "value" in item) {
                return item.value;
            }
            return null;
        };
        const trace = (event: Record<string, unknown>): void => {
            if(tracePath == null || tracePath == "") {
                return;
            }
            try {
                fs.appendFileSync(tracePath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
            }
            catch {
                // a trace that cannot be written must not break the list
            }
        };

        const draw = (lines: string[], incremental = false): void => {
            const partial = incremental && lines.length == renderedLines && renderedLines > 0;
            trace({
                event: partial ? "draw-partial" : "draw-full", lines: lines.length, drawnBefore: renderedLines,
                rows: this.rows(), columns: this.columns(), active: valueAt(active), activeStart: tracedActiveStart,
                scrollTop: scrollTop, viewport: viewportHeight, body: bodyLineCount,
                prefaceTop: prefaceScrollTop, prefaceViewport: prefaceHeight, prefaceLines: prefaceLineCount,
            });
            if(partial) {
                const previous = drawnText.split("\n");
                let cursor = renderedLines - 1;
                let changes = "";
                lines.forEach((line, index) => {
                    if(line == previous[index]) return;
                    const distance = index - cursor;
                    changes += "\r";
                    if(distance != 0) changes += `${ESC}[${Math.abs(distance)}${distance < 0 ? "A" : "B"}`;
                    changes += `${ESC}[2K${line}`;
                    cursor = index;
                });
                if(changes != "") {
                    changes += "\r";
                    if(cursor < renderedLines - 1) changes += `${ESC}[${renderedLines - 1 - cursor}B`;
                    this.output.write(changes);
                }
                drawnText = lines.join("\n");
                return;
            }
            let text = "";
            if(renderedLines > 1) {
                text += `${ESC}[${renderedLines - 1}A`;
            }
            text += `\r${ESC}[J${lines.join("\n")}`;
            this.output.write(text);
            renderedLines = lines.length;
            drawnText = lines.join("\n");
        };

        /**
         * Question line, the body (rows and their detail lines), then the footer. A body taller
         * than the terminal is windowed around the active row; redrawing moves the cursor up by
         * the lines drawn, which cannot reach past the top of the screen.
         */
        const buildLines = (): string[] => {
            const width = this.columns() - 1;
            const header = [this.fitLine([
                { text: this.symbols.question, paint: this.style.accent },
                { text: " " },
                { text: question, paint: this.style.bold },
            ], width)];
            for(const line of banner ?? []) {
                header.push(this.fitLine([{ text: "  " }, ...line], width));
            }
            if(tabs != null) {
                // inactive tabs are padded to the bracket width, so switching never shifts the bar
                const bar: LinePart[] = [{ text: " " }];
                for(const tab of tabs.items) {
                    if(tab.value === tabs.active) {
                        bar.push({ text: `[${tab.label}]`, paint: (text) => this.style.bold(this.style.accent(text)) });
                    }
                    else {
                        bar.push({ text: ` ${tab.label} `, paint: tab.attention ? (text) => this.style.bold(this.style.warning(text)) : this.style.dim });
                    }
                    bar.push({ text: "  " });
                }
                header.push(this.fitLine(bar, width));
            }
            const lines: string[] = [];
            let activeStart = 0;
            let activeEnd = 0;
            bounds.clear();

            for(let index = 0; index < items.length; index += 1) {
                const item = items[index];
                if("value" in item == false) {
                    if(item.lines != null) {
                        const text = wrapPreface(item.lines(width), width);
                        lines.push(...text.map((line) => process.env.NO_COLOR == null ? line : line.replace(ANSI_PATTERN, "")));
                        continue;
                    }
                    if(item.label != null) {
                        // a heading right under another heading belongs to it: no blank line between
                        const previous = items[index - 1];
                        const underHeading = previous != null && "value" in previous == false && previous.label != null;
                        if(lines.length > 0 && underHeading == false) {
                            lines.push("");
                        }
                        const paintLabel = (text: string) => this.style.bold(this.style.accent(text));
                        if(item.rule == true) {
                            const rule = this.symbols.rule;
                            const heading: LinePart[] = [
                                { text: `  ${rule}${rule} `, paint: this.style.dim },
                                { text: item.label, paint: paintLabel },
                            ];
                            if(item.hint != null && item.hint !== "") {
                                heading.push({ text: ` · ${item.hint}`, paint: this.style.dim });
                            }
                            const used = heading.reduce((sum, part) => sum + displayWidth(part.text), 0);
                            heading.push({ text: ` ${rule.repeat(Math.max(0, width - used - 1))}`, paint: this.style.dim });
                            lines.push(this.fitLine(heading, width));
                            continue;
                        }
                        const heading: LinePart[] = [{ text: `  ${item.label}`, paint: paintLabel }];
                        if(item.hint != null && item.hint !== "") {
                            heading.push({ text: `  ${item.hint}`, paint: this.style.dim });
                        }
                        lines.push(this.fitLine(heading, width));
                        continue;
                    }
                    lines.push(this.fitLine([{ text: `  ${this.symbols.rule.repeat(ruleWidth)}`, paint: this.style.dim }], width));
                    continue;
                }

                const isActive = index === active;
                const rowStart = lines.length;
                let gutter: LinePart = { text: "  " };
                if(isActive == true) {
                    gutter = { text: `${this.symbols.pointer} `, paint: this.style.accent };
                    activeStart = lines.length;
                }

                if(item.lines != null) {
                    item.lines(isActive, width - 2).forEach((parts, lineIndex) => {
                        let lineGutter: LinePart = { text: "  " };
                        if(lineIndex == 0) {
                            lineGutter = gutter;
                        }
                        lines.push(this.fitLine([lineGutter, ...parts], width));
                    });
                }
                else {
                    const parts: LinePart[] = [gutter];
                    if(isActive == true) {
                        parts.push({ text: padToWidth(item.label, labelWidths[index]), paint: this.style.accent });
                    }
                    else {
                        parts.push({ text: padToWidth(item.label, labelWidths[index]) });
                    }
                    // a text field shows what was typed, and on the active row where typing goes
                    const field = item.input;
                    if(field != null && (isActive == true || field.text != "")) {
                        parts.push({ text: `  ${field.text}`, paint: isActive == true ? undefined : this.style.dim });
                        if(isActive == true) {
                            parts.push({ text: this.symbols.caret, paint: this.style.accent });
                        }
                        if(field.text == "" && field.placeholder != null) {
                            parts.push({ text: ` ${field.placeholder}`, paint: this.style.dim });
                        }
                    }
                    else if(item.hint != null && item.hint !== "") {
                        const hint = item.hintStatus == "success" ? `${this.symbols.tick} ${item.hint}` : item.hint;
                        parts.push({ text: `  ${hint}`, paint: item.hintStatus == "success" ? this.style.success : this.style.dim });
                    }
                    if(item.hintWarning != null) {
                        const lead = item.hint != null && item.hint !== "" ? " · " : "  ";
                        parts.push({ text: `${lead}${item.hintWarning}`, paint: this.style.warning });
                    }
                    lines.push(this.fitLine(parts, width));
                }

                let rowEnd = lines.length - 1;
                while(rowEnd > rowStart && lines[rowEnd].replace(ANSI_PATTERN, "").trim() == "") rowEnd -= 1;
                if(isActive == true) {
                    activeEnd = rowEnd;
                }
                bounds.set(index, { start: rowStart, end: rowEnd });
            }

            let trailerCount = 1;
            if(refreshError != null) {
                trailerCount = 2;
            }
            // question and tab lines, footer lines, and one spare row so the last line never scrolls the screen;
            // a short terminal still gets a list that fits, down to one body line, since the cursor cannot
            // climb above the window to redraw the part that would not
            const available = Math.max(1, this.rows() - header.length - trailerCount - 1);
            let detailLines = wrapPreface(preface ?? [], width);
            if(process.env.NO_COLOR != null) {
                detailLines = detailLines.map((line) => line.replace(ANSI_PATTERN, ""));
            }
            prefaceLineCount = detailLines.length;
            prefaceHeight = 0;
            if(hasPreface == true) {
                // A long action list must not squeeze the detail into one line: reserve half the
                // space (at least four rows when possible), leaving at least one selectable row.
                const minimumDetailHeight = Math.min(detailLines.length, Math.max(0, available - 1), Math.max(4, Math.floor(available / 2)));
                const choiceHeight = Math.min(lines.length, available - minimumDetailHeight);
                prefaceHeight = Math.min(detailLines.length, available - choiceHeight);
            }
            prefaceScrollTop = Math.min(prefaceScrollTop, Math.max(0, detailLines.length - prefaceHeight));
            const detail = detailLines.slice(prefaceScrollTop, prefaceScrollTop + prefaceHeight);
            const height = available - prefaceHeight;
            viewportHeight = height;
            bodyLineCount = lines.length;
            const headerHeight = header.length + prefaceHeight;
            if(followSelection == false && anchorValue == valueAt(active)) {
                // Every draw can change row heights, including animation between data refreshes.
                scrollTop += activeStart - anchorStart + headerHeight - anchorHeaderHeight;
            }
            let body = lines;
            if(lines.length > height) {
                if(followSelection == true) readingText = false;
                const selectedOutside = activeEnd < scrollTop || activeStart >= scrollTop + height;
                if(followSelection == true || (selectedOutside == true && readingText == false)) {
                    if(activeEnd - activeStart + 1 > height) {
                        // A long message starts at its title; its body is reached by scrolling.
                        scrollTop = activeStart;
                    }
                    else {
                        if(activeStart < scrollTop) {
                            scrollTop = Math.max(0, activeStart - 1);
                        }
                        if(activeEnd >= scrollTop + height) {
                            scrollTop = activeEnd - height + 1;
                        }
                    }
                }
                scrollTop = Math.min(Math.max(0, scrollTop), lines.length - height);
                body = lines.slice(scrollTop, scrollTop + height);
            }
            else {
                scrollTop = 0;
            }
            if(activeEnd >= scrollTop && activeStart < scrollTop + height) readingText = false;
            followSelection = false;
            anchorValue = valueAt(active);
            anchorStart = activeStart;
            anchorHeaderHeight = headerHeight;
            tracedActiveStart = activeStart;

            let above = scrollTop;
            let below = Math.max(0, lines.length - scrollTop - height);
            if(hasPreface == true) {
                above = prefaceScrollTop;
                below = Math.max(0, detailLines.length - prefaceScrollTop - prefaceHeight);
            }
            const scrollable = above > 0 || below > 0;
            const hints = [
                "↑↓ move · Enter select · Esc back",
                "↑↓ · Enter select · Esc back",
                "↑↓ · Enter · Esc",
                "Enter Esc",
            ];
            if(tabs != null) {
                hints.splice(0, hints.length,
                    "↑↓ move · ←→ tab · Enter select · Esc back",
                    "↑↓ · ←→ tab · Enter select · Esc back",
                    "↑↓ · ←→ tab · Enter · Esc",
                    "←→ · Enter · Esc",
                    "Tab Enter Esc",
                );
            }
            if(readingText == true) {
                hints.splice(0, hints.length, "Enter returns to menu · Esc back", "Enter menu · Esc back", "Enter Esc");
            }
            let footer: string | undefined;
            if(scrollable == true) {
                footer = hints.map((hint) => `${hint} · PgUp/PgDn scroll`).find((hint) => displayWidth(hint) <= width);
            }
            footer ??= hints.find((hint) => displayWidth(hint) <= width) ?? hints[hints.length - 1];
            if(scrollable == true) {
                const hidden: string[] = [];
                const compact: string[] = [];
                if(above > 0) {
                    hidden.push(`${above} lines above`);
                    compact.push(`↑${above}`);
                }
                if(below > 0) {
                    hidden.push(`${below} lines below`);
                    compact.push(`↓${below}`);
                }
                for(const counts of [hidden.join(" · "), compact.join(" ")]) {
                    if(displayWidth(`${footer} · ${counts}`) <= width) {
                        footer += ` · ${counts}`;
                        break;
                    }
                }
            }
            if(refresh != null && displayWidth(`${footer} · updates live`) <= width) {
                footer += " · updates live";
            }

            const result = [...header, ...detail, ...body, this.fitLine([{ text: footer, paint: this.style.dim }], width)];
            if(refreshError != null) {
                result.push(this.fitLine([{ text: `refresh failed: ${refreshError}`, paint: this.style.warning }], width));
            }
            return result;
        };

        const redraw = (incremental = false): void => {
            if(animation != null) {
                try {
                    const frame = animation.frame();
                    if(frame.question != null) question = frame.question;
                    if(frame.tabs != null) tabs = frame.tabs;
                    if(frame.preface != null) preface = frame.preface;
                }
                catch(error) { refreshError = error instanceof Error ? error.message : String(error); }
            }
            const lines = buildLines();
            if(lines.join("\n") != drawnText) draw(lines, incremental);
        };

        /** Keeps the cursor on the value it was on; a row that disappeared moves it to the nearest row. */
        const reload = (): void => {
            const activeValue = (items[active] as SelectChoice<T>).value;
            const activePosition = selectableIndexes.indexOf(active);
            const refreshOffset = scrollTop - (bounds.get(active)?.start ?? scrollTop);
            try {
                const next = refresh!.load();
                question = next.question;
                if(next.banner != null) {
                    banner = next.banner;
                }
                items = next.items;
                if(next.tabs != null) {
                    tabs = next.tabs;
                }
                if(next.preface != null) {
                    preface = next.preface;
                }
                refreshError = null;
            }
            catch(error) {
                refreshError = String(error);
                if(error instanceof Error) {
                    refreshError = error.message;
                }
            }
            layout();
            const sameValue = items.findIndex((item) => "value" in item && item.value === activeValue);
            if(sameValue >= 0) {
                active = sameValue;
            }
            else {
                active = selectableIndexes[Math.min(activePosition, selectableIndexes.length - 1)];
                followSelection = true;
            }
            trace({ event: "reload", from: activeValue, kept: sameValue >= 0, to: valueAt(active), items: items.length, refreshOffset: refreshOffset });
            redraw(animation != null);
        };

        const move = (step: number): void => {
            const position = selectableIndexes.indexOf(active);
            const next = (position + step + selectableIndexes.length) % selectableIndexes.length;
            active = selectableIndexes[next];
            followSelection = true;
        };

        return new Promise<T>((resolve, reject) => {
            let timer: NodeJS.Timeout | null = null;
            let animationTimer: NodeJS.Timeout | null = null;
            const onResize = (): void => {
                trace({ event: "resize", rows: this.rows(), columns: this.columns() });
                followSelection = true;
                redraw();
            };
            this.output.on("resize", onResize);
            if(refresh != null) {
                timer = setInterval(reload, refresh.intervalMs);
                this.timers.add(timer);
                timer.unref();
            }
            if(animation != null && this.motionEnabled) {
                animationTimer = setInterval(() => redraw(true), Math.max(40, animation.intervalMs));
                this.timers.add(animationTimer);
                animationTimer.unref();
            }

            const finish = (): void => {
                if(timer != null) {
                    clearInterval(timer);
                    this.timers.delete(timer);
                }
                if(animationTimer != null) {
                    clearInterval(animationTimer);
                    this.timers.delete(animationTimer);
                }
                this.output.off("resize", onResize);
                this.keyHandler = null;
                ttyInput.setRawMode?.(false);
                draw([]);
                this.output.write(`${ESC}[?25h`);
            };

            this.keyHandler = (key: string) => {
                let keyName = "char";
                if(key.startsWith(ESC) == true || /^[\u0000-\u001f\u007f]$/u.test(key) == true) {
                    keyName = JSON.stringify(key);
                }
                trace({ event: "key", key: keyName, active: valueAt(active) });
                if(key === KEY_CTRL_C || key === KEY_CTRL_D) {
                    finish();
                    reject(new PromptClosedError());
                    return;
                }

                // a row's text field takes typing before Esc, digits and j/k mean anything else
                const field = (items[active] as SelectChoice<T>).input;
                if(field != null && readingText == false) {
                    if(KEY_BACKSPACE.includes(key) == true) {
                        field.text = [...field.text].slice(0, -1).join("");
                        redraw();
                        return;
                    }
                    if(key === KEY_CTRL_U || (key === ESC && field.text != "")) {
                        field.text = "";
                        redraw();
                        return;
                    }
                    if(key.startsWith(ESC) == false && /^[^\u0000-\u001f\u007f]+$/u.test(key) == true) {
                        field.text += key;
                        redraw();
                        return;
                    }
                }

                if(KEY_ENTER.includes(key) == true) {
                    if(readingText == true) {
                        active = selectableIndexes[0];
                        scrollTop = 0;
                        followSelection = true;
                        readingText = false;
                        redraw();
                        return;
                    }
                    const picked = items[active] as SelectChoice<T>;
                    finish();
                    this.writeAnswered(question, picked.label);
                    resolve(picked.value);
                    return;
                }

                if(key === ESC) {
                    finish();
                    if(cancelValue == null) {
                        reject(new PromptBackError());
                        return;
                    }
                    resolve(cancelValue);
                    return;
                }

                const forward = key === KEY_TAB || KEY_RIGHT.includes(key);
                const backward = key === KEY_SHIFT_TAB || KEY_LEFT.includes(key);
                if(tabs != null && (forward == true || backward == true)) {
                    const position = tabs.items.findIndex((tab) => tab.value === tabs!.active);
                    let step = 1;
                    if(backward == true) {
                        step = -1;
                    }
                    const next = tabs.items[(position + step + tabs.items.length) % tabs.items.length];
                    finish();
                    resolve(next.value);
                    return;
                }

                if(KEY_UP.includes(key) == true) {
                    const row = bounds.get(active)!;
                    if(hasPreface == false && row.end - row.start + 1 > viewportHeight && scrollTop > row.start) scrollTop -= 1;
                    else move(-1);
                }
                else if(KEY_DOWN.includes(key) == true) {
                    const row = bounds.get(active)!;
                    if(hasPreface == false && row.end - row.start + 1 > viewportHeight && scrollTop + viewportHeight <= row.end) scrollTop += 1;
                    else move(1);
                }
                else if(key === KEY_PAGE_UP || key === KEY_PAGE_DOWN) {
                    const step = key === KEY_PAGE_UP ? -1 : 1;
                    if(hasPreface == true) {
                        prefaceScrollTop = Math.min(Math.max(0, prefaceLineCount - prefaceHeight), Math.max(0, prefaceScrollTop + step * Math.max(1, prefaceHeight - 1)));
                    }
                    else {
                        scrollTop = Math.min(Math.max(0, bodyLineCount - viewportHeight), Math.max(0, scrollTop + step * Math.max(1, viewportHeight - 1)));
                        const row = bounds.get(active)!;
                        if(row.end < scrollTop || row.start >= scrollTop + viewportHeight) {
                            const visible = selectableIndexes.find((index) => bounds.get(index)!.end >= scrollTop && bounds.get(index)!.start < scrollTop + viewportHeight);
                            readingText = visible == null;
                            if(visible != null) active = visible;
                        }
                    }
                }
                else if(KEY_HOME.includes(key) == true) {
                    if(hasPreface == true) {
                        prefaceScrollTop = 0;
                    }
                    else {
                        active = selectableIndexes[0];
                        followSelection = true;
                    }
                }
                else if(KEY_END.includes(key) == true) {
                    if(hasPreface == true) {
                        prefaceScrollTop = Math.max(0, prefaceLineCount - prefaceHeight);
                    }
                    else {
                        active = selectableIndexes[selectableIndexes.length - 1];
                        followSelection = true;
                    }
                }
                else if(/^[1-9]$/.test(key) == true && Number(key) <= selectableIndexes.length) {
                    active = selectableIndexes[Number(key) - 1];
                    followSelection = true;
                }
                else {
                    return;
                }

                redraw();
            };

            ttyInput.setRawMode?.(true);
            this.output.write(`${ESC}[?25l`);
            redraw();
        });
    }
}

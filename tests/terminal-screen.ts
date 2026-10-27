import { displayWidth } from "../src/modules/cli/prompter";

interface ScreenBuffer {
    /** Each window row as cells; a wide character's second cell is "". */
    cells: string[][];
    scrollback: string[];
    row: number;
    column: number;
}

const CONTROL_SEQUENCE = /\u001b\[([0-9;?]*)([A-Za-z])/y;

/**
 * A small VT screen for tests: the sequences the prompter writes, applied to a `columns` × `rows`
 * window the way a terminal applies them. The cursor cannot leave the window, so moving up stops
 * at its top row; a line feed on the bottom row scrolls the top row into the scrollback; the
 * alternate screen keeps no scrollback, and leaving it shows the main screen as it was.
 */
export class TerminalScreen {
    private readonly main: ScreenBuffer;
    private alternate: ScreenBuffer | null = null;
    private cursorVisible = true;

    constructor(private readonly columns: number, private readonly rows: number) {
        this.main = this.blank();
    }

    write(text: string): void {
        let index = 0;
        while(index < text.length) {
            CONTROL_SEQUENCE.lastIndex = index;
            const sequence = CONTROL_SEQUENCE.exec(text);
            if(sequence != null) {
                this.control(sequence[1], sequence[2]);
                index += sequence[0].length;
                continue;
            }
            const character = String.fromCodePoint(text.codePointAt(index)!);
            index += character.length;
            if(character == "\r") this.active().column = 0;
            else if(character == "\n") this.lineFeed();
            else if(character >= " ") this.put(character);
        }
    }

    /** The window's rows as they show now, trailing spaces cut. */
    visible(): string[] {
        return this.active().cells.map((cells) => this.text(cells));
    }

    /** The actual VT cursor, independently of any glyph a prompt draws as a caret. */
    cursor(): { row: number; column: number; visible: boolean } {
        const { row, column } = this.active();
        return { row, column, visible: this.cursorVisible };
    }

    /** The main screen's scrollback and window rows: what the shell shows once the program is gone. */
    transcript(): string[] {
        return [...this.main.scrollback, ...this.main.cells.map((cells) => this.text(cells))];
    }

    private blank(): ScreenBuffer {
        return { cells: Array.from({ length: this.rows }, () => []), scrollback: [], row: 0, column: 0 };
    }

    private active(): ScreenBuffer {
        return this.alternate ?? this.main;
    }

    private text(cells: string[]): string {
        return cells.join("").trimEnd();
    }

    private lineFeed(): void {
        const buffer = this.active();
        buffer.column = 0;
        if(buffer.row < this.rows - 1) {
            buffer.row += 1;
            return;
        }
        const top = buffer.cells.shift()!;
        if(buffer == this.main) buffer.scrollback.push(this.text(top));
        buffer.cells.push([]);
    }

    private put(character: string): void {
        const buffer = this.active();
        const width = displayWidth(character);
        if(buffer.column + width > this.columns) this.lineFeed();
        const line = buffer.cells[buffer.row];
        while(line.length < buffer.column) line.push(" ");
        line[buffer.column] = character;
        if(width == 2) line[buffer.column + 1] = "";
        buffer.column += width;
    }

    private control(parameters: string, command: string): void {
        const buffer = this.active();
        const count = Number(parameters) || 1;
        if(command == "A") buffer.row = Math.max(0, buffer.row - count);
        else if(command == "B") buffer.row = Math.min(this.rows - 1, buffer.row + count);
        else if(command == "C") buffer.column = Math.min(this.columns - 1, buffer.column + count);
        else if(command == "D") buffer.column = Math.max(0, buffer.column - count);
        else if(command == "H") {
            const [row, column] = parameters.split(";").map((part) => Number(part) || 1);
            buffer.row = (row ?? 1) - 1;
            buffer.column = (column ?? 1) - 1;
        }
        else if(command == "J") {
            if(parameters == "2") buffer.cells = buffer.cells.map(() => []);
            else {
                buffer.cells[buffer.row] = buffer.cells[buffer.row].slice(0, buffer.column);
                for(let row = buffer.row + 1; row < this.rows; row += 1) buffer.cells[row] = [];
            }
        }
        else if(command == "K") {
            buffer.cells[buffer.row] = parameters == "2" ? [] : buffer.cells[buffer.row].slice(0, buffer.column);
        }
        else if(command == "h" && parameters == "?1049") this.alternate = this.blank();
        else if(command == "l" && parameters == "?1049") this.alternate = null;
        else if(command == "h" && parameters == "?25") this.cursorVisible = true;
        else if(command == "l" && parameters == "?25") this.cursorVisible = false;
        // colours change nothing a test reads
    }
}

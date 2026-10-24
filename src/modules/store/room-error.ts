/**
 * A request the caller can correct: unknown handle, revision conflict, bad recipient.
 * The MCP layer returns its message to the model as a tool execution error.
 */
export class RoomError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RoomError";
    }
}

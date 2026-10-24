import { RoomError } from "../store/room-error";

/** MCP registration targets are independent of the legacy host-hook adapters. */
export const MCP_CLIENTS = [
    { id: "claude", label: "Claude Code", userMcp: ".claude.json", mcpFormat: "json" },
    { id: "codex", label: "Codex CLI", userMcp: ".codex/config.toml", mcpFormat: "toml" },
    { id: "gemini", label: "Gemini CLI", userMcp: ".gemini/settings.json", mcpFormat: "json" },
    { id: "cursor", label: "Cursor", userMcp: ".cursor/mcp.json", mcpFormat: "json" },
    { id: "copilot", label: "Copilot CLI", userMcp: ".copilot/mcp-config.json", mcpFormat: "json" },
] as const;

/**
 * Clients whose hooks were checked in real sessions (docs/hooks-design.md, phase 0). The other
 * clients keep their hook adapters for earlier registrations and open after their own check.
 */
export const HOOK_CLIENTS = ["claude", "codex"] as const;

export function getMcpClient(id: string) {
    const client = MCP_CLIENTS.find((entry) => entry.id == id);
    if(client == null) throw new RoomError(`--host must be one of ${MCP_CLIENTS.map((entry) => entry.id).join(", ")}`);
    return client;
}

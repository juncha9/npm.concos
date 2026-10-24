import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJson } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySetup, inspectHooks, inspectSetup, inspectWake, planHooks, planSetup, planWake } from "../src/modules/cli/setup";
import { HOST_ADAPTERS } from "../src/modules/hooks/adapters";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "concos-setup-")); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

describe("user-wide setup", () => {
    it.each(HOST_ADAPTERS)("previews, applies and repeats $id registration without duplicates", (adapter) => {
        const input = { host: adapter.id, home: directory };
        const changes = planSetup(input);
        expect(fs.readdirSync(directory)).toEqual([]);
        expect(changes).toHaveLength(1);
        expect(changes[0].path).toBe(path.join(directory, adapter.setup.userMcp));
        expect(changes[0].after).not.toContain("concos hook");
        if(adapter.setup.mcpFormat != "toml") expect(parseJson(changes[0].after)).not.toHaveProperty("hooks");
        applySetup(changes);
        expect(planSetup(input)).toEqual([]);
        expect(inspectSetup(input)).toEqual({ registered: true, room: "main" });
        if(adapter.setup.userHooks != adapter.setup.userMcp) expect(fs.existsSync(path.join(directory, adapter.setup.userHooks))).toBe(false);
    });

    it("preserves user JSON comments, existing hooks, servers and settings, and backs up originals", () => {
        const hooksPath = path.join(directory, ".claude", "settings.json");
        fs.mkdirSync(path.dirname(hooksPath));
        const original = '\uFEFF{\n// important comment\n"permissions": {"allow": ["Read"]},\n"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo custom"}]}]}\n}\n';
        fs.writeFileSync(hooksPath, original);
        fs.writeFileSync(path.join(directory, ".claude.json"), '{"mcpServers":{"existing":{"command":"local-server"}}}');
        const input = { host: "claude", home: directory };
        applySetup(planSetup(input));
        const result = fs.readFileSync(hooksPath, "utf8");
        expect(result).toContain("// important comment");
        expect(result.startsWith("\uFEFF")).toBe(true);
        const data = parseJson(result.slice(1));
        expect(data.permissions.allow).toEqual(["Read"]);
        expect(result).toBe(original);
        expect(data.hooks.Stop).toHaveLength(1);
        expect(data.hooks.Stop[0].hooks[0].command).toBe("echo custom");
        expect(parseJson(fs.readFileSync(path.join(directory, ".claude.json"), "utf8")).mcpServers.existing.command).toBe("local-server");
        const backup = fs.readdirSync(directory).find((file) => file.startsWith(".claude.json.concos-backup-"))!;
        expect(parseJson(fs.readFileSync(path.join(directory, backup), "utf8"))).toEqual({ mcpServers: { existing: { command: "local-server" } } });
        expect(planSetup(input)).toEqual([]);
    });

    it("appends a user TOML server without rewriting existing tables or comments", () => {
        const config = path.join(directory, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(config));
        const original = '# keep this\nmodel = "my-model"\n[mcp_servers.existing]\ncommand = "my-server"\n';
        fs.writeFileSync(config, original);
        const result = planSetup({ host: "codex", home: directory }).find((change) => change.path == config)!.after;
        expect(result.startsWith(original)).toBe(true);
        expect(parseToml(result)).toMatchObject({ model: "my-model", mcp_servers: { existing: { command: "my-server" }, concos: { command: "concos", args: ["mcp"] } } });
    });

    it("rejects a foreign server before writing and detects changes since preview", () => {
        fs.writeFileSync(path.join(directory, ".claude.json"), '{"mcpServers":{"concos":{"command":"something-else"}}}');
        expect(() => planSetup({ host: "claude", home: directory })).toThrow(/already exists/);
        expect(fs.existsSync(path.join(directory, ".claude"))).toBe(false);
        const changes = planSetup({ host: "gemini", home: directory });
        fs.mkdirSync(path.dirname(changes[0].path));
        fs.writeFileSync(changes[0].path, '{"newSetting":true}');
        expect(() => applySetup(changes)).toThrow(/changed since preview/);
        expect(fs.readFileSync(changes[0].path, "utf8")).toBe('{"newSetting":true}');
    });

    it("rejects project scope and ignores former room names and working folders", () => {
        expect(() => planSetup({ host: "codex", home: directory, scope: "project" })).toThrow(/user-wide/);
        const first = planSetup({ host: "codex", home: directory, directory: "project-a", room: "a" });
        const second = planSetup({ host: "codex", home: directory, directory: "project-b", room: "b" });
        expect(first).toEqual(second);
        expect(fs.readdirSync(directory)).toEqual([]);
    });

    it("recognizes legacy user registration without duplicating hooks", () => {
        const config = path.join(directory, ".codex");
        fs.mkdirSync(config);
        fs.writeFileSync(path.join(config, "config.toml"), '[mcp_servers.concos]\ncommand = "concos"\nargs = ["mcp", "--room", "legacy"]\n');
        const hooksPath = path.join(config, "hooks.json");
        const hooks = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"concos hook session-start --host codex --room-base64 bGVnYWN5"}]}]}}';
        fs.writeFileSync(hooksPath, hooks);
        expect(planSetup({ host: "codex", home: directory })).toEqual([]);
        expect(inspectSetup({ host: "codex", home: directory }).room).toBe("main");
        expect(fs.readFileSync(hooksPath, "utf8")).toBe(hooks);
    });

    it("registers MCP independently of an unrelated malformed hook configuration", () => {
        const hookFile = path.join(directory, ".codex", "hooks.json");
        fs.mkdirSync(path.dirname(hookFile));
        fs.writeFileSync(hookFile, "{broken hook configuration");
        const input = { host: "codex", home: directory };
        expect(inspectSetup(input).registered).toBe(false);
        applySetup(planSetup(input));
        expect(inspectSetup(input).registered).toBe(true);
        expect(fs.readFileSync(hookFile, "utf8")).toBe("{broken hook configuration");
    });

    it("preserves existing Gemini hooks when MCP uses the same settings file", () => {
        const file = path.join(directory, ".gemini", "settings.json");
        fs.mkdirSync(path.dirname(file));
        const hooks = { AfterAgent: [{ hooks: [{ type: "command", command: "keep-existing-hook" }] }] };
        fs.writeFileSync(file, JSON.stringify({ hooks, otherSetting: true }));
        applySetup(planSetup({ host: "gemini", home: directory }));
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ hooks, otherSetting: true, mcpServers: { concos: { command: "concos", args: ["mcp"] } } });
    });

    it("names a moved data folder in the Codex MCP entry, since Codex does not pass CONCOS_HOME to MCP servers", () => {
        vi.stubEnv("CONCOS_HOME", path.join(directory, "data"));
        try {
            const codex = parseToml(planSetup({ host: "codex", home: directory })[0].after);
            expect(codex).toMatchObject({ mcp_servers: { concos: { command: "concos", args: ["mcp"], env: { CONCOS_HOME: path.join(directory, "data") } } } });
            expect(parseJson(planSetup({ host: "claude", home: directory })[0].after).mcpServers.concos).toEqual({ command: "concos", args: ["mcp"] });
        }
        finally { vi.unstubAllEnvs(); }
    });
});

describe("optional hooks", () => {
    const commands = (groups: { hooks: { command: string }[] }[]) => groups.map((group) => group.hooks[0].command);

    it("are offered for Claude Code and Codex once MCP is registered", () => {
        expect(() => planHooks({ host: "gemini", home: directory }, "on")).toThrow(/available for claude, codex/);
        expect(() => planHooks({ host: "claude", home: directory }, "on")).toThrow(/Register concos MCP/);
        expect(inspectHooks({ host: "codex", home: directory })).toEqual({ state: "off", present: 0, expected: 5 });
        expect(fs.readdirSync(directory)).toEqual([]);
    });

    it("add Claude hooks after the user's own and remove only concos ones, keeping comments", () => {
        const input = { host: "claude", home: directory };
        applySetup(planSetup(input));
        const file = path.join(directory, ".claude", "settings.json");
        fs.mkdirSync(path.dirname(file));
        fs.writeFileSync(file, '{\n  // keep me\n  "permissions": {"allow": ["Read"]},\n  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo mine"}]}]}\n}\n');
        const on = planHooks(input, "on");
        expect(on[0].notes.join(" ")).toContain("folders you have trusted");
        applySetup(on);
        const data = parseJson(fs.readFileSync(file, "utf8"));
        expect(fs.readFileSync(file, "utf8")).toContain("// keep me");
        expect(commands(data.hooks.Stop)).toEqual(["echo mine", "concos hook turn-end --host claude"]);
        expect(data.hooks.PostToolUse).toEqual([{
            matcher: "Edit|Write|MultiEdit|NotebookEdit",
            hooks: [{ type: "command", command: "concos hook file-edited --host claude", timeout: 10, async: true }],
        }]);
        expect(inspectHooks(input)).toEqual({ state: "on", present: 5, expected: 5 });
        expect(planHooks(input, "on")).toEqual([]);

        applySetup(planHooks(input, "off"));
        const after = fs.readFileSync(file, "utf8");
        expect(after).toContain("// keep me");
        expect(parseJson(after)).toEqual({ permissions: { allow: ["Read"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } });
        expect(inspectHooks(input).state).toBe("off");
        expect(planHooks(input, "off")).toEqual([]);
    });

    it("write Codex hooks.json, complete a partial set, and warn when removal moves the user's hooks", () => {
        const input = { host: "codex", home: directory };
        applySetup(planSetup(input));
        const on = planHooks(input, "on");
        expect(on[0].notes.join(" ")).toContain("/hooks");
        applySetup(on);
        const file = path.join(directory, ".codex", "hooks.json");
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        expect(data.hooks.SessionEnd).toEqual([{ hooks: [{ type: "command", command: "concos hook session-end --host codex", timeout: 3 }] }]);
        // a user hook after ours, and one of ours removed by hand
        data.hooks.Stop.push({ hooks: [{ type: "command", command: "echo after" }] });
        delete data.hooks.SessionStart;
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        expect(inspectHooks(input)).toEqual({ state: "partial", present: 4, expected: 5 });
        const fill = planHooks(input, "on");
        expect(fill[0].additions.map((addition) => addition.key)).toEqual(["hooks.SessionStart"]);
        applySetup(fill);

        const off = planHooks(input, "off");
        expect(off[0].notes.join(" ")).toContain("trust them again");
        applySetup(off);
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo after" }] }] } });
    });

    it("let Claude Code turn on idle wake over hooks that are on, and turning hooks off removes it too", () => {
        const input = { host: "claude", home: directory };
        applySetup(planSetup(input));
        expect(() => planWake(input, "on")).toThrow(/Turn on hooks before idle wake/);
        expect(() => planWake({ host: "codex", home: directory }, "on")).toThrow(/Claude Code only/);
        applySetup(planHooks(input, "on"));
        const on = planWake(input, "on");
        expect(on[0].notes.join(" ")).toContain("Codex sessions do not wake");
        applySetup(on);
        const file = path.join(directory, ".claude", "settings.json");
        expect(parseJson(fs.readFileSync(file, "utf8")).hooks.Stop.map((group: { hooks: unknown[] }) => group.hooks[0])).toEqual([
            { type: "command", command: "concos hook turn-end --host claude", timeout: 10 },
            { type: "command", command: "concos hook watch --host claude", timeout: 3660, asyncRewake: true },
        ]);
        expect(inspectWake(input)).toBe(true);
        expect(inspectHooks(input).state).toBe("on");
        expect(planWake(input, "on")).toEqual([]);

        applySetup(planWake(input, "off"));
        expect(inspectWake(input)).toBe(false);
        expect(inspectHooks(input).state).toBe("on");
        applySetup(planWake(input, "on"));
        applySetup(planHooks(input, "off"));
        expect(inspectWake(input)).toBe(false);
        expect(parseJson(fs.readFileSync(file, "utf8"))).toEqual({ hooks: {} });
    });

    it("rewrite an older concos hook where it stands, and are refused when Codex has concos hooks in config.toml", () => {
        const input = { host: "codex", home: directory };
        applySetup(planSetup(input));
        const file = path.join(directory, ".codex", "hooks.json");
        fs.writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [
            { hooks: [{ type: "command", command: "echo first" }] },
            { hooks: [{ type: "command", command: "concos hook session-start --host codex --room-base64 bGVnYWN5" }] },
        ] } }));
        expect(inspectHooks(input).present).toBe(0);
        applySetup(planHooks(input, "on"));
        expect(commands(JSON.parse(fs.readFileSync(file, "utf8")).hooks.SessionStart)).toEqual(["echo first", "concos hook session-start --host codex"]);

        applySetup(planHooks(input, "off"));
        fs.appendFileSync(path.join(directory, ".codex", "config.toml"), '\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "concos hook turn-end --host codex"\n');
        expect(() => planHooks(input, "on")).toThrow(/already has concos hooks/);
    });
});

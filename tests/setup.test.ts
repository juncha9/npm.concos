import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJson } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySetup, inspectHooks, inspectSetup, inspectWake, planHooks, planRegistration, planSetup, planWake } from "../src/modules/cli/setup";
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
        const configPath = path.join(directory, ".claude.json");
        const configOriginal = '\uFEFF{\r\n  // keep preferences and project registrations\r\n  "theme": "dark",\r\n  "projects": {"D:/existing": {"allowedTools": ["Read"], "mcpServers": {"local": {"command": "project-server"}}}},\r\n  "mcpServers": {"existing": {"command": "local-server", "env": {"KEEP": "fixture"}}},\r\n}\r\n';
        fs.writeFileSync(configPath, configOriginal);
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
        const configAfter = fs.readFileSync(configPath, "utf8");
        const configData = parseJson(configAfter.slice(1));
        const configBefore = parseJson(configOriginal.slice(1));
        expect(configData).toEqual({ ...configBefore, mcpServers: { ...configBefore.mcpServers, concos: { command: "concos", args: ["mcp"] } } });
        expect(configAfter.startsWith("\uFEFF")).toBe(true);
        expect(configAfter).toContain("// keep preferences and project registrations\r\n");
        const backup = fs.readdirSync(directory).find((file) => file.startsWith(".claude.json.concos-backup-"))!;
        expect(fs.readFileSync(path.join(directory, backup), "utf8")).toBe(configOriginal);
        expect(planSetup(input)).toEqual([]);
    });

    it("appends a user TOML server without rewriting existing tables or comments", () => {
        const config = path.join(directory, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(config));
        const original = '# keep this\r\nmodel = "my-model"\r\n[features]\r\nhooks = true\r\n[profiles.custom]\r\nmodel = "another-model"\r\n[mcp_servers.existing]\r\ncommand = "my-server"\r\nargs = ["--custom"]\r\n[mcp_servers.existing.env]\r\nKEEP = "fixture"\r\n[hooks.state.saved]\r\ntrusted_hash = "keep-trust-record"\r\n';
        fs.writeFileSync(config, original);
        const changes = planSetup({ host: "codex", home: directory });
        const result = changes.find((change) => change.path == config)!.after;
        expect(result.startsWith(original)).toBe(true);
        const before = parseToml(original);
        expect(parseToml(result)).toEqual({ ...before, mcp_servers: { ...before.mcp_servers as object, concos: { command: "concos", args: ["mcp"] } } });
        applySetup(changes);
        expect(fs.readFileSync(config, "utf8")).toBe(result);
        const backup = fs.readdirSync(path.dirname(config)).find((file) => file.startsWith("config.toml.concos-backup-"))!;
        expect(fs.readFileSync(path.join(path.dirname(config), backup), "utf8")).toBe(original);
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

    it.each([
        ["claude", '{"mcpServers":'],
        ["claude", '{"mcpServers":null}'],
        ["claude", '{"mcpServers":{"concos":null}}'],
        ["claude", '{"mcpServers":{"first":{"command":"first"}},"mcpServers":{"last":{"command":"last"}}}'],
        ["claude", '{"mcpServers":{"concos":{"command":"foreign"},"concos":{"command":"concos","args":["mcp"]}}}'],
        ["claude", '{"mcpServers":{"concos":{"type":"http","url":"https://example.test/mcp","command":"concos","args":["mcp"]}}}'],
        ["codex", 'mcp_servers = "keep this value"\n'],
        ["codex", '[mcp_servers\n'],
        ["codex", '[mcp_servers.concos]\ncommand = "foreign"\nargs = ["mcp"]\n'],
    ])("refuses ambiguous or conflicting %s registration without changing the original", (host, original) => {
        const file = path.join(directory, host == "claude" ? ".claude.json" : ".codex/config.toml");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, original);
        const input = { host, home: directory };
        expect(() => planSetup(input)).toThrow();
        expect(() => inspectSetup(input)).toThrow();
        expect(fs.readFileSync(file, "utf8")).toBe(original);
        expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
    });

    it("does not overwrite a new file created just before publishing the registration", () => {
        const input = { host: "claude", home: directory };
        const changes = planSetup(input);
        const file = changes[0].path;
        const concurrent = '{"theme":"created by Claude"}';
        const link = fs.linkSync.bind(fs);
        const spy = vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
            fs.writeFileSync(file, concurrent);
            link(source, target);
        });
        try {
            expect(() => applySetup(changes)).toThrow(/changed since preview/);
        }
        finally { spy.mockRestore(); }
        expect(fs.readFileSync(file, "utf8")).toBe(concurrent);
        expect(fs.readdirSync(directory)).toEqual([path.basename(file)]);
    });

    it.each(["claude", "codex"])("retains all options on an existing %s concos registration", (host) => {
        const file = path.join(directory, host == "claude" ? ".claude.json" : ".codex/config.toml");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const original = host == "claude"
            ? '{"mcpServers":{"concos":{"type":"stdio","command":"concos","args":["mcp"],"env":{"KEEP":"fixture"},"customSetting":true}}}'
            : '[mcp_servers.concos]\ncommand = "concos"\nargs = ["mcp"]\nenabled = false\nstartup_timeout_sec = 45\n[mcp_servers.concos.env]\nKEEP = "fixture"\n';
        fs.writeFileSync(file, original);
        const input = { host, home: directory };
        expect(inspectSetup(input).registered).toBe(true);
        expect(planSetup(input)).toEqual([]);
        expect(fs.readFileSync(file, "utf8")).toBe(original);
        expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
    });

    it.each([null, '{"theme":"original"}'])("preserves a concurrent update made while preparing the replacement (%s)", (original) => {
        const input = { host: "claude", home: directory };
        const file = path.join(directory, ".claude.json");
        if(original != null) fs.writeFileSync(file, original);
        const changes = planSetup(input);
        const concurrent = '{"theme":"updated by Claude","projects":{"keep":true}}';
        const write = fs.writeFileSync.bind(fs);
        const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
            write(target, data, options);
            if(String(target).includes(".concos-tmp-")) write(file, concurrent);
        });
        try {
            expect(() => applySetup(changes)).toThrow(/changed since preview/);
        }
        finally { spy.mockRestore(); }
        expect(fs.readFileSync(file, "utf8")).toBe(concurrent);
        expect(fs.readdirSync(directory).some((name) => name.includes(".concos-tmp-"))).toBe(false);
        if(original != null) {
            const backup = fs.readdirSync(directory).find((name) => name.includes(".concos-backup-"))!;
            expect(fs.readFileSync(path.join(directory, backup), "utf8")).toBe(original);
        }
    });

    it.each([false, true])("rolls back a failed apply while preserving a newer user edit (%s)", (concurrentEdit) => {
        const first = path.join(directory, ".claude.json");
        const original = '{"theme":"original"}';
        const concurrent = '{"theme":"newer user edit"}';
        fs.writeFileSync(first, original);
        const second = path.join(directory, ".codex", "config.toml");
        const secondOriginal = 'model = "keep-my-model"\n';
        fs.mkdirSync(path.dirname(second));
        fs.writeFileSync(second, secondOriginal);
        const changes = [...planSetup({ host: "claude", home: directory }), ...planSetup({ host: "codex", home: directory })];
        const rename = fs.renameSync.bind(fs);
        const spy = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
            if(String(target) == second) {
                if(concurrentEdit) fs.writeFileSync(first, concurrent);
                throw new Error("simulated replacement failure");
            }
            rename(source, target);
        });
        try {
            expect(() => applySetup(changes)).toThrow(/simulated replacement failure/);
        }
        finally { spy.mockRestore(); }
        expect(fs.readFileSync(first, "utf8")).toBe(concurrentEdit ? concurrent : original);
        expect(fs.readFileSync(second, "utf8")).toBe(secondOriginal);
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

describe("registration in one preview", () => {
    const claude = () => ({ host: "claude", home: directory });
    const hooksFile = () => path.join(directory, ".claude", "settings.json");

    it("registers Claude Code MCP, hooks and idle wake at once, after the user's own hooks and comments", () => {
        fs.mkdirSync(path.dirname(hooksFile()));
        fs.writeFileSync(hooksFile(), '{\n  // keep me\n  "permissions": {"allow": ["Read"]},\n  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo mine"}]}]}\n}\n');
        const changes = planRegistration(claude(), { wake: true, skipBrokenHooks: true });
        expect(changes.map((change) => change.path)).toEqual([path.join(directory, ".claude.json"), hooksFile()]);
        expect(changes[1].notes.join(" ")).toContain("Codex sessions do not wake");
        expect(fs.readFileSync(hooksFile(), "utf8")).not.toContain("concos");
        applySetup(changes);

        expect(inspectSetup(claude()).registered).toBe(true);
        expect(inspectHooks(claude()).state).toBe("on");
        expect(inspectWake(claude())).toBe(true);
        const text = fs.readFileSync(hooksFile(), "utf8");
        expect(text).toContain("// keep me");
        expect(parseJson(text).permissions).toEqual({ allow: ["Read"] });
        expect(parseJson(text).hooks.Stop.map((group: { hooks: { command: string }[] }) => group.hooks[0].command))
            .toEqual(["echo mine", "concos hook turn-end --host claude", "concos hook watch --host claude"]);
        expect(planRegistration(claude(), { wake: true, skipBrokenHooks: true })).toEqual([]);
    });

    it("leaves a hooks file it cannot edit safely untouched and still registers MCP, unless asked for hooks", () => {
        fs.mkdirSync(path.dirname(hooksFile()));
        const broken = '{"hooks": {"Stop": []}, "hooks": {}}';
        fs.writeFileSync(hooksFile(), broken);
        const changes = planRegistration(claude(), { wake: true, skipBrokenHooks: true });
        expect(changes.map((change) => change.path)).toEqual([path.join(directory, ".claude.json")]);
        expect(changes[0].notes.join(" ")).toMatch(/Hooks were left out, and their file untouched: .*duplicate JSON key "hooks"\. Fix it/);
        applySetup(changes);
        expect(inspectSetup(claude()).registered).toBe(true);
        expect(fs.readFileSync(hooksFile(), "utf8")).toBe(broken);
        expect(() => planRegistration(claude(), { wake: false, skipBrokenHooks: false })).toThrow(/duplicate JSON key/);
    });

    it("refuses idle wake for Codex, and writes nothing a change would leave unreadable", () => {
        expect(() => planRegistration({ host: "codex", home: directory }, { wake: true, skipBrokenHooks: false })).toThrow(/Claude Code only/);
        expect(planRegistration({ host: "gemini", home: directory }, { wake: false, skipBrokenHooks: true })).toHaveLength(1);
        const file = path.join(directory, "settings.json");
        fs.writeFileSync(file, '{"keep": true}');
        expect(() => applySetup([{ path: file, before: '{"keep": true}', after: '{"keep": true', additions: [], removals: [], notes: [] }])).toThrow(/invalid JSON/);
        expect(fs.readFileSync(file, "utf8")).toBe('{"keep": true}');
        expect(fs.readdirSync(directory)).toEqual(["settings.json"]);
    });
});

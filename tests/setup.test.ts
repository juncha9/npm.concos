import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJson } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySetup, ensureUsableSettings, inspectHooks, inspectSettings, inspectSetup, inspectWake, planHooks, planRegistration, planSetup, planUnregister, planUpdate, planWake, pruneSettingsBackups, resolveMcpPath } from "../src/modules/cli/setup";
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
        const backup = fs.readdirSync(directory).find((file) => file.startsWith(".claude.json.concos-mcp-backup-"))!;
        expect(fs.readFileSync(path.join(directory, backup), "utf8")).toBe(configOriginal);
        expect(planSetup(input)).toEqual([]);
    });

    it("writes added entries in the file's own line endings and indentation", () => {
        fs.mkdirSync(path.join(directory, ".codex"));
        const toml = path.join(directory, ".codex", "config.toml");
        fs.writeFileSync(toml, 'model = "x"\r\n\r\n[mcp_servers.other]\r\ncommand = "other"\r\n');
        applySetup(planSetup({ host: "codex", home: directory }));
        const tomlText = fs.readFileSync(toml, "utf8");
        expect(tomlText.replace(/\r\n/g, "")).not.toContain("\n");
        expect(parseToml(tomlText).mcp_servers).toMatchObject({ other: { command: "other" }, concos: { command: "concos" } });

        for(const [host, file, indent] of [["gemini", ".gemini/settings.json", "\t"], ["cursor", ".cursor/mcp.json", "    "]] as const) {
            fs.mkdirSync(path.join(directory, path.dirname(file)));
            fs.writeFileSync(path.join(directory, file), `{\n${indent}"mcpServers": {\n${indent}${indent}"other": { "command": "other" }\n${indent}}\n}\n`);
            applySetup(planSetup({ host, home: directory }));
            const text = fs.readFileSync(path.join(directory, file), "utf8");
            expect(text).toContain(`\n${indent}${indent}"concos": {`);
            expect(parseJson(text).mcpServers.other).toEqual({ command: "other" });
        }
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
        const backup = fs.readdirSync(path.dirname(config)).find((file) => file.startsWith("config.toml.concos-mcp-backup-"))!;
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
            if(String(target).includes(".concos-mcp-tmp-")) write(file, concurrent);
        });
        try {
            expect(() => applySetup(changes)).toThrow(/changed since preview/);
        }
        finally { spy.mockRestore(); }
        expect(fs.readFileSync(file, "utf8")).toBe(concurrent);
        expect(fs.readdirSync(directory).some((name) => name.includes(".concos-mcp-tmp-"))).toBe(false);
        if(original != null) {
            const backup = fs.readdirSync(directory).find((name) => name.includes(".concos-mcp-backup-"))!;
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

describe("hooks", () => {
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

    it.each(["claude", "codex"])("lets %s turn on idle wake over hooks that are on, and turning hooks off removes it too", (host) => {
        const input = { host, home: directory };
        applySetup(planSetup(input));
        expect(() => planWake(input, "on")).toThrow(/Turn on hooks before idle wake/);
        applySetup(planHooks(input, "on"));
        const on = planWake(input, "on");
        expect(on[0].notes.join(" ")).toContain("for up to 60 minutes after each turn");
        if(host == "codex") {
            expect(on[0].notes.join(" ")).toContain("codex queue");
            expect(on[0].notes.filter((note) => note.includes("open /hooks in Codex"))).toHaveLength(1);
        }
        applySetup(on);
        const file = path.join(directory, host == "claude" ? ".claude/settings.json" : ".codex/hooks.json");
        expect(parseJson(fs.readFileSync(file, "utf8")).hooks.Stop.map((group: { hooks: unknown[] }) => group.hooks[0])).toEqual([
            { type: "command", command: `concos hook turn-end --host ${host}`, timeout: 10 },
            { type: "command", command: `concos hook watch --host ${host}`, timeout: 3660, ...(host == "claude" ? { asyncRewake: true } : { async: true }) },
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

    it("keeps later Codex hooks when turning idle wake off and reports their changed trust positions", () => {
        const input = { host: "codex", home: directory };
        applySetup(planRegistration(input, { wake: true }));
        const file = path.join(directory, ".codex", "hooks.json");
        const data = parseJson(fs.readFileSync(file, "utf8"));
        data.hooks.Stop.push({ hooks: [{ type: "command", command: "echo keep-after-wake" }] });
        fs.writeFileSync(file, JSON.stringify(data));
        const off = planWake(input, "off");
        expect(off[0].notes.join(" ")).toContain("trust them again");
        applySetup(off);
        expect(commands(parseJson(fs.readFileSync(file, "utf8")).hooks.Stop)).toEqual([
            "concos hook turn-end --host codex", "echo keep-after-wake",
        ]);
        expect(inspectHooks(input).state).toBe("on");
        expect(inspectWake(input)).toBe(false);
    });

    it("rewrite an older concos hook where it stands, and are refused when Codex has concos hooks in config.toml", () => {
        const input = { host: "codex", home: directory };
        applySetup(planSetup(input));
        const file = path.join(directory, ".codex", "hooks.json");
        fs.writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [
            { hooks: [{ type: "command", command: "echo first" }] },
            { hooks: [{ type: "command", command: "concos hook session-start --host codex --room-base64 bGVnYWN5" }] },
        ] } }));
        // an older form still counts as there, and an update rewrites it too
        expect(inspectHooks(input).present).toBe(1);
        expect(planUpdate(input)[0].additions).toEqual([{ key: "hooks.SessionStart.1.hooks.0", value: { type: "command", command: "concos hook session-start --host codex", timeout: 10 } }]);
        applySetup(planHooks(input, "on"));
        expect(commands(JSON.parse(fs.readFileSync(file, "utf8")).hooks.SessionStart)).toEqual(["echo first", "concos hook session-start --host codex"]);

        applySetup(planHooks(input, "off"));
        fs.appendFileSync(path.join(directory, ".codex", "config.toml"), '\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "concos hook turn-end --host codex"\n');
        expect(() => planHooks(input, "on")).toThrow(/already has concos hooks/);
    });
});

describe("unregistering", () => {
    const write = (relative: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
        fs.writeFileSync(path.join(directory, relative), text);
    };
    const read = (relative: string) => fs.readFileSync(path.join(directory, relative), "utf8");

    it("takes out only the concos entry and hooks, giving TOML and hook files back byte for byte", () => {
        const toml = 'model = "x"\r\n\r\n[mcp_servers.other]\r\ncommand = "other"\r\n';
        write(".codex/config.toml", toml);
        // written over several lines, as clients write it; a list on one line comes back spread out (same data)
        const hooks = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2)}\n`;
        write(".codex/hooks.json", hooks);
        const codex = { host: "codex", home: directory };
        applySetup(planRegistration(codex, { wake: true }));
        expect(inspectHooks(codex).state).toBe("on");
        applySetup(planUnregister(codex));
        expect(read(".codex/config.toml")).toBe(toml);
        expect(read(".codex/hooks.json")).toBe(hooks);
        expect(planUnregister(codex)).toEqual([]);

        const inline = '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo mine"}]}]}}\n';
        write(".codex/hooks.json", inline);
        applySetup(planRegistration(codex, { wake: true }));
        applySetup(planUnregister(codex));
        expect(JSON.parse(read(".codex/hooks.json"))).toEqual(JSON.parse(inline));

        for(const host of ["claude", "gemini", "cursor", "copilot"]) {
            const input = { host, home: directory };
            const file = path.relative(directory, resolveMcpPath(input));
            write(file, '{\n  // keep\n  "theme": "dark",\n  "mcpServers": {"other": {"command": "other"}}\n}\n');
            applySetup(planRegistration(input, { wake: host == "claude" }));
            applySetup(planUnregister(input));
            expect(parseJson(read(file))).toEqual({ theme: "dark", mcpServers: { other: { command: "other" } } });
            expect(read(file)).toContain("// keep");
            expect(inspectSetup(input).registered).toBe(false);
        }
        expect(inspectHooks({ host: "claude", home: directory }).state).toBe("off");
    });

    it("keeps the comments above the next TOML table, and refuses entries it did not write", () => {
        write(".codex/config.toml", 'model = "x"\n\n[mcp_servers.concos]\ncommand = "concos"\nargs = ["mcp"]\n\n# about projects\n[projects."D:/x"]\ntrust_level = "trusted"\n');
        const codex = { host: "codex", home: directory };
        applySetup(planUnregister(codex));
        expect(read(".codex/config.toml")).toBe('model = "x"\n\n# about projects\n[projects."D:/x"]\ntrust_level = "trusted"\n');

        const others = 'model = "x"\n\n[mcp_servers.concos]\ncommand = "someone-else"\n';
        write(".codex/config.toml", others);
        expect(() => planUnregister(codex)).toThrow(/runs something else/);
        const inline = '[mcp_servers]\nconcos = { command = "concos", args = ["mcp"] }\n';
        write(".codex/config.toml", inline);
        expect(() => planUnregister(codex)).toThrow(/remove the \[mcp_servers.concos\] table by hand/);
        expect(read(".codex/config.toml")).toBe(inline);
    });

    it("names backups by time, never overwrites one taken in the same millisecond, and keeps the newest", () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-25T06:30:00.123Z"));
        try {
            const original = '{"theme": "dark"}\n';
            write(".gemini/settings.json", original);
            const gemini = { host: "gemini", home: directory };
            const backups = () => fs.readdirSync(path.join(directory, ".gemini")).filter((name) => name.includes(".concos-mcp-backup-"));
            applySetup(planSetup(gemini));
            expect(backups()).toEqual(["settings.json.concos-mcp-backup-2026-10-25T06-30-00-123Z"]);
            expect(read(".gemini/settings.json.concos-mcp-backup-2026-10-25T06-30-00-123Z")).toBe(original);
            const registered = read(".gemini/settings.json");
            applySetup(planUnregister(gemini));
            // the second copy took the next name; the first went after it, no longer the newest
            expect(backups()).toEqual(["settings.json.concos-mcp-backup-2026-10-25T06-30-00-123Z-2"]);
            expect(read(".gemini/settings.json.concos-mcp-backup-2026-10-25T06-30-00-123Z-2")).toBe(registered);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it("keeps one settings backup, the newest, for a week, also clearing those named before 0.1.7", () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-26T03:00:00.000Z"));
        try {
            write(".gemini/settings.json", '{"theme": "dark"}\n');
            const folder = path.join(directory, ".gemini");
            const lookAlikes = ["settings.json.bak", "settings.json.concos-mcp-backup-notes", "other.json.concos-mcp-backup-2026-10-20T01-00-00-000Z"];
            const older = ["settings.json.concos-mcp-backup-2026-10-25T01-00-00-000Z", "settings.json.concos-backup-c12fb81e-eb07-42be-ae33-a73de00a30be"];
            for(const name of [...lookAlikes, ...older]) fs.writeFileSync(path.join(folder, name), "copy");
            // a name from before 0.1.7 carries no time; its file time counts
            fs.utimesSync(path.join(folder, older[1]), new Date("2026-10-25T00:00:00Z"), new Date("2026-10-25T00:00:00Z"));
            applySetup(planSetup({ host: "gemini", home: directory }));
            const newest = "settings.json.concos-mcp-backup-2026-10-26T03-00-00-000Z";
            expect(fs.readdirSync(folder).sort()).toEqual([...lookAlikes, newest, "settings.json"].sort());

            const settings = path.join(folder, "settings.json");
            pruneSettingsBackups([settings], Date.parse("2026-11-02T02:59:59.999Z"));
            expect(fs.existsSync(path.join(folder, newest))).toBe(true);
            pruneSettingsBackups([settings], Date.parse("2026-11-02T03:00:00.000Z"));
            expect(fs.readdirSync(folder).sort()).toEqual([...lookAlikes, "settings.json"].sort());
        }
        finally {
            vi.useRealTimers();
        }
    });

    it("takes nothing out while the hooks file cannot be read as it should", () => {
        const claude = { host: "claude", home: directory };
        applySetup(planSetup(claude));
        const broken = '{"hooks": {}, "hooks": {}}';
        write(".claude/settings.json", broken);
        expect(() => planUnregister(claude)).toThrow(/duplicate JSON key "hooks"/);
        expect(() => ensureUsableSettings(claude)).toThrow(/^Claude Code settings need fixing before concos can use them:/);
        expect(inspectSetup(claude).registered).toBe(true);
        expect(read(".claude/settings.json")).toBe(broken);
    });
});

describe("settings concos cannot use", () => {
    const write = (relative: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
        fs.writeFileSync(path.join(directory, relative), text);
    };
    const problems = (host: string) => inspectSettings({ host, home: directory }).map((line) => line.replace(`${directory}${path.sep}`, ""));

    it("names each part of the MCP list and hooks section in another shape, and nothing else", () => {
        expect(problems("claude")).toEqual([]);
        write(".claude.json", JSON.stringify({ mcpServers: { mine: { command: "mine" }, loose: "mine --serve" } }));
        write(".claude/settings.json", JSON.stringify({
            permissions: { allow: "not checked" },
            hooks: {
                Stop: [{ hooks: { type: "command", command: "mine" } }, "loose", { matcher: 1, hooks: [{ command: 2, timeout: "5" }, null] }],
                SessionEnd: { hooks: [] },
                SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "mine", timeout: 5, async: true }] }],
            },
        }));
        const settings = path.join(".claude", "settings.json");
        expect(problems("claude")).toEqual([
            ".claude.json: mcpServers.loose must be an object",
            `${settings}: hooks.Stop[0].hooks must be a list`,
            `${settings}: hooks.Stop[1] must be an object`,
            `${settings}: hooks.Stop[2].matcher must be a string`,
            `${settings}: hooks.Stop[2].hooks[0].command must be a string`,
            `${settings}: hooks.Stop[2].hooks[0].timeout must be a number`,
            `${settings}: hooks.Stop[2].hooks[1] must be an object`,
            `${settings}: hooks.SessionEnd must be a list`,
        ]);
    });

    it("reports a file that does not parse, repeats a key or is not an object, as one problem each", () => {
        write(".claude.json", '{"mcpServers": {}');
        write(".claude/settings.json", '{"hooks": {}, "hooks": {}}');
        write(".cursor/mcp.json", "[]");
        write(".codex/config.toml", "[mcp_servers\n");
        expect(problems("claude")).toEqual([
            ".claude.json: invalid JSON",
            `${path.join(".claude", "settings.json")}: duplicate JSON key "hooks"`,
        ]);
        expect(problems("cursor")).toEqual([`${path.join(".cursor", "mcp.json")} must be an object`]);
        expect(problems("codex")).toEqual([`${path.join(".codex", "config.toml")}: invalid TOML`]);
        write(".codex/config.toml", 'hooks = "x"\nmcp_servers = { concos = "concos mcp" }\n');
        expect(problems("codex")).toEqual([
            `${path.join(".codex", "config.toml")}: mcp_servers.concos must be a table`,
            `${path.join(".codex", "config.toml")}: hooks must be a table`,
        ]);
    });

    it("checks hooks only where concos keeps them, so a Gemini hooks section is not judged", () => {
        write(".gemini/settings.json", JSON.stringify({ hooks: { BeforeTool: { command: "theirs" } } }));
        expect(problems("gemini")).toEqual([]);
    });

    it("refuses the client with every problem, ten at most, and changes nothing", () => {
        write(".claude/settings.json", JSON.stringify({ hooks: { Stop: Array.from({ length: 12 }, () => "loose") } }));
        expect(() => ensureUsableSettings({ host: "claude", home: directory })).toThrow(
            /need fixing before concos can use them:\n( {2}.+hooks\.Stop\[\d+\] must be an object\n){10} {2}…and 2 more\nconcos changed nothing\. Fix the file, then try Claude Code again\.$/,
        );
        expect(fs.readdirSync(path.join(directory, ".claude"))).toEqual(["settings.json"]);
    });
});

describe("registration in one preview", () => {
    const claude = () => ({ host: "claude", home: directory });
    const hooksFile = () => path.join(directory, ".claude", "settings.json");

    it("registers Claude Code MCP, hooks and idle wake at once, after the user's own hooks and comments", () => {
        fs.mkdirSync(path.dirname(hooksFile()));
        fs.writeFileSync(hooksFile(), '{\n  // keep me\n  "permissions": {"allow": ["Read"]},\n  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo mine"}]}]}\n}\n');
        const changes = planRegistration(claude(), { wake: true });
        expect(changes.map((change) => change.path)).toEqual([path.join(directory, ".claude.json"), hooksFile()]);
        expect(changes[1].notes.join(" ")).toContain("A waiting Claude Code session wakes");
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
        expect(planRegistration(claude(), { wake: true })).toEqual([]);
    });

    it("registers nothing while the hooks file cannot be read as it should", () => {
        fs.mkdirSync(path.dirname(hooksFile()));
        const broken = '{"hooks": {"Stop": []}, "hooks": {}}';
        fs.writeFileSync(hooksFile(), broken);
        expect(() => planRegistration(claude(), { wake: true })).toThrow(/duplicate JSON key "hooks"/);
        expect(fs.existsSync(path.join(directory, ".claude.json"))).toBe(false);
        expect(fs.readFileSync(hooksFile(), "utf8")).toBe(broken);
    });

    it("registers Codex MCP, hooks and idle wake in one preview with one trust reminder", () => {
        const input = { host: "codex", home: directory };
        const changes = planRegistration(input, { wake: true });
        expect(fs.readdirSync(directory)).toEqual([]);
        expect(changes.map((change) => change.path)).toEqual([
            path.join(directory, ".codex", "config.toml"), path.join(directory, ".codex", "hooks.json"),
        ]);
        expect(changes[1].notes.join(" ")).toContain("codex queue");
        expect(changes[1].notes.filter((note) => note.includes("open /hooks in Codex"))).toHaveLength(1);
        applySetup(changes);
        expect(inspectSetup(input).registered).toBe(true);
        expect(inspectHooks(input).state).toBe("on");
        expect(inspectWake(input)).toBe(true);
        expect(planRegistration(input, { wake: true })).toEqual([]);
    });

    it.each(["gemini", "cursor", "copilot"])("refuses idle wake for %s without writing settings", (host) => {
        const input = { host, home: directory };
        expect(() => planWake(input, "on")).toThrow(/Hooks are available for claude, codex/);
        expect(() => planRegistration(input, { wake: true })).toThrow(/Hooks are available for claude, codex/);
        expect(fs.readdirSync(directory)).toEqual([]);
    });

    it("writes nothing a change would leave unreadable", () => {
        expect(planRegistration({ host: "gemini", home: directory }, { wake: false })).toHaveLength(1);
        const file = path.join(directory, "settings.json");
        fs.writeFileSync(file, '{"keep": true}');
        expect(() => applySetup([{ path: file, before: '{"keep": true}', after: '{"keep": true', additions: [], removals: [], notes: [] }])).toThrow(/invalid JSON/);
        expect(fs.readFileSync(file, "utf8")).toBe('{"keep": true}');
        expect(fs.readdirSync(directory)).toEqual(["settings.json"]);
    });
});

describe("starting node directly", () => {
    // a built CLI where npm installs it: <prefix>/node_modules/concos-mcp/dist/cli.js
    let cli: string;
    let argv: string;
    beforeEach(() => {
        cli = path.join(directory, "prefix", "node_modules", "concos-mcp", "dist", "cli.js");
        fs.mkdirSync(path.dirname(cli), { recursive: true });
        fs.writeFileSync(cli, "");
        argv = process.argv[1];
        process.argv[1] = cli;
    });
    afterEach(() => {
        process.argv[1] = argv;
        vi.unstubAllEnvs();
    });
    const start = (...rest: string[]) => ({ command: process.execPath, args: ["--max-semi-space-size=1", cli, ...rest] });
    const readJson = (relative: string) => parseJson(fs.readFileSync(path.join(directory, relative), "utf8"));
    const readToml = (relative: string) => parseToml(fs.readFileSync(path.join(directory, relative), "utf8")) as Record<string, any>;

    it("registers node on the running cli.js for MCP and Claude Code hooks, and the plain command for Codex hooks", () => {
        const claude = { host: "claude", home: directory };
        applySetup(planRegistration(claude, { wake: true }));
        expect(readJson(".claude.json").mcpServers.concos).toEqual(start("mcp"));
        const hooks = readJson(".claude/settings.json").hooks;
        expect(hooks.SessionStart[0].hooks[0]).toEqual({ type: "command", ...start("hook", "session-start", "--host", "claude"), timeout: 10 });
        expect(hooks.Stop[1].hooks[0]).toEqual({ type: "command", ...start("hook", "watch", "--host", "claude"), timeout: 3660, asyncRewake: true });
        expect(inspectHooks(claude).state).toBe("on");
        expect(inspectWake(claude)).toBe(true);
        expect(planUpdate(claude)).toEqual([]);

        // Codex runs hooks in the session's shell (PowerShell, cmd or sh): the plain command reads the same in all
        applySetup(planRegistration({ host: "codex", home: directory }, { wake: true }));
        expect(readToml(".codex/config.toml").mcp_servers.concos).toEqual(start("mcp"));
        expect(readJson(".codex/hooks.json").hooks.Stop[1].hooks[0]).toEqual({ type: "command", command: "concos hook watch --host codex", timeout: 3660, async: true });
    });

    it("updates a registration an earlier concos wrote, where it stands and keeping what else the entries have", () => {
        const claude = { host: "claude", home: directory };
        const codex = { host: "codex", home: directory };
        vi.stubEnv("CONCOS_HOME", path.join(directory, "data"));
        // written by an earlier concos: the `concos` command everywhere
        process.argv[1] = argv;
        applySetup(planRegistration(claude, { wake: true }));
        applySetup(planRegistration(codex, { wake: true }));
        const hooksBefore = readJson(".codex/hooks.json");
        process.argv[1] = cli;

        const claudeUpdate = planUpdate(claude);
        expect(claudeUpdate.map((change) => change.path)).toEqual([path.join(directory, ".claude.json"), path.join(directory, ".claude", "settings.json")]);
        applySetup(claudeUpdate);
        expect(readJson(".claude.json").mcpServers.concos).toEqual(start("mcp"));
        const hooks = readJson(".claude/settings.json").hooks;
        expect(hooks.Stop.map((group: any) => group.hooks[0].args.slice(2, 4))).toEqual([["hook", "turn-end"], ["hook", "watch"]]);
        expect(hooks.PostToolUse[0]).toEqual({ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", ...start("hook", "file-edited", "--host", "claude"), timeout: 10, async: true }] });
        expect(planUpdate(claude)).toEqual([]);

        // only the MCP table moves for Codex, keeping its data folder; the hooks stay as they are
        const codexUpdate = planUpdate(codex);
        expect(codexUpdate.map((change) => change.path)).toEqual([path.join(directory, ".codex", "config.toml")]);
        applySetup(codexUpdate);
        expect(readToml(".codex/config.toml").mcp_servers.concos).toEqual({ ...start("mcp"), env: { CONCOS_HOME: path.join(directory, "data") } });
        expect(readJson(".codex/hooks.json")).toEqual(hooksBefore);
    });

    it("keeps a direct start a copy run through npx cannot improve on, and replaces one whose cli.js is gone", () => {
        const claude = { host: "claude", home: directory };
        applySetup(planRegistration(claude, { wake: false }));
        const cached = path.join(directory, "npm-cache", "_npx", "1a2b", "node_modules", "concos-mcp", "dist", "cli.js");
        fs.mkdirSync(path.dirname(cached), { recursive: true });
        fs.writeFileSync(cached, "");
        process.argv[1] = cached;
        expect(planUpdate(claude)).toEqual([]);
        fs.rmSync(cli);
        applySetup(planUpdate(claude));
        expect(readJson(".claude.json").mcpServers.concos).toEqual({ command: "concos", args: ["mcp"] });
        expect(readJson(".claude/settings.json").hooks.SessionStart[0].hooks[0].command).toBe("concos hook session-start --host claude");
    });

    it("refuses a server named concos that starts node on something else, and unregisters the direct form", () => {
        const claude = { host: "claude", home: directory };
        fs.writeFileSync(path.join(directory, ".claude.json"), JSON.stringify({ mcpServers: { concos: { command: process.execPath, args: ["other.js", "mcp"] } } }));
        expect(() => planSetup(claude)).toThrow(/already exists with different settings/);
        fs.rmSync(path.join(directory, ".claude.json"));
        applySetup(planRegistration(claude, { wake: true }));
        applySetup(planUnregister(claude));
        expect(readJson(".claude.json")).toEqual({ mcpServers: {} });
        expect(readJson(".claude/settings.json")).toEqual({ hooks: {} });
    });
});

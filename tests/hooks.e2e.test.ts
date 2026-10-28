import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = path.resolve("dist/cli.js");
let directory: string;
let environment: NodeJS.ProcessEnv;
beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "concos-hook-e2e-"));
    environment = { ...process.env, CONCOS_HOME: path.join(directory, "data"), CONCOS_LOG_LEVEL: "error", CODEX_HOME: path.join(directory, "user", ".codex") };
});
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

function invoke(kind: string, host: string, payload: unknown) {
    return JSON.parse(execFileSync(process.execPath, [CLI, "hook", kind, "--host", host, "--room", "dev"], {
        env: environment, input: JSON.stringify(payload), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }));
}

describe("hook CLI", () => {
    it.each(["claude", "codex", "gemini", "cursor", "copilot"])("runs %s lifecycle payloads in separate processes", (host) => {
        const payload = { session_id: "s", sessionId: "s", conversation_id: "s", cwd: directory };
        const started = invoke("session-start", host, payload);
        expect(JSON.stringify(started)).toContain("resume_handle=");
        invoke("prompt", host, payload);
        invoke("turn-end", host, payload);
        invoke("session-end", host, payload);
        const db = new DatabaseSync(path.join(environment.CONCOS_HOME!, "concos.db"));
        try {
            expect(db.prepare("SELECT status, editing_list, disconnected_at FROM agent").get()).toMatchObject({ status: "waiting", editing_list: "[]", disconnected_at: expect.any(String) });
        }
        finally { db.close(); }
    });

    it("returns neutral JSON and exit 0 for malformed, oversized, invalid arguments and unavailable storage", () => {
        for(const input of ["not json", "{}", " ".repeat(1024 * 1024 + 1)]) {
            const result = spawnSync(process.execPath, [CLI, "hook", "turn-end", "--host", "codex", "--room", "dev"], { env: environment, input, encoding: "utf8" });
            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout)).toEqual({});
            expect(result.stderr).toContain("hook skipped");
        }
        const invalid = spawnSync(process.execPath, [CLI, "hook", "bad-event", "--unknown"], { env: environment, encoding: "utf8" });
        expect(invalid.status).toBe(0);
        expect(JSON.parse(invalid.stdout)).toEqual({});
        fs.writeFileSync(environment.CONCOS_HOME!, "not a directory");
        expect(invoke("session-start", "codex", { session_id: "s", cwd: directory })).toEqual({});
    });

    it("serializes simultaneous session registration and additive file edits without duplicates or lost claims", async () => {
        const run = (kind: string, extra: Record<string, unknown> = {}) => new Promise<void>((resolve, reject) => {
            const child = execFile(process.execPath, [CLI, "hook", kind, "--host", "claude", "--room", "dev"], { env: environment }, (error, stdout, stderr) => {
                if(error || stderr.includes("hook skipped")) reject(error ?? new Error(stderr));
                else { JSON.parse(stdout); resolve(); }
            });
            child.stdin!.end(JSON.stringify({ session_id: "same-session", cwd: directory, ...extra }));
        });
        await Promise.all(Array.from({ length: 4 }, () => run("session-start")));
        await Promise.all(Array.from({ length: 4 }, (_, i) => run("file-edited", { tool_name: "Write", tool_input: { file_path: `file-${i}.ts` } })));
        const db = new DatabaseSync(path.join(environment.CONCOS_HOME!, "concos.db"));
        try {
            const rows = db.prepare("SELECT editing_list FROM agent").all() as { editing_list: string }[];
            expect(rows).toHaveLength(1);
            expect(JSON.parse(rows[0].editing_list).sort()).toEqual(["file-0.ts", "file-1.ts", "file-2.ts", "file-3.ts"]);
        }
        finally { db.close(); }
    });

    it("lets the host continue when another writer holds the database lock", () => {
        const payload = { session_id: "s", cwd: directory };
        invoke("session-start", "codex", payload);
        const db = new DatabaseSync(path.join(environment.CONCOS_HOME!, "concos.db"));
        db.exec("BEGIN IMMEDIATE");
        try {
            const result = spawnSync(process.execPath, [CLI, "hook", "turn-end", "--host", "codex", "--room", "dev"], {
                env: environment, input: JSON.stringify(payload), encoding: "utf8", timeout: 3000,
            });
            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout)).toEqual({});
            expect(result.stderr).toContain("hook skipped");
        }
        finally { db.exec("ROLLBACK"); db.close(); }
    });

    it("previews setup without writing and applies only with --apply", () => {
        const args = [CLI, "setup", "--host", "codex"];
        const output = execFileSync(process.execPath, args, { cwd: directory, env: environment, encoding: "utf8" });
        expect(output).toContain("--apply");
        expect(fs.readdirSync(directory)).toEqual([]);
        execFileSync(process.execPath, [...args, "--apply"], { cwd: directory, env: environment });
        expect(fs.existsSync(path.join(directory, "user", ".codex", "hooks.json"))).toBe(false);
        expect(output).not.toContain("concos hook");
        expect(fs.existsSync(path.join(directory, "user", ".codex", "config.toml"))).toBe(true);
    });

    it("registers once for the user regardless of the current project folder", () => {
        const first = path.join(directory, "project-a");
        const second = path.join(directory, "project-b");
        fs.mkdirSync(first);
        fs.mkdirSync(second);
        const args = [CLI, "setup", "--host", "codex", "--apply"];
        execFileSync(process.execPath, args, { cwd: first, env: environment, stdio: "pipe" });
        const configFile = path.join(environment.CODEX_HOME!, "config.toml");
        const before = fs.readFileSync(configFile, "utf8");
        execFileSync(process.execPath, args, { cwd: second, env: environment, stdio: "pipe" });
        expect(fs.readFileSync(configFile, "utf8")).toBe(before);
        expect(fs.readdirSync(first)).toEqual([]);
        expect(fs.readdirSync(second)).toEqual([]);
        // node starts on this cli.js directly, with no concos shim in front
        expect(parseToml(before).mcp_servers).toEqual({ concos: { command: process.execPath, args: ["--max-semi-space-size=1", CLI, "mcp"], env: { CONCOS_HOME: environment.CONCOS_HOME } } });
    });

    it.each(["claude", "codex"])("continues a %s turn once with the questions sent to it, and points at the one it could not carry on the next prompt", (host) => {
        const payload = { session_id: "s", cwd: directory };
        const agentId = /agent_id=(agt_\w+);/.exec(JSON.stringify(invoke("session-start", host, payload)))?.[1] ?? "";
        execFileSync(process.execPath, [CLI, "say", agentId, "Which port?", "--kind", "question", "--as", "Reviewer"], { env: environment, stdio: "pipe" });
        // three of the longest messages: the third would take the text past what a hook may hand over
        for(const letter of ["x", "y", "z"]) {
            execFileSync(process.execPath, [CLI, "say", agentId, letter.repeat(4000), "--kind", "question", "--as", "Reviewer"], { env: environment, stdio: "pipe" });
        }
        const first = invoke("turn-end", host, { ...payload, stop_hook_active: false });
        expect(first.decision).toBe("block");
        expect(first.reason).toMatch(/^concos: unread for you — question #(\d+) from Reviewer; question #\d+ from Reviewer; question #\d+ from Reviewer; 1 more\.\n\n#\1 question from Reviewer:\nWhich port\?\n\n/);
        expect(first.reason.match(/ question from Reviewer:\n/g)).toHaveLength(3);
        expect(first.reason).not.toContain("zzz");
        expect(first.reason).toMatch(/The texts above count as read\. Read the rest with read_messages\. Answer questions with kind reply if they need one, then finish\.$/);
        expect(invoke("turn-end", host, { ...payload, stop_hook_active: true })).toEqual({});
        expect(invoke("turn-end", host, { ...payload, stop_hook_active: false })).toEqual({});
        // the carried one was received when the continued turn ended; the long one is still pointed at
        const prompt = JSON.stringify(invoke("prompt", host, payload));
        expect(prompt).toMatch(/unread for you — question #\d+ from Reviewer\. Read them with read_messages/);
    });

    it("ends the idle-wake hook at once and quietly when there is nothing to watch", () => {
        for(const host of ["claude", "codex"]) {
            const result = spawnSync(process.execPath, [CLI, "hook", "watch", "--host", host], {
                env: environment, input: JSON.stringify({ session_id: "nobody", cwd: directory }), encoding: "utf8", timeout: 10000,
            });
            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout)).toEqual({});
            expect(result.stderr).toBe("");
        }
        const codexWake = spawnSync(process.execPath, [CLI, "setup", "--host", "codex", "--wake", "on"], { cwd: directory, env: environment, encoding: "utf8" });
        expect(codexWake.status, codexWake.stderr).toBe(0);
        expect(codexWake.stdout).toContain("concos hook watch --host codex");
    });

    it("previews and turns on Codex hooks, registering MCP in the same step when it is missing", () => {
        const hooks = (...args: string[]) => spawnSync(process.execPath, [CLI, "setup", "--host", "codex", "--hooks", ...args], { cwd: directory, env: environment, encoding: "utf8" });
        const hooksFile = path.join(environment.CODEX_HOME!, "hooks.json");
        const configFile = path.join(environment.CODEX_HOME!, "config.toml");
        const preview = hooks("on");
        expect(preview.stdout).toContain("mcp_servers.concos");
        expect(preview.stdout).toContain("concos hook turn-end --host codex");
        expect(preview.stdout).toContain("/hooks");
        expect(preview.stdout).toContain("Add --apply to register MCP and turn hooks on.");
        expect(fs.existsSync(hooksFile)).toBe(false);
        expect(fs.existsSync(configFile)).toBe(false);
        expect(hooks("on", "--apply").stdout).toContain("Registered MCP and turned hooks on.");
        expect(parseToml(fs.readFileSync(configFile, "utf8")).mcp_servers).toEqual({ concos: { command: process.execPath, args: ["--max-semi-space-size=1", CLI, "mcp"], env: { CONCOS_HOME: environment.CONCOS_HOME } } });
        // Codex runs hooks in the session's shell, where only the plain command reads the same
        expect(JSON.parse(fs.readFileSync(hooksFile, "utf8")).hooks.Stop[0].hooks[0].command).toBe("concos hook turn-end --host codex");
        expect(hooks("on").stdout).toContain("already on");
        hooks("off", "--apply");
        expect(JSON.parse(fs.readFileSync(hooksFile, "utf8"))).toEqual({ hooks: {} });

        // unregistering takes out the MCP table, and the hooks when they are on
        hooks("on", "--apply");
        const remove = (...args: string[]) => spawnSync(process.execPath, [CLI, "setup", "--host", "codex", "--remove", ...args], { cwd: directory, env: environment, encoding: "utf8" });
        expect(remove().stdout).toContain("Add --apply to remove concos from this client.");
        expect(fs.readFileSync(configFile, "utf8")).toContain("mcp_servers.concos");
        expect(remove("--apply").stdout).toContain("Removed concos from this client.");
        expect(fs.readFileSync(configFile, "utf8")).not.toContain("concos");
        expect(JSON.parse(fs.readFileSync(hooksFile, "utf8"))).toEqual({ hooks: {} });
        expect(remove().stdout).toContain("concos is not registered for Codex CLI.");
    });

    it("registers Claude Code to start node directly, and its hooks run the way Claude Code starts them", () => {
        const home = path.join(directory, "user");
        const claudeEnvironment = { ...environment, HOME: home, USERPROFILE: home };
        const setup = spawnSync(process.execPath, [CLI, "setup", "--host", "claude", "--wake", "on", "--apply"], { cwd: directory, env: claudeEnvironment, encoding: "utf8" });
        expect(setup.status, setup.stderr).toBe(0);
        expect(JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers.concos).toEqual({ command: process.execPath, args: ["--max-semi-space-size=1", CLI, "mcp"] });
        const hooks = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")).hooks;
        const start = hooks.SessionStart[0].hooks[0];
        expect(start).toEqual({ type: "command", command: process.execPath, args: ["--max-semi-space-size=1", CLI, "hook", "session-start", "--host", "claude"], timeout: 10 });
        expect(hooks.Stop[1].hooks[0]).toMatchObject({ args: ["--max-semi-space-size=1", CLI, "hook", "watch", "--host", "claude"], asyncRewake: true });
        // exec form: no shell, the event on stdin
        const output = JSON.parse(execFileSync(start.command, start.args, { env: environment, input: JSON.stringify({ session_id: "s", cwd: directory }), encoding: "utf8" }));
        expect(output.hookSpecificOutput.additionalContext).toContain("resume_handle=");
        // registered again: nothing to update
        expect(spawnSync(process.execPath, [CLI, "setup", "--host", "claude"], { cwd: directory, env: claudeEnvironment, encoding: "utf8" }).stdout).toContain("already registered");
    });

    it("updates an older Codex registration through setup, previewing first", () => {
        const configFile = path.join(environment.CODEX_HOME!, "config.toml");
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, '[mcp_servers.concos]\ncommand = "concos"\nargs = [ "mcp" ]\n');
        const setup = (...args: string[]) => spawnSync(process.execPath, [CLI, "setup", "--host", "codex", ...args], { cwd: directory, env: environment, encoding: "utf8" });
        expect(setup().stdout).toContain("Add --apply to update the registration.");
        expect(parseToml(fs.readFileSync(configFile, "utf8")).mcp_servers).toEqual({ concos: { command: "concos", args: ["mcp"] } });
        expect(setup("--apply").stdout).toContain("Registration updated.");
        expect(parseToml(fs.readFileSync(configFile, "utf8")).mcp_servers).toEqual({ concos: { command: process.execPath, args: ["--max-semi-space-size=1", CLI, "mcp"] } });
        expect(setup().stdout).toContain("already registered");
    });

    it("ends the Codex idle-wake hook at once, leaving the watch to a node of its own that ends with the session", async () => {
        const payload = { session_id: "01a16d85-083e-7373-9dd6-6ae1676b6d7c", cwd: directory };
        invoke("session-start", "codex", payload);
        const generation = () => {
            const db = new DatabaseSync(path.join(environment.CONCOS_HOME!, "concos.db"));
            try { return (db.prepare("SELECT wake_generation FROM agent WHERE host_session_id = :id").get({ id: payload.session_id }) as { wake_generation: number }).wake_generation; }
            finally { db.close(); }
        };
        const before = generation();
        const startedMs = Date.now();
        const hook = spawnSync(process.execPath, [CLI, "hook", "watch", "--host", "codex"], { env: environment, input: JSON.stringify(payload), encoding: "utf8", timeout: 10000 });
        expect(hook.status).toBe(0);
        expect(JSON.parse(hook.stdout)).toEqual({});
        expect(Date.now() - startedMs).toBeLessThan(5000);
        // the watch has started on its own
        for(let attempt = 0; attempt < 50 && generation() == before; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(generation()).toBe(before + 1);

        // that watch, run here in the foreground, ends once the session does
        const watch = spawn(process.execPath, [CLI, "hook", "watch", "--host", "codex"], {
            env: { ...environment, CONCOS_WATCH_EVENT: JSON.stringify({ host: "codex", kind: "watch", sessionId: payload.session_id, cwd: directory, files: [] }) },
            stdio: ["ignore", "pipe", "pipe"],
        });
        const ended = new Promise<number | null>((resolve) => watch.on("exit", (code) => resolve(code)));
        await new Promise((resolve) => setTimeout(resolve, 500));
        invoke("session-end", "codex", payload);
        const code = await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve("still running"), 8000))]);
        expect(code).toBe(0);
        // the detached watch reads the same database and stops the same way
        await new Promise((resolve) => setTimeout(resolve, 3500));
    }, 30000);

    it("rejects project-scoped registration before creating settings", () => {
        const result = spawnSync(process.execPath, [CLI, "setup", "--host", "codex", "--scope", "project", "--apply"], {
            cwd: directory, env: environment, encoding: "utf8",
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("user-wide registration");
        expect(fs.readdirSync(directory)).toEqual([]);
    });
});

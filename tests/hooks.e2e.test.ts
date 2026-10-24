import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
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
        expect(before).toContain('args = [ "mcp" ]');
    });

    it.each(["claude", "codex"])("continues a %s turn once for a question sent to it, and points at it on the next prompt", (host) => {
        const payload = { session_id: "s", cwd: directory };
        const agentId = /agent_id=(agt_\w+);/.exec(JSON.stringify(invoke("session-start", host, payload)))?.[1] ?? "";
        execFileSync(process.execPath, [CLI, "say", agentId, "Which port?", "--kind", "question", "--as", "Reviewer"], { env: environment, stdio: "pipe" });
        const first = invoke("turn-end", host, { ...payload, stop_hook_active: false });
        expect(first.decision).toBe("block");
        expect(first.reason).toMatch(/^concos: unread for you — question #\d+ from Reviewer\. Read them with read_messages/);
        expect(invoke("turn-end", host, { ...payload, stop_hook_active: true })).toEqual({});
        expect(invoke("turn-end", host, { ...payload, stop_hook_active: false })).toEqual({});
        expect(JSON.stringify(invoke("prompt", host, payload))).toContain("question #");
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
        expect(codexWake.stderr).toContain("Claude Code only");
    });

    it("previews and turns on Codex hooks only after MCP is registered", () => {
        const hooks = (...args: string[]) => spawnSync(process.execPath, [CLI, "setup", "--host", "codex", "--hooks", ...args], { cwd: directory, env: environment, encoding: "utf8" });
        expect(hooks("on").stderr).toContain("Register concos MCP");
        execFileSync(process.execPath, [CLI, "setup", "--host", "codex", "--apply"], { cwd: directory, env: environment, stdio: "pipe" });
        const hooksFile = path.join(environment.CODEX_HOME!, "hooks.json");
        const preview = hooks("on");
        expect(preview.stdout).toContain("concos hook turn-end --host codex");
        expect(preview.stdout).toContain("/hooks");
        expect(fs.existsSync(hooksFile)).toBe(false);
        hooks("on", "--apply");
        expect(JSON.parse(fs.readFileSync(hooksFile, "utf8")).hooks.Stop[0].hooks[0].command).toBe("concos hook turn-end --host codex");
        expect(hooks("on").stdout).toContain("already on");
        hooks("off", "--apply");
        expect(JSON.parse(fs.readFileSync(hooksFile, "utf8"))).toEqual({ hooks: {} });
    });

    it("rejects project-scoped registration before creating settings", () => {
        const result = spawnSync(process.execPath, [CLI, "setup", "--host", "codex", "--scope", "project", "--apply"], {
            cwd: directory, env: environment, encoding: "utf8",
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("user-wide registration");
        expect(fs.readdirSync(directory)).toEqual([]);
    });
});

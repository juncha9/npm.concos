import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMenu } from "../src/modules/cli/menu";
import { checkForSelfUpdate, findNpmCli, isGlobalInstallation } from "../src/modules/cli/self-update";
import type { SelfUpdateOptions } from "../src/modules/cli/self-update";

let directory: string;
let cli: string;
let record: string;

function write(file: string, text = ""): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
}

function globalCli(prefix: string, unix = false): string {
    const root = path.join(prefix, ...(unix ? ["lib", "node_modules"] : ["node_modules"]), "concos-mcp");
    write(path.join(root, "package.json"), JSON.stringify({ name: "concos-mcp", version: "0.1.10" }));
    write(unix ? path.join(prefix, "bin", "concos") : path.join(prefix, "concos.cmd"));
    return write(path.join(root, "dist", "cli.js"));
}

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "concos-update-"));
    cli = globalCli(path.join(directory, "prefix with spaces & [test]"));
    record = path.join(directory, "npm-arguments.json");
    vi.stubEnv("CONCOS_HOME", path.join(directory, "data"));
    vi.stubEnv("CODEX_HOME", path.join(directory, "user", ".codex"));
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
});

const metadata = (version = "0.1.11") => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ version })));
const options = (overrides: SelfUpdateOptions = {}): SelfUpdateOptions => ({ cliPath: cli, currentVersion: "0.1.10", fetch: metadata(), npmCli: () => null, ...overrides });

async function menu(answers: string, updateOptions: SelfUpdateOptions | false): Promise<string> {
    const input = Readable.from([answers]);
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += chunk.toString(); });
    await runMenu({ input, output, home: path.join(directory, "user"), selfUpdate: updateOptions });
    expect(input.listenerCount("data")).toBe(0);
    return text;
}

function fakeNpm(code = 0): string {
    // Only this small script is executed, never an installed npm or a registry installation.
    return write(path.join(directory, "npm with spaces & [test]", "bin", "npm-cli.js"),
        `require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ execPath: process.execPath, args: process.argv.slice(2) }));\n`
        + `process.stdout.write("npm output\\n"); process.stderr.write("npm diagnostics\\n"); process.exitCode = ${code};\n`);
}

describe("self-update availability", () => {
    it("accepts both global installation layouts and checks the registry only once across menu returns", async () => {
        expect(isGlobalInstallation(cli)).toBe(true);
        expect(isGlobalInstallation(globalCli(path.join(directory, "unix"), true))).toBe(true);
        const fetch = metadata();
        const output = await menu("update\nn\nquit\n", options({ fetch, npmCli: () => fakeNpm() }));
        expect(output).toContain("Update concos");
        expect(output).toContain("0.1.10 → 0.1.11");
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][0]).toBe("https://registry.npmjs.org/concos-mcp/latest");
        expect(fs.existsSync(record)).toBe(false);
    });

    it("skips checkouts, local dependencies, npx and npm links before contacting the registry", async () => {
        const checkout = write(path.join(directory, "checkout", "dist", "cli.js"));
        const local = write(path.join(directory, "project", "node_modules", "concos-mcp", "dist", "cli.js"));
        const cached = globalCli(path.join(directory, "npm-cache", "_npx", "abc"));
        const linkedRoot = path.join(directory, "linked", "node_modules", "concos-mcp");
        fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
        fs.symlinkSync(path.dirname(path.dirname(checkout)), linkedRoot, "junction");
        write(path.join(directory, "linked", "concos.cmd"));
        for(const cliPath of [checkout, local, cached, path.join(linkedRoot, "dist", "cli.js"), path.join(directory, "missing.js")]) {
            const fetch = metadata();
            expect(await checkForSelfUpdate(options({ cliPath, fetch }))).toBeNull();
            expect(fetch).not.toHaveBeenCalled();
        }
    });

    it.each([
        ["0.1.9", "0.1.10", true], ["0.1.10", "0.1.10", false], ["0.1.11", "0.1.10", false],
        ["0.1.10", "0.2.0", true], ["0.1.11-rc.1", "0.1.11", true],
        ["0.1.10", "0.1.11-rc.1", false], ["0.1.10", "0.1.11; echo surprise", false],
        ["0.1.10", "01.2.3", false], ["invalid", "0.1.11", false],
    ])("compares installed %s with release %s without offering a downgrade or an invalid version", async (currentVersion, latest, available) => {
        const result = await checkForSelfUpdate(options({ currentVersion: currentVersion as string, fetch: metadata(latest as string) }));
        expect(result != null).toBe(available);
    });

    it("quietly leaves the menu usable when offline or registry metadata is unusable", async () => {
        const responses = [
            vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
            vi.fn<typeof fetch>().mockResolvedValue(new Response("unavailable", { status: 503 })),
            vi.fn<typeof fetch>().mockResolvedValue(new Response("invalid JSON")),
            vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ version: 123 }))),
        ];
        for(const fetch of responses) {
            const output = await menu("quit\n", options({ fetch }));
            expect(output).toContain("Enter concos");
            expect(output).not.toContain("Update concos");
            expect(output).not.toContain("offline");
            expect(output).not.toContain("unavailable");
        }
    });

    it.each(["request", "body"])("stops after 1.5 seconds even when the %s ignores cancellation", async (stage) => {
        vi.useFakeTimers();
        const pending = new Promise<never>(() => {});
        const fetch = stage == "request"
            ? vi.fn<typeof globalThis.fetch>().mockImplementation(() => pending)
            : vi.fn<typeof globalThis.fetch>().mockResolvedValue(Object.assign(new Response(), { json: () => pending }));
        const checking = checkForSelfUpdate(options({ fetch }));
        await vi.advanceTimersByTimeAsync(1500);
        expect(await checking).toBeNull();
        expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("can disable checks and keeps registration screens ahead of the main menu check", async () => {
        const output = await menu("quit\n", false);
        expect(output).not.toContain("Update concos");
        const fetch = metadata();
        const input = Readable.from(["back\nquit\n"]);
        const stream = new PassThrough();
        let text = "";
        stream.on("data", (chunk) => { text += chunk.toString(); });
        fetch.mockImplementation(async () => {
            expect(text).toContain("MCP · Registration");
            return new Response(JSON.stringify({ version: "0.1.11" }));
        });
        await runMenu({ input, output: stream, home: path.join(directory, "user"), startWithSetup: true, selfUpdate: options({ fetch }) });
        expect(fetch).toHaveBeenCalledOnce();
    });
});

describe("npm CLI discovery", () => {
    it("finds npm beside node, under a Unix prefix, or through npm's own executable link on PATH", () => {
        const windowsNpm = write(path.join(directory, "windows", "node_modules", "npm", "bin", "npm-cli.js"));
        expect(findNpmCli({ execPath: path.join(directory, "windows", "node.exe"), env: {} })).toBe(fs.realpathSync(windowsNpm));
        const unixNpm = write(path.join(directory, "unix", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
        expect(findNpmCli({ execPath: path.join(directory, "unix", "bin", "node"), env: {} })).toBe(fs.realpathSync(unixNpm));
        expect(findNpmCli({ execPath: path.join(directory, "unknown", "node"), env: { npm_execpath: unixNpm } })).toBe(fs.realpathSync(unixNpm));
        const bin = path.join(directory, "path-bin");
        fs.mkdirSync(bin);
        if(process.platform == "win32") {
            const pathNpm = write(path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"));
            expect(findNpmCli({ execPath: path.join(directory, "unknown", "node.exe"), env: { Path: bin } })).toBe(fs.realpathSync(pathNpm));
        }
        else {
            fs.symlinkSync(unixNpm, path.join(bin, "npm"));
            expect(findNpmCli({ execPath: path.join(directory, "unknown", "node"), env: { PATH: bin } })).toBe(fs.realpathSync(unixNpm));
        }
    });

    it("does not execute a shim or an arbitrary npm_execpath when npm-cli.js cannot be found", () => {
        const other = write(path.join(directory, "other.js"));
        expect(findNpmCli({ execPath: path.join(directory, "unknown", "node.exe"), env: { npm_execpath: other } })).toBeNull();
    });
});

describe("updating from the menu", () => {
    it("previews the exact Node command, installs only after default-yes confirmation, and exits after success", async () => {
        const npmCli = fakeNpm();
        const output = await menu("update\n\n", options({ npmCli: () => npmCli }));
        const installed = JSON.parse(fs.readFileSync(record, "utf8"));
        expect(installed).toEqual({ execPath: process.execPath, args: ["install", "-g", "concos-mcp@0.1.11"] });
        expect(output.indexOf("Command:")).toBeLessThan(output.indexOf("Install this update?"));
        expect(output).toContain(npmCli);
        expect(output).toContain("(Y/n)");
        expect(output).toContain("npm output");
        expect(output).toContain("npm diagnostics");
        expect(output).toContain("Restart concos and your open agent sessions");
        expect(output.match(/concos · Shared waiting room/g)).toHaveLength(1);
    });

    it("shows the manual command without executing or confirming when npm is missing", async () => {
        const output = await menu("update\nquit\n", options());
        expect(output).toContain("Could not find npm's CLI");
        expect(output).toContain("npm install -g concos-mcp@0.1.11");
        expect(output).not.toContain("Install this update?");
        expect(fs.existsSync(record)).toBe(false);
    });

    it("shows installation failures and returns to the menu", async () => {
        const output = await menu("update\ny\nquit\n", options({ npmCli: () => fakeNpm(17) }));
        expect(output).toContain("npm diagnostics");
        expect(output).toContain("Update failed (exit code 17)");
        expect(output.match(/concos · Shared waiting room/g)).toHaveLength(2);
        expect(output).not.toContain("Restart concos and your open agent sessions");
    });
});

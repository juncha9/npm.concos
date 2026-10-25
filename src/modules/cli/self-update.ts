import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CONCOS_VERSION } from "../../_libs/version";
import type { Prompter } from "./prompter";

const PACKAGE_NAME = "concos-mcp";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

export interface SelfUpdateOptions {
    /** Defaults to the running CLI. The overrides keep checks and installs isolated in tests. */
    cliPath?: string;
    currentVersion?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    npmCli?: () => string | null;
}

export interface AvailableUpdate {
    currentVersion: string;
    latestVersion: string;
}

/** Resolving the link first keeps npm link, checkout builds and npx out of global updates. */
export function isGlobalInstallation(script: string): boolean {
    try {
        const real = fs.realpathSync(script);
        const packageRoot = path.dirname(path.dirname(real));
        const modules = path.dirname(packageRoot);
        if(path.basename(real) != "cli.js" || path.basename(path.dirname(real)) != "dist"
            || path.basename(packageRoot) != PACKAGE_NAME || path.basename(modules) != "node_modules"
            || real.split(/[\\/]/).includes("_npx")) return false;
        // Local installs have node_modules/.bin; npm's global bin is alongside node_modules on
        // Windows or in <prefix>/bin beside <prefix>/lib/node_modules on Unix.
        const prefix = path.dirname(modules);
        const bins = ["concos", "concos.cmd", "concos.ps1"].map((name) => path.join(prefix, name));
        if(path.basename(prefix) == "lib") bins.push(path.join(path.dirname(prefix), "bin", "concos"));
        return bins.some((bin) => fs.existsSync(bin) && fs.statSync(bin).isFile());
    }
    catch { return false; }
}

/** npm's entry point, discovered without running a shell, npm, or a shim. */
export function findNpmCli(options: { execPath?: string; env?: NodeJS.ProcessEnv } = {}): string | null {
    const env = options.env ?? process.env;
    const nodeDirectory = path.dirname(options.execPath ?? process.execPath);
    const candidates = [
        env.npm_execpath,
        path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
        path.join(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ];
    for(const directory of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
        const bin = directory.replace(/^"(.*)"$/, "$1");
        candidates.push(
            path.join(bin, "npm"),
            path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
            path.join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
        );
    }
    for(const candidate of candidates) {
        if(!candidate) continue;
        try {
            const real = fs.realpathSync(candidate);
            if(path.basename(real) == "npm-cli.js" && fs.statSync(real).isFile()) return real;
        }
        catch { /* another installation layout or an entry not on this machine */ }
    }
    return null;
}

/** Latest is a stable release; prerelease installations can also move to their stable release. */
function release(version: string): { numbers: bigint[]; prerelease: boolean } | null {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
    if(match == null || match[4]?.split(".").some((part) => /^0\d+$/.test(part))) return null;
    return { numbers: match.slice(1, 4).map(BigInt), prerelease: match[4] != null };
}

function newer(current: string, latest: string): boolean {
    const from = release(current);
    const to = release(latest);
    if(from == null || to == null || to.prerelease) return false;
    for(let index = 0; index < 3; index++) {
        if(to.numbers[index] != from.numbers[index]) return to.numbers[index] > from.numbers[index];
    }
    return from.prerelease;
}

/** One bounded, silent lookup. A fetch or response body that ignores abort cannot hold the menu. */
export async function checkForSelfUpdate(options: SelfUpdateOptions = {}): Promise<AvailableUpdate | null> {
    if(!isGlobalInstallation(options.cliPath ?? process.argv[1] ?? "")) return null;
    const currentVersion = options.currentVersion ?? CONCOS_VERSION;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            (async () => {
                const response = await (options.fetch ?? globalThis.fetch)(REGISTRY_URL, {
                    signal: controller.signal, headers: { accept: "application/json" },
                });
                if(!response.ok) return null;
                const metadata: unknown = await response.json();
                const latestVersion = metadata != null && typeof metadata == "object" && "version" in metadata ? metadata.version : null;
                return typeof latestVersion == "string" && newer(currentVersion, latestVersion)
                    ? { currentVersion, latestVersion } : null;
            })(),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => { controller.abort(); resolve(null); }, options.timeoutMs ?? 1500);
            }),
        ]);
    }
    catch { return null; }
    finally {
        clearTimeout(timer);
        controller.abort();
    }
}

/** Returns true only after a successful install, when the menu must exit its old code. */
export async function showSelfUpdate(prompter: Prompter, update: AvailableUpdate, options: SelfUpdateOptions = {}): Promise<boolean> {
    if(!newer(update.currentVersion, update.latestVersion)) return false;
    const manual = `npm install -g ${PACKAGE_NAME}@${update.latestVersion}`;
    const npmCli = (options.npmCli ?? findNpmCli)();
    prompter.write(`\nUpdate concos · ${update.currentVersion} → ${update.latestVersion}\n`);
    if(npmCli == null) {
        prompter.write(`\nCould not find npm's CLI. Run this command yourself:\n\n  ${manual}\n`);
        await prompter.pause();
        return false;
    }
    const args = [npmCli, "install", "-g", `${PACKAGE_NAME}@${update.latestVersion}`];
    const preview = [process.execPath, ...args].map((word) => /[\s"'&|<>]/.test(word) ? `"${word.replaceAll("\"", "\\\"")}"` : word).join(" ");
    prompter.write(`\nCommand:\n  ${preview}\n`);
    if(!await prompter.askYesNo("Install this update?", true)) return false;
    prompter.write("\nInstalling concos...\n");
    const result = await new Promise<{ code: number | null; signal?: string | null; error?: string }>((resolve) => {
        const child = spawn(process.execPath, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => prompter.write(chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => prompter.write(chunk));
        child.once("error", (error) => resolve({ code: null, error: error.message }));
        child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if(result.code == 0) {
        prompter.write(`\nconcos updated to ${update.latestVersion}. Restart concos and your open agent sessions to use it.\n`);
        return true;
    }
    const reason = result.error ?? (result.signal != null ? `signal ${result.signal}` : `exit code ${result.code}`);
    prompter.write(`\nUpdate failed (${reason}). You can retry or run:\n\n  ${manual}\n`);
    await prompter.pause();
    return false;
}

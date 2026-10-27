import packageJson from "../../package.json" with { type: "json" };

export const CONCOS_VERSION: string = packageJson.version;

/** Orders two `x.y.z` versions by their numbers; a missing or unreadable part counts as 0. */
export function compareVersions(left: string, right: string): number {
    const parts = (version: string) => version.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
    const leftParts = parts(left);
    const rightParts = parts(right);
    for(let index = 0; index < 3; index += 1) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
        if(difference != 0) {
            return difference;
        }
    }
    return 0;
}

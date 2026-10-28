import { defineConfig } from "tsup";

const COPYRIGHT_COMMENT = "/*! concos | Copyright (C) 2026 juncha9 | AGPL-3.0-or-later | https://github.com/juncha9/npm.concos */";

export default defineConfig({
    // takeover.js: what an older running bridge loads to hand its client to this version
    entry: ["src/cli.ts", "src/takeover.ts"],
    format: ["esm"],
    splitting: true,
    platform: "node",
    target: "node22",
    clean: true,
    // node:sqlite exists only under the node: prefix; stripping it makes Node look for an npm package
    removeNodeProtocol: false,
    banner: { js: `#!/usr/bin/env node\n${COPYRIGHT_COMMENT}` },
});

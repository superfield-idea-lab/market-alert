import { $ } from "bun";
import { existsSync, renameSync } from "fs";

const dateStr = new Date().toISOString().replace(/[:.]/g, "-");

if (existsSync("agent-context")) {
    console.log(`Moving existing agent-context to .agent-context-deprecated-${dateStr}`);
    renameSync("agent-context", `.agent-context-deprecated-${dateStr}`);
}

console.log("Downloading agent-context from calypso main branch...");
try {
    // Download the tarball from main, pipe to tar, and extract only the agent-context directory
    // --strip-components=1 removes the root folder from the downloaded tar archive
    await $`curl -sL https://github.com/dot-matrix-labs/calypso/tarball/main | tar xz --strip-components=1 "*/agent-context"`;
    console.log("Successfully updated agent-context.");
} catch (e) {
    console.error("Failed to update agent-context.", e);
    process.exit(1);
}

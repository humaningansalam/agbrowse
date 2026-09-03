// @ts-check
import { defineConfig } from 'vitest/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every Vitest process gets its own browser-agent state root. This prevents
// tests launched by two agents at the same time from touching the real
// ~/.browser-agent store or contending on its global JSON lock.
const testBrowserAgentHome = mkdtempSync(join(tmpdir(), `agbrowse-vitest-${process.pid}-`));
process.once('exit', () => {
    rmSync(testBrowserAgentHome, { recursive: true, force: true });
});

export default defineConfig({
    test: {
        include: ['test/**/*.test.mjs'],
        testTimeout: 30000,
        hookTimeout: 30000,
        fileParallelism: false,
        reporters: 'verbose',
        env: {
            BROWSER_AGENT_HOME: testBrowserAgentHome,
        },
    },
});

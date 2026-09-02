import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_HOME = process.env.BROWSER_AGENT_HOME;
let tmpHome;

beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'agbrowse-shared-target-'));
    process.env.BROWSER_AGENT_HOME = tmpHome;
    vi.resetModules();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../../skills/browser/tab-manager.mjs');
    vi.doUnmock('../../skills/browser/tab-lifecycle.mjs');
    vi.doUnmock('../../web-ai/ax-snapshot.mjs');
    vi.doUnmock('../../web-ai/chatgpt.mjs');
    if (ORIGINAL_HOME === undefined) delete process.env.BROWSER_AGENT_HOME;
    else process.env.BROWSER_AGENT_HOME = ORIGINAL_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
});

describe('web-ai shared target lock guard', () => {
    it('creates a distinct target for every new send without consulting the active tab', async () => {
        const pages = new Map([
            ['target-a', {
                url: vi.fn(() => 'https://chatgpt.com/'),
                context: vi.fn(() => ({ newCDPSession: vi.fn(async () => ({})) })),
            }],
            ['target-b', {
                url: vi.fn(() => 'https://chatgpt.com/'),
                context: vi.fn(() => ({ newCDPSession: vi.fn(async () => ({})) })),
            }],
        ]);
        const createTab = vi.fn()
            .mockResolvedValueOnce({ targetId: 'target-a' })
            .mockResolvedValueOnce({ targetId: 'target-b' });
        const waitForPageByTargetId = vi.fn(async (_port, targetId) => pages.get(targetId));
        const cleanupIdleTabs = vi.fn(async () => ({ closed: [] }));
        const sendWebAi = vi.fn(async deps => {
            const targetId = await deps.getTargetId();
            const page = await deps.getPage();
            return {
                ok: true,
                status: 'sent',
                vendor: 'chatgpt',
                sessionId: `session-${targetId}`,
                targetId,
                url: page.url(),
                warnings: [],
            };
        });
        vi.doMock('../../skills/browser/tab-manager.mjs', () => ({
            createTab,
            getPageByTargetId: vi.fn(async () => null),
            isTabAlive: vi.fn(async () => true),
            probeTabAlive: vi.fn(async () => 'alive'),
            listManagedTabs: vi.fn(async () => []),
            waitForPageByTargetId,
        }));
        vi.doMock('../../skills/browser/tab-lifecycle.mjs', async () => ({
            ...(await vi.importActual('../../skills/browser/tab-lifecycle.mjs')),
            cleanupIdleTabs,
        }));
        vi.doMock('../../web-ai/chatgpt.mjs', async () => ({
            ...(await vi.importActual('../../web-ai/chatgpt.mjs')),
            sendWebAi,
        }));

        const { runWebAiCli } = await import('../../web-ai/cli.mjs');
        const activePageLookup = vi.fn(async () => ({ url: () => 'https://chatgpt.com/c/wrong-active-tab' }));
        const deps = {
            getPort: () => 9222,
            getPage: activePageLookup,
            getBrowserStatus: async () => ({ running: true }),
            readBrowserState: () => ({ headless: false }),
        };
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            const first = await runWebAiCli([
                'send', '--vendor', 'chatgpt', '--inline-only', '--prompt', 'first', '--json',
            ], deps);
            const second = await runWebAiCli([
                'send', '--vendor', 'chatgpt', '--inline-only', '--prompt', 'second', '--json',
            ], deps);

            expect(first).toMatchObject({ sessionId: 'session-target-a', targetId: 'target-a' });
            expect(second).toMatchObject({ sessionId: 'session-target-b', targetId: 'target-b' });
            expect(createTab).toHaveBeenNthCalledWith(1, 9222, 'https://chatgpt.com', {
                activate: false,
                reuseBlank: false,
            });
            expect(createTab).toHaveBeenNthCalledWith(2, 9222, 'https://chatgpt.com', {
                activate: false,
                reuseBlank: false,
            });
            expect(waitForPageByTargetId).toHaveBeenNthCalledWith(1, 9222, 'target-a');
            expect(waitForPageByTargetId).toHaveBeenNthCalledWith(2, 9222, 'target-b');
            expect(cleanupIdleTabs).toHaveBeenCalledTimes(2);
            expect(sendWebAi).toHaveBeenCalledTimes(2);
            expect(activePageLookup).not.toHaveBeenCalled();
        } finally {
            logSpy.mockRestore();
        }
    });

    it('requires sessionId before poll, stop, watch, or snapshot can touch Chrome', async () => {
        const { runWebAiCli } = await import('../../web-ai/cli.mjs');
        const getBrowserStatus = vi.fn(async () => ({ running: true }));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            for (const command of ['poll', 'stop', 'watch', 'snapshot']) {
                const failure = await runWebAiCli([command, '--json'], {
                    getPort: () => 9222,
                    getBrowserStatus,
                    readBrowserState: () => ({ headless: false }),
                }).then(() => null, err => err);

                expect(failure).toMatchObject({
                    errorCode: 'input.session-required',
                    stage: 'input-preflight',
                    retryHint: 'pass-session',
                    evidence: { command },
                });
            }
        } finally {
            errorSpy.mockRestore();
        }

        expect(getBrowserStatus).not.toHaveBeenCalled();
    });

    it('snapshots the session target even when deps.getPage points at another active tab', async () => {
        const pageA = { url: vi.fn(() => 'https://chatgpt.com/c/a') };
        const pageB = { url: vi.fn(() => 'https://chatgpt.com/c/b') };
        const getPageByTargetId = vi.fn(async (_port, targetId) => targetId === 'target-a' ? pageA : null);
        const buildWebAiSnapshot = vi.fn(async page => ({
            snapshotId: 'snapshot-a',
            provider: 'chatgpt',
            url: page.url(),
            domHash: null,
            axHash: 'sha256:a',
            text: 'page-a',
            refs: {},
            stats: { nodeCount: 1, interactiveCount: 0, tokenEstimate: 2 },
        }));
        vi.doMock('../../skills/browser/tab-manager.mjs', () => ({
            createTab: vi.fn(),
            getPageByTargetId,
            isTabAlive: vi.fn(async () => true),
            probeTabAlive: vi.fn(async () => 'alive'),
            listManagedTabs: vi.fn(async () => []),
            waitForPageByTargetId: vi.fn(async () => null),
        }));
        vi.doMock('../../web-ai/ax-snapshot.mjs', () => ({ buildWebAiSnapshot }));

        const { createSession } = await import('../../web-ai/session.mjs');
        const { runWebAiCli } = await import('../../web-ai/cli.mjs');
        const session = createSession(
            { vendor: 'chatgpt', prompt: 'a', attachmentPolicy: 'inline-only' },
            { targetId: 'target-a', conversationUrl: 'https://chatgpt.com/c/a' },
        );
        const activePageLookup = vi.fn(async () => pageB);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            const result = await runWebAiCli(['snapshot', '--session', session.sessionId, '--json'], {
                getPort: () => 9222,
                getPage: activePageLookup,
                getBrowserStatus: async () => ({ running: true }),
                readBrowserState: () => ({ headless: false }),
            });

            expect(result).toMatchObject({
                sessionId: session.sessionId,
                targetId: 'target-a',
                url: 'https://chatgpt.com/c/a',
                text: 'page-a',
            });
            expect(buildWebAiSnapshot).toHaveBeenCalledWith(pageA, expect.any(Object));
            expect(getPageByTargetId).toHaveBeenCalledWith(9222, 'target-a');
            expect(activePageLookup).not.toHaveBeenCalled();
        } finally {
            logSpy.mockRestore();
        }
    });

    it('checks status on the session target even when another tab is active', async () => {
        const pageA = {
            url: vi.fn(() => 'https://chatgpt.com/c/a'),
            context: vi.fn(() => ({ newCDPSession: vi.fn(async () => ({})) })),
        };
        const pageB = { url: vi.fn(() => 'https://chatgpt.com/c/b') };
        const getPageByTargetId = vi.fn(async (_port, targetId) => targetId === 'target-a' ? pageA : null);
        const statusWebAi = vi.fn(async deps => {
            const page = await deps.getPage();
            return { ok: true, vendor: 'chatgpt', status: 'ready', url: page.url(), capabilities: [], warnings: [] };
        });
        vi.doMock('../../skills/browser/tab-manager.mjs', () => ({
            createTab: vi.fn(),
            getPageByTargetId,
            isTabAlive: vi.fn(async () => true),
            probeTabAlive: vi.fn(async () => 'alive'),
            listManagedTabs: vi.fn(async () => []),
            waitForPageByTargetId: vi.fn(async () => null),
        }));
        vi.doMock('../../web-ai/chatgpt.mjs', async () => ({
            ...(await vi.importActual('../../web-ai/chatgpt.mjs')),
            statusWebAi,
        }));

        const { createSession } = await import('../../web-ai/session.mjs');
        const { runWebAiCli } = await import('../../web-ai/cli.mjs');
        const session = createSession(
            { vendor: 'chatgpt', prompt: 'a', attachmentPolicy: 'inline-only' },
            { targetId: 'target-a', conversationUrl: 'https://chatgpt.com/c/a' },
        );
        const activePageLookup = vi.fn(async () => pageB);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            const result = await runWebAiCli(['status', '--session', session.sessionId, '--json'], {
                getPort: () => 9222,
                getPage: activePageLookup,
                getBrowserStatus: async () => ({ running: true }),
                readBrowserState: () => ({ headless: false }),
            });

            expect(result).toMatchObject({
                sessionId: session.sessionId,
                targetId: 'target-a',
                url: 'https://chatgpt.com/c/a',
                status: 'ready',
            });
            expect(statusWebAi).toHaveBeenCalledOnce();
            expect(getPageByTargetId).toHaveBeenCalledWith(9222, 'target-a');
            expect(activePageLookup).not.toHaveBeenCalled();
        } finally {
            logSpy.mockRestore();
        }
    });

    it('documents that stop --session bypasses active-command and session-command locks', async () => {
        const cliSrc = await readSource('web-ai/cli.mjs');
        const runBoundStart = cliSrc.indexOf('async function runBoundCommand');
        const runBoundEnd = cliSrc.indexOf('function isRecoverableTabCrash');
        const runBoundSection = cliSrc.slice(runBoundStart, runBoundEnd);
        const stopStart = runBoundSection.indexOf("if (command === 'stop')");
        const pollStart = runBoundSection.indexOf("if (command === 'poll')");
        const stopBranch = runBoundSection.slice(stopStart, pollStart);

        expect(cliSrc).toContain('runSessionStopInterrupt');
        expect(stopBranch).toContain('runSessionStopInterrupt');
        expect(stopBranch).not.toContain('withSessionCommandLock');
        expect(stopBranch).not.toContain('withWebAiActiveCommand');
    });

    it('stop --session does not release the existing active-command owner row', async () => {
        const page = createMockChatGptPage('https://chatgpt.com/c/stop');
        mockTabManagerPage(page);
        const { createSession } = await import('../../web-ai/session.mjs');
        const { runWebAiCli } = await import('../../web-ai/cli.mjs');
        const { listActiveCommands, registerActiveCommand } = await import('../../web-ai/active-command-store.mjs');
        const session = createSession({ vendor: 'chatgpt', prompt: 'a', attachmentPolicy: 'inline-only' }, { targetId: 'target-stop', conversationUrl: 'https://chatgpt.com/c/stop' });
        await registerActiveCommand({
            commandId: 'owner-command',
            command: 'web-ai poll',
            provider: 'chatgpt',
            sessionId: session.sessionId,
            targetId: 'target-stop',
            owner: 'cli',
            browserProfileKey: '9222',
            ttlMs: 60_000,
        });

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        let result;
        try {
            result = await runWebAiCli(['stop', '--vendor', 'chatgpt', '--session', session.sessionId, '--json'], {
                getPort: () => 9222,
                getBrowserStatus: async () => ({ running: true }),
                readBrowserState: () => ({ headless: false }),
            });
        } finally {
            logSpy.mockRestore();
        }
        const rows = await listActiveCommands({ browserProfileKey: '9222', active: true });
        expect(result).toMatchObject({ ok: true, interrupt: true, sessionId: session.sessionId, targetId: 'target-stop' });
        expect(page.keyboard.press).toHaveBeenCalledWith('Escape');
        expect(rows).toMatchObject([{ commandId: 'owner-command', status: 'running', targetId: 'target-stop' }]);
    });

    it('stop --session resolves the provider from the stored session when --vendor is omitted', async () => {
        const page = createMockChatGptPage('https://gemini.google.com/app/gemini-stop');
        mockTabManagerPage(page);
        const { createSession } = await import('../../web-ai/session.mjs');
        const { runWebAiCli } = await import('../../web-ai/cli.mjs');
        const session = createSession({ vendor: 'gemini', prompt: 'g', attachmentPolicy: 'inline-only' }, {
            targetId: 'target-gemini',
            conversationUrl: 'https://gemini.google.com/app/gemini-stop',
        });

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        let result;
        try {
            result = await runWebAiCli(['stop', '--session', session.sessionId, '--json'], {
                getPort: () => 9222,
                getBrowserStatus: async () => ({ running: true }),
                readBrowserState: () => ({ headless: false }),
            });
        } finally {
            logSpy.mockRestore();
        }

        expect(result).toMatchObject({ ok: true, vendor: 'gemini', interrupt: true, targetId: 'target-gemini' });
        expect(page.keyboard.press).toHaveBeenCalledWith('Escape');
    });

    it('session target-resolution mismatch exposes expected/actual/recovery evidence', async () => {
        const page = createMockChatGptPage('https://chatgpt.com/c/live');
        mockTabManagerPage(page);
        const { createSession } = await import('../../web-ai/session.mjs');
        const { runWebAiCli } = await import('../../web-ai/cli.mjs');
        const session = createSession({ vendor: 'chatgpt', prompt: 'a', attachmentPolicy: 'inline-only' }, {
            targetId: 'target-drift',
            conversationUrl: 'https://chatgpt.com/c/expected',
        });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            await expect(runWebAiCli(['stop', '--session', session.sessionId, '--json'], {
                getPort: () => 9222,
                getBrowserStatus: async () => ({ running: true }),
                readBrowserState: () => ({ headless: false }),
            })).rejects.toMatchObject({
                errorCode: 'cdp.target-mismatch',
                stage: 'target-resolution',
                evidence: {
                    expectedTargetId: 'target-drift',
                    actualTargetId: 'target-drift',
                    port: 9222,
                    recovery: `agbrowse web-ai stop --vendor chatgpt --session ${session.sessionId} --navigate --json`,
                    targetMismatch: {
                        expectedTargetId: 'target-drift',
                        actualTargetId: 'target-drift',
                        port: 9222,
                    },
                },
            });
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('a page death whose recovery cannot verify liveness stays retryable', async () => {
        // `withSessionPage` guards liveness twice: once on entry, once after the
        // callback dies. Only the second one is exercised here — the first probe
        // must succeed so the callback runs at all.
        const page = createMockChatGptPage('https://chatgpt.com/c/live');
        let probes = 0;
        vi.doMock('../../skills/browser/tab-manager.mjs', () => ({
            createTab: vi.fn(async () => { throw new Error('must not create a tab'); }),
            getPageByTargetId: vi.fn(async () => page),
            isTabAlive: vi.fn(async () => true),
            probeTabAlive: vi.fn(async () => {
                probes += 1;
                return probes === 1 ? 'alive' : 'unknown';
            }),
            listManagedTabs: vi.fn(async () => []),
            waitForPageByTargetId: vi.fn(async () => page),
        }));
        const { createSession } = await import('../../web-ai/session.mjs');
        const { withSessionPage } = await import('../../web-ai/tab-recovery.mjs');
        const session = createSession({ vendor: 'chatgpt', prompt: 'a', attachmentPolicy: 'inline-only' }, {
            targetId: 'target-dies',
            conversationUrl: 'https://chatgpt.com/c/live',
        });

        const failure = await withSessionPage(
            { getPort: () => 9222 },
            session.sessionId,
            async () => { throw new Error('Target closed'); },
        ).then(() => null, err => err);

        expect(probes).toBeGreaterThan(1);
        expect(failure).toMatchObject({
            errorCode: 'cdp.unreachable',
            retryHint: 'retry',
            evidence: { liveness: 'unknown' },
        });
    });

    it('unverified liveness is reported as retryable, not as a wrong tab', async () => {
        // The CLI maps resolver outcomes to public errors independently of the
        // resolver itself, so this branch needs its own coverage: advising
        // `--navigate` here would replace a tab we merely could not read.
        const page = createMockChatGptPage('https://chatgpt.com/c/live');
        mockTabManagerUnreadable(page);
        const { createSession } = await import('../../web-ai/session.mjs');
        const { runWebAiCli } = await import('../../web-ai/cli.mjs');
        const session = createSession({ vendor: 'chatgpt', prompt: 'a', attachmentPolicy: 'inline-only' }, {
            targetId: 'target-unreadable',
            conversationUrl: 'https://chatgpt.com/c/live',
        });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const failure = await runWebAiCli(['stop', '--session', session.sessionId, '--json'], {
                getPort: () => 9222,
                getBrowserStatus: async () => ({ running: true }),
                readBrowserState: () => ({ headless: false }),
            }).then(() => null, err => err);

            expect(failure).toMatchObject({
                errorCode: 'cdp.unreachable',
                stage: 'target-resolution',
                retryHint: 'retry',
                evidence: { liveness: 'unknown' },
            });
            // Recovery advice belongs to a tab we know is wrong, not one we
            // could not observe.
            expect(JSON.stringify(failure.evidence || {})).not.toContain('--navigate');
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('ChatGPT target-mismatch result exposes structured recovery evidence', async () => {
        const { createSession, sessionToBaseline } = await import('../../web-ai/session.mjs');
        const { buildTargetMismatchResult } = await import('../../web-ai/session-target-guard.mjs');
        const session = createSession({ vendor: 'chatgpt', prompt: 'a', attachmentPolicy: 'inline-only' }, { targetId: 'expected-target', conversationUrl: 'https://chatgpt.com/c/a' });
        const result = buildTargetMismatchResult({
            vendor: 'chatgpt',
            session,
            actualTargetId: 'actual-target',
            port: 9222,
            url: 'https://chatgpt.com/c/other',
            baseline: sessionToBaseline(session),
        });

        expect(result).toMatchObject({
            ok: false,
            status: 'target-mismatch',
            sessionId: session.sessionId,
            expectedTargetId: 'expected-target',
            actualTargetId: 'actual-target',
            port: 9222,
            recovery: `agbrowse web-ai poll --vendor chatgpt --session ${session.sessionId} --navigate --json`,
            targetMismatch: {
                expectedTargetId: 'expected-target',
                actualTargetId: 'actual-target',
                port: 9222,
            },
        });
    });
});

async function readSource(path) {
    const fs = await import('node:fs/promises');
    return fs.readFile(path, 'utf8');
}

function createMockChatGptPage(url) {
    return {
        url: vi.fn(() => url),
        goto: vi.fn(async () => null),
        keyboard: {
            press: vi.fn(async () => null),
        },
        context: vi.fn(() => ({
            newCDPSession: vi.fn(async () => ({})),
        })),
    };
}

function mockTabManagerPage(page) {
    vi.doMock('../../skills/browser/tab-manager.mjs', () => ({
        createTab: vi.fn(),
        getPageByTargetId: vi.fn(async () => page),
        isTabAlive: vi.fn(async () => true),
        probeTabAlive: vi.fn(async () => 'alive'),
        listManagedTabs: vi.fn(async () => []),
        waitForPageByTargetId: vi.fn(async () => page),
    }));
}

/**
 * The tab list cannot be read, so liveness is unknown for every target.
 *
 * @param {any} page
 * @param {{ pageLookupFails?: boolean }} [options]
 */
function mockTabManagerUnreadable(page, options = {}) {
    vi.doMock('../../skills/browser/tab-manager.mjs', () => ({
        createTab: vi.fn(async () => { throw new Error('must not create a tab'); }),
        getPageByTargetId: vi.fn(async () => (options.pageLookupFails ? null : page)),
        isTabAlive: vi.fn(async () => false),
        probeTabAlive: vi.fn(async () => 'unknown'),
        listManagedTabs: vi.fn(async () => []),
        waitForPageByTargetId: vi.fn(async () => page),
    }));
}

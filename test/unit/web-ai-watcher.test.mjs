import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tabState = vi.hoisted(() => ({ page: null }));
// Lets a test replace the provider poll without also replacing
// `callVendorPoll`, which is where the deadline clamp lives.
const pollState = vi.hoisted(() => ({ impl: null }));
vi.mock('../../web-ai/chatgpt.mjs', async () => {
    const actual = await vi.importActual('../../web-ai/chatgpt.mjs');
    return {
        ...actual,
        pollWebAi: async (/** @type {any} */ deps, /** @type {any} */ input) => (
            pollState.impl
                ? pollState.impl(deps, input)
                : /** @type {any} */ (actual).pollWebAi(deps, input)
        ),
    };
});
vi.mock('../../skills/browser/tab-manager.mjs', () => ({
    isTabAlive: vi.fn(async () => Boolean(tabState.page)),
    // Liveness now has three states; the double must model the one that says
    // "I could not tell", or every consumer reads a missing mock as dead.
    probeTabAlive: vi.fn(async () => (tabState.page ? 'alive' : 'gone')),
    getPageByTargetId: vi.fn(async () => tabState.page),
    createTab: vi.fn(), waitForPageByTargetId: vi.fn(), listManagedTabs: vi.fn(), closeTab: vi.fn(),
}));

import { acquireWatcherSessionLock, hasStreamingIndicator, watchSessionOnce } from '../../web-ai/watcher.mjs';
import { createSession, getSession, updateSession } from '../../web-ai/session.mjs';

const ORIGINAL_HOME = process.env.BROWSER_AGENT_HOME;
let tmpHome;

beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'agbrowse-watcher-cdp-'));
    process.env.BROWSER_AGENT_HOME = tmpHome;
    tabState.page = fakeWatcherPage();
});

afterEach(() => {
    tabState.page = null;
    pollState.impl = null;
    if (ORIGINAL_HOME === undefined) delete process.env.BROWSER_AGENT_HOME;
    else process.env.BROWSER_AGENT_HOME = ORIGINAL_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
});

const watcherSrc = readFileSync(join(process.cwd(), 'web-ai/watcher.mjs'), 'utf8');

describe('web-ai watcher transient-timeout promotion (source-string contract)', () => {
    it('uses generation-fenced writes instead of a long session command lock', () => {
        expect(watcherSrc).toContain('updateSessionForGeneration');
        expect(watcherSrc).toContain('GENERATION_CHANGED');
        expect(watcherSrc).not.toContain('withSessionCommandLock');
    });

    it('promotes a pre-deadline timeout only for the generation that observed it', () => {
        expect(watcherSrc).toMatch(
            /session\.status === 'timeout' && !isDeadlineExpired\(session\.deadlineAt\)[\s\S]*?restorePollingBeforeDeadline\([\s\S]*?generation/,
        );
    });

    it('stops the old watcher when the session generation changes', () => {
        expect(watcherSrc).toContain("status: 'superseded'");
        expect(watcherSrc).toContain("errorCode: 'session.generation-superseded'");
    });

    it('still treats a deadline-expired timeout as terminal', () => {
        expect(watcherSrc).toMatch(/if\s*\(\s*TERMINAL_SESSION_STATUSES\.has\(session\.status\)\s*\)\s*\{[\s\S]*?terminal:\s*true/);
        expect(watcherSrc).toMatch(/if\s*\(\s*isDeadlineExpired\(session\.deadlineAt\)\s*\)\s*\{[\s\S]*?status:\s*'timeout'/);
    });

    it('appends a watcher-resumed-transient-timeout warning when promoting', () => {
        expect(watcherSrc).toContain('watcher-resumed-transient-timeout');
    });
});

describe('web-ai watcher self-heals drifted conversation URL (source-string contract)', () => {
    it('destructures the resolver-healed session from the withSessionPage callback', () => {
        expect(watcherSrc).toMatch(
            /withSessionPageGuarded\(deps, options\.sessionId, async \(\{ page, targetId, session: resolvedSession \}\)/,
        );
    });

    it('feeds the healed session (not the stale outer one) to the attach check', () => {
        expect(watcherSrc).toContain('ensureWatcherAttached(page, resolvedSession || session, options)');
    });

    it('uses the canonical tolerant urlsCompatible predicate imported from tab-recovery', () => {
        expect(watcherSrc).toMatch(/import \{[^}]*withSessionPageGuarded[^}]*urlsCompatible[^}]*\} from '\.\/tab-recovery\.mjs'/);
        expect(watcherSrc).toContain('if (urlsCompatible(targetUrl, currentUrl))');
    });

    it('retires the strict urlsEquivalentForWatch helper', () => {
        expect(watcherSrc).not.toContain('urlsEquivalentForWatch');
    });
});

describe('web-ai watcher streaming guard', () => {
    it('detects ChatGPT stop controls as in-flight streaming', async () => {
        const page = fakeVisibilityPage({
            'button[data-testid="stop-button"]': true,
        });
        await expect(hasStreamingIndicator(page, 'chatgpt')).resolves.toBe(true);
    });

    it('does not treat Gemini completion footers as in-flight streaming', async () => {
        const page = fakeVisibilityPage({
            '.response-footer.complete': true,
            messageActions: true,
            '[aria-label*="Good response" i]': true,
        });
        await expect(hasStreamingIndicator(page, 'gemini')).resolves.toBe(false);
    });

    it('never downgrades completed evidence because an ambient stop control is visible', async () => {
        const session = createWatcherSession();
        const completedAt = new Date().toISOString();
        updateSession(session.sessionId, { status: 'complete', answer: 'done', completedAt });
        tabState.page = fakeVisibilityPage({
            'button[data-testid="stop-button"]': true,
        });

        const result = await watchSessionOnce(baseDeps(), { session: session.sessionId });

        expect(result).toMatchObject({ status: 'complete', terminal: true, answerText: 'done' });
        expect(getSession(session.sessionId)).toMatchObject({
            status: 'complete', answer: 'done', completedAt,
        });
        expect(watcherSrc).not.toContain('watcher-complete-deferred-streaming');
    });
});

describe('watcher lock ownership token', () => {
    it('does not let a stale owner heartbeat or release a replacement lock', () => {
        const sessionId = 'watcher-lock-aba';
        const first = acquireWatcherSessionLock(sessionId, { staleMs: 1 });
        const metadataPath = join(first.lockPath, 'metadata.json');
        const firstMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
        writeFileSync(metadataPath, JSON.stringify({
            ...firstMetadata,
            pid: 2_147_483_646,
            heartbeatAt: '1970-01-01T00:00:00.000Z',
        }));

        const second = acquireWatcherSessionLock(sessionId, { staleMs: 1 });
        const secondMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
        expect(secondMetadata.ownerToken).not.toBe(firstMetadata.ownerToken);

        expect(first.heartbeat({ iteration: 99 })).toBe(false);
        first.release();

        expect(existsSync(metadataPath)).toBe(true);
        expect(JSON.parse(readFileSync(metadataPath, 'utf8')).ownerToken).toBe(secondMetadata.ownerToken);
        second.release();
        expect(existsSync(first.lockPath)).toBe(false);
    });
});

function fakeVisibilityPage(visibleBySelector) {
    return {
        locator: (selector) => ({
            first: () => ({
                isVisible: async () => Boolean(visibleBySelector[selector]),
            }),
        }),
    };
}

describe('watchSessionOnce recoverable CDP disconnect', () => {
    it('classifies a thrown disconnect and performs one bounded reattach poll', async () => {
        const session = createWatcherSession();
        const poll = vi.fn()
            .mockRejectedValueOnce(new Error('WebSocket is not open: readyState 3'))
            .mockResolvedValueOnce({ ok: true, status: 'polling', answerText: '' });
        const recovery = recoveryFakes(poll, { endpointReachable: true, targetFound: true });
        const result = await watchSessionOnce(baseDeps(), { session: session.sessionId }, recovery);
        expect(result.status).toBe('polling');
        expect(recovery.reattachSessionPage).toHaveBeenCalledOnce();
        expect(poll).toHaveBeenCalledTimes(2);
    });

    it('recovers a consumed tab-crashed result once on proven liveness', async () => {
        const session = createWatcherSession();
        const poll = vi.fn()
            .mockResolvedValueOnce(crashedResult())
            .mockImplementationOnce(async (_deps, _vendor, current) => {
                updateSession(current.sessionId, { status: 'complete', answer: 'new answer', completedAt: new Date().toISOString() });
                return { ok: true, status: 'complete', answerText: 'new answer' };
            });
        const recovery = recoveryFakes(poll, { endpointReachable: true, targetFound: true });

        const result = await watchSessionOnce(baseDeps(), { session: session.sessionId }, recovery);

        expect(result).toMatchObject({ status: 'complete', answerText: 'new answer', terminal: true });
        expect(recovery.probeCdpLiveness).toHaveBeenCalledOnce();
        expect(recovery.reattachSessionPage).toHaveBeenCalledOnce();
        expect(poll).toHaveBeenCalledTimes(2);
        expect(getSession(session.sessionId).cdpRecovery.fingerprint).toContain('target-1:connection closed');
    });

    it.each([
        ['endpoint-dead', { endpointReachable: false, targetFound: null, error: 'refused' }],
        ['target-missing', { endpointReachable: true, targetFound: false }],
        ['list-error', { endpointReachable: true, targetFound: null, error: 'list failed' }],
    ])('does not reattach when liveness proof is %s', async (_label, liveness) => {
        const session = createWatcherSession();
        const poll = vi.fn().mockResolvedValue(crashedResult());
        const recovery = recoveryFakes(poll, liveness);
        const result = await watchSessionOnce(baseDeps(), { session: session.sessionId }, recovery);
        expect(result.status).toBe('tab-crashed');
        expect(recovery.reattachSessionPage).not.toHaveBeenCalled();
        expect(getSession(session.sessionId).lastError.evidence.recoverable).toBe(false);
    });

    it('persists the one-attempt bound across two watchSessionOnce calls', async () => {
        const session = createWatcherSession();
        const poll = vi.fn().mockResolvedValue(crashedResult());
        const recovery = recoveryFakes(poll, { endpointReachable: false, targetFound: null });
        await watchSessionOnce(baseDeps(), { session: session.sessionId }, recovery);
        updateSession(session.sessionId, { status: 'polling' });
        await watchSessionOnce(baseDeps(), { session: session.sessionId }, recovery);
        expect(recovery.probeCdpLiveness).toHaveBeenCalledOnce();
        expect(recovery.reattachSessionPage).not.toHaveBeenCalled();
    });

    it('re-reads the finalization checkpoint and skips the second poll', async () => {
        const session = createWatcherSession();
        const poll = vi.fn().mockResolvedValueOnce(crashedResult());
        const recovery = recoveryFakes(poll, { endpointReachable: true, targetFound: true });
        recovery.reattachSessionPage.mockImplementationOnce(async () => {
            updateSession(session.sessionId, { status: 'complete', answer: 'persisted', completedAt: new Date().toISOString() });
            return { page: tabState.page, targetId: 'target-1', session: getSession(session.sessionId) };
        });
        const result = await watchSessionOnce(baseDeps(), { session: session.sessionId }, recovery);
        expect(result).toMatchObject({ status: 'complete', answerText: 'persisted' });
        expect(poll).toHaveBeenCalledOnce();
    });

    it('recovery preserves the session baseline so an older assistant snapshot cannot complete it', async () => {
        const session = createWatcherSession({ envelopeSummary: { assistantCount: 2 } });
        const poll = vi.fn()
            .mockResolvedValueOnce(crashedResult())
            .mockImplementationOnce(async (_deps, _vendor, current) => {
                expect(current.envelopeSummary.assistantCount).toBe(2);
                return { ok: true, status: 'polling', answerText: '' };
            });
        const recovery = recoveryFakes(poll, { endpointReachable: true, targetFound: true });
        const result = await watchSessionOnce(baseDeps(), { session: session.sessionId }, recovery);
        expect(result).toMatchObject({ status: 'polling', answerText: '', terminal: false });
        expect(getSession(session.sessionId).answer).toBeNull();
    });
});

/**
 * A watch tick asks for a fixed slice — 30s by default — and the provider
 * treats an explicit timeout as the caller's authority. Passing the slice
 * through unclamped let a session with under a second of budget left keep
 * polling for another 30 seconds past its own deadline.
 *
 * These drive the REAL `callVendorPoll` (no `recoveryDeps.callVendorPoll`
 * seam) so the clamp is exercised where it lives.
 */
describe('watch does not poll past the session deadline', () => {
    it('clamps the per-poll slice to what the session has left', async () => {
        const session = createWatcherSession({
            deadlineAt: new Date(Date.now() + 4_000).toISOString(),
        });
        const seen = [];
        pollState.impl = async (_deps, input) => {
            seen.push(Number(input.timeout));
            return { ok: true, status: 'polling', answerText: '' };
        };

        await watchSessionOnce(baseDeps(), { session: session.sessionId, pollTimeoutSec: 30 }, {
            probeCdpLiveness: vi.fn(async () => ({ endpointReachable: true, targetFound: true })),
            reattachSessionPage: vi.fn(),
        });

        expect(seen).toHaveLength(1);
        // ~4s left, 30s requested: the slice must follow the deadline.
        expect(seen[0]).toBeLessThanOrEqual(4);
        expect(seen[0]).toBeGreaterThan(0);
    });

    it('does not round a sub-second remainder back up to a whole second', async () => {
        // The first version of this clamp floored at 1s, which is the same
        // defect one order smaller: a session with 400ms left was still handed
        // a full second. A live session really can have under a second on it —
        // the watcher's expiry check runs earlier, and page resolution happens
        // in between.
        const session = createWatcherSession({
            deadlineAt: new Date(Date.now() + 400).toISOString(),
        });
        const seen = [];
        pollState.impl = async (_deps, input) => {
            seen.push(Number(input.timeout));
            return { ok: true, status: 'polling', answerText: '' };
        };

        await watchSessionOnce(baseDeps(), { session: session.sessionId, pollTimeoutSec: 30 }, {
            probeCdpLiveness: vi.fn(async () => ({ endpointReachable: true, targetFound: true })),
            reattachSessionPage: vi.fn(),
        });

        expect(seen).toHaveLength(1);
        expect(seen[0]).toBeLessThan(1);
        expect(seen[0]).toBeGreaterThan(0);
    });

    it('still passes the requested slice when the session has plenty of budget', async () => {
        // The paired assertion: a clamp that always shortened would satisfy the
        // test above and break every ordinary watch tick.
        const session = createWatcherSession({
            deadlineAt: new Date(Date.now() + 600_000).toISOString(),
        });
        const seen = [];
        pollState.impl = async (_deps, input) => {
            seen.push(Number(input.timeout));
            return { ok: true, status: 'polling', answerText: '' };
        };

        await watchSessionOnce(baseDeps(), { session: session.sessionId, pollTimeoutSec: 30 }, {
            probeCdpLiveness: vi.fn(async () => ({ endpointReachable: true, targetFound: true })),
            reattachSessionPage: vi.fn(),
        });

        expect(seen).toEqual([30]);
    });
});

function createWatcherSession(meta = {}) {
    const session = createSession({ vendor: 'chatgpt', prompt: 'test' }, {
        targetId: 'target-1',
        originalUrl: 'https://chatgpt.com/c/1',
        conversationUrl: 'https://chatgpt.com/c/1',
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        ...meta,
    });
    return updateSession(session.sessionId, { status: 'polling' });
}

function baseDeps() {
    return { getPort: () => 9222 };
}

function crashedResult() {
    return { ok: false, status: 'tab-crashed', error: 'Connection closed while polling', warnings: ['tab-crashed-during-poll'] };
}

function recoveryFakes(callVendorPoll, liveness) {
    return {
        probeCdpLiveness: vi.fn(async () => liveness),
        reattachSessionPage: vi.fn(async (_deps, sessionId) => ({
            page: tabState.page, targetId: 'target-1', session: getSession(sessionId),
        })),
        callVendorPoll,
    };
}

function fakeWatcherPage() {
    return {
        url: () => 'https://chatgpt.com/c/1',
        locator: () => ({
            first: () => ({
                isVisible: async () => false,
                waitFor: async () => undefined,
            }),
        }),
        evaluate: async () => '',
    };
}

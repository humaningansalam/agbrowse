import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_HOME = process.env.BROWSER_AGENT_HOME;
let tmpHome;

beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'agbrowse-conversation-target-'));
    process.env.BROWSER_AGENT_HOME = tmpHome;
    vi.resetModules();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../../skills/browser/tab-manager.mjs');
    if (ORIGINAL_HOME === undefined) delete process.env.BROWSER_AGENT_HOME;
    else process.env.BROWSER_AGENT_HOME = ORIGINAL_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
});

describe('exact target plus immutable ChatGPT conversation binding', () => {
    it('fails a live conversation mismatch without navigation or replacement', async () => {
        const page = {
            url: vi.fn(() => 'https://chatgpt.com/c/B-2'),
            goto: vi.fn(),
        };
        const createTab = vi.fn();
        vi.doMock('../../skills/browser/tab-manager.mjs', () => ({
            createTab,
            probeTabAlive: vi.fn(async () => 'alive'),
            getPageByTargetId: vi.fn(async () => page),
            waitForPageByTargetId: vi.fn(),
            listManagedTabs: vi.fn(async () => []),
            closeTab: vi.fn(),
        }));

        const { createSession } = await import('../../web-ai/session.mjs');
        const { resolveSessionPage } = await import('../../web-ai/tab-recovery.mjs');
        const session = createSession(
            { vendor: 'chatgpt', prompt: 'a' },
            { targetId: 'target-a', conversationUrl: 'https://chatgpt.com/c/A-1' },
        );

        const result = await resolveSessionPage(
            { getPort: () => 9222 },
            session.sessionId,
            { allowNavigate: true },
        );

        expect(result).toMatchObject({
            mismatch: true,
            recovered: false,
            strategy: 'existing-tab',
            targetId: 'target-a',
            url: 'https://chatgpt.com/c/B-2',
        });
        expect(result.warnings.join(' ')).toContain('refusing hidden navigation');
        expect(page.goto).not.toHaveBeenCalled();
        expect(createTab).not.toHaveBeenCalled();
    });

    it('does not replace a target that is alive but temporarily unattached', async () => {
        const createTab = vi.fn();
        vi.doMock('../../skills/browser/tab-manager.mjs', () => ({
            createTab,
            probeTabAlive: vi.fn(async () => 'alive'),
            getPageByTargetId: vi.fn(async () => null),
            waitForPageByTargetId: vi.fn(),
            listManagedTabs: vi.fn(async () => []),
            closeTab: vi.fn(),
        }));

        const { createSession } = await import('../../web-ai/session.mjs');
        const { resolveSessionPage } = await import('../../web-ai/tab-recovery.mjs');
        const session = createSession(
            { vendor: 'chatgpt', prompt: 'a' },
            { targetId: 'target-a', conversationUrl: 'https://chatgpt.com/c/A-1' },
        );

        const result = await resolveSessionPage(
            { getPort: () => 9222 },
            session.sessionId,
            { allowNavigate: true },
        );

        expect(result).toMatchObject({
            mismatch: true,
            recovered: false,
            strategy: 'unverified',
            targetId: 'target-a',
        });
        expect(createTab).not.toHaveBeenCalled();
    });

    it('recreates only a proven-gone target at the exact stored conversation URL', async () => {
        let currentUrl = 'about:blank';
        const page = {
            url: vi.fn(() => currentUrl),
            goto: vi.fn(async (url) => { currentUrl = url; }),
            waitForTimeout: vi.fn(async () => undefined),
            locator: vi.fn(() => ({
                first: () => ({ waitFor: async () => undefined }),
                count: async () => 0,
            })),
        };
        const createTab = vi.fn(async () => ({ targetId: 'target-new' }));
        const closeTab = vi.fn(async () => undefined);
        vi.doMock('../../skills/browser/tab-manager.mjs', () => ({
            createTab,
            probeTabAlive: vi.fn(async () => 'gone'),
            getPageByTargetId: vi.fn(async (_port, targetId) => targetId === 'target-new' ? page : null),
            waitForPageByTargetId: vi.fn(async (_port, targetId) => targetId === 'target-new' ? page : null),
            listManagedTabs: vi.fn(async () => []),
            closeTab,
        }));

        const { createSession, getSession } = await import('../../web-ai/session.mjs');
        const { resolveSessionPage } = await import('../../web-ai/tab-recovery.mjs');
        const session = createSession(
            { vendor: 'chatgpt', prompt: 'a' },
            { targetId: 'target-old', conversationUrl: 'https://chatgpt.com/c/A-1' },
        );

        const result = await resolveSessionPage(
            { getPort: () => 9222 },
            session.sessionId,
            { allowNavigate: true },
        );

        expect(result).toMatchObject({
            mismatch: false,
            recovered: true,
            strategy: 'new-tab',
            targetId: 'target-new',
            url: 'https://chatgpt.com/c/A-1',
        });
        expect(createTab).toHaveBeenCalledWith(9222, 'about:blank', {
            activate: false,
            reuseBlank: false,
        });
        expect(page.goto).toHaveBeenCalledWith('https://chatgpt.com/c/A-1', {
            waitUntil: 'load',
            timeout: 30_000,
        });
        expect(closeTab).not.toHaveBeenCalled();
        expect(getSession(session.sessionId)).toMatchObject({
            targetId: 'target-new',
            conversationId: 'A-1',
            conversationUrl: 'https://chatgpt.com/c/A-1',
        });
    });
});

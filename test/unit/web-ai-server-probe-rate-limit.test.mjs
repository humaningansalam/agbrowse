import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readServerResponse } from '../../web-ai/chatgpt-server-response.mjs';

let home, previousHome;
beforeEach(async () => {
    previousHome = process.env.BROWSER_AGENT_HOME;
    home = await mkdtemp(join(tmpdir(), 'agbrowse-probe-429-'));
    process.env.BROWSER_AGENT_HOME = home;
});
afterEach(async () => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.BROWSER_AGENT_HOME;
    else process.env.BROWSER_AGENT_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
});

const session = { vendor: 'chatgpt', conversationId: 'conversation-A', submittedUserMessageId: 'user-A' };
function pageFor({ endpoint = 'auth-session', retryAfter = '120' } = {}) {
    const get = vi.fn(async url => url.endsWith('/api/auth/session') && endpoint === 'conversation'
        ? { status: () => 200, ok: () => true, json: async () => ({ accessToken: 'private-test-token' }), dispose: async () => {} }
        : { status: () => 429, headers: () => ({ 'retry-after': retryAfter }), dispose: async () => {} });
    return { url: () => 'https://chatgpt.com/c/conversation-A', request: { get } };
}

describe('optional server probe throttling is not generation failure', () => {
    it.each(['auth-session', 'conversation'])('distinguishes a 429 from %s and respects its cooldown across callers', async endpoint => {
        const page = pageFor({ endpoint });
        const result = await readServerResponse(page, session);
        expect(result).toMatchObject({ state: 'unknown', reason: 'probe-rate-limited', httpStatus: 429, endpoint });
        expect(Date.parse(result.retryAt) - Date.now()).toBeGreaterThan(115_000);
        const second = pageFor();
        // A freshly imported runtime must see the same persisted cooldown.
        vi.resetModules();
        const fresh = await import('../../web-ai/chatgpt-server-response.mjs');
        expect(await fresh.readServerResponse(second, session)).toMatchObject({ state: 'unknown', reason: 'probe-rate-limited', retryAt: result.retryAt });
        expect(second.request.get).not.toHaveBeenCalled();
        const control = await readFile(join(home, 'web-ai-server-probe-backoff.json'), 'utf8');
        expect(control).not.toContain('private-test-token');
        expect(control).not.toContain(session.submittedUserMessageId);
    });

    it.each(['', 'invalid', '-1'])('backs off even without a usable Retry-After: %s', async retryAfter => {
        const result = await readServerResponse(pageFor({ retryAfter }), session);
        expect(result.state).toBe('unknown');
        expect(Date.parse(result.retryAt) - Date.now()).toBeGreaterThan(55_000);
    });

    it('accepts an HTTP date and probes again only after the cooldown', async () => {
        const now = Math.floor(Date.now() / 1000) * 1000;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        const page = pageFor({ retryAfter: new Date(now + 180_000).toUTCString() });
        const first = await readServerResponse(page, session);
        expect(Date.parse(first.retryAt)).toBe(now + 180_000);
        clock.mockReturnValue(now + 179_000);
        await readServerResponse(page, session);
        expect(page.request.get).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(now + 181_000);
        await readServerResponse(page, session);
        expect(page.request.get).toHaveBeenCalledTimes(2);
    });

    it('honors cooldown in a separate CLI process without a network request', async () => {
        const first = await readServerResponse(pageFor(), session);
        const moduleUrl = new URL('../../web-ai/chatgpt-server-response.mjs', import.meta.url).href;
        const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
            import { readServerResponse } from ${JSON.stringify(moduleUrl)};
            let requests = 0;
            const result = await readServerResponse({ url: () => 'https://chatgpt.com/c/conversation-A',
                request: { get: () => { requests++; throw new Error('must not request'); } } }, ${JSON.stringify(session)});
            console.log(JSON.stringify({ result, requests }));
        `], { env: { ...process.env, BROWSER_AGENT_HOME: home }, timeout: 5000 });
        expect(JSON.parse(stdout)).toMatchObject({ requests: 0,
            result: { state: 'unknown', reason: 'probe-rate-limited', retryAt: first.retryAt } });
    });

    it('serializes concurrent probes before the first 429 establishes the cooldown', async () => {
        const first = pageFor(), second = pageFor();
        let release;
        const response = first.request.get.getMockImplementation();
        first.request.get.mockImplementation(url => new Promise(resolve => { release = () => resolve(response(url)); }));
        const pending = readServerResponse(first, session);
        await vi.waitFor(() => expect(first.request.get).toHaveBeenCalledTimes(1));
        try {
            expect(await readServerResponse(second, session)).toMatchObject({ state: 'unknown', reason: 'probe-busy' });
            expect(second.request.get).not.toHaveBeenCalled();
        } finally { release(); await pending; }
        expect(await readServerResponse(second, session)).toMatchObject({ state: 'unknown', reason: 'probe-rate-limited' });
        expect(second.request.get).not.toHaveBeenCalled();
    });
});

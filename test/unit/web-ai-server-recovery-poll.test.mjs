import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, updateSession, getSession, beginSessionGeneration } from '../../web-ai/session.mjs';
import { pollWebAi } from '../../web-ai/chatgpt.mjs';
import { mergeServerObservation } from '../../web-ai/chatgpt-server-response.mjs';

// Keep the real session store, correlation, poll deadline, and finalizer. Pool
// cleanup itself is covered elsewhere and must not touch a real Chrome here.
vi.mock('../../web-ai/tab-pool.mjs', () => ({ poolTab: vi.fn(async () => ({ pooled: true })) }));
let home, original;
beforeEach(() => { original = process.env.BROWSER_AGENT_HOME; home = mkdtempSync(join(tmpdir(), 'agbrowse-server-poll-')); process.env.BROWSER_AGENT_HOME = home; });
afterEach(() => { if (original === undefined) delete process.env.BROWSER_AGENT_HOME; else process.env.BROWSER_AGENT_HOME = original; rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

function setup({ expired = false, terminal = true } = {}) {
    const session = createSession({ vendor: 'chatgpt', prompt: 'this question' }, {
        targetId: 'target-owned', conversationUrl: 'https://chatgpt.com/c/conv-owned',
        deadlineAt: new Date(Date.now() + (expired ? -60_000 : 60_000)).toISOString(),
    });
    updateSession(session.sessionId, { submittedUserMessageId: 'user-owned',
        ...(expired ? { status: 'timeout', lastError: { errorCode: 'provider.poll-timeout' } } : {}) });
    const conversation = { conversation_id: 'conv-owned', current_node: 'response-owned', mapping: {
        'user-owned': { id: 'user-owned', parent: null, message: { id: 'user-owned', author: { role: 'user' } } },
        'response-owned': { id: 'response-owned', parent: 'user-owned', message: {
            id: 'response-owned', author: { role: 'assistant' }, channel: 'final',
            status: terminal ? 'finished_successfully' : 'in_progress', end_turn: terminal,
            content: { content_type: 'text', parts: ['The exact completed response.\n\n' + '한글'.repeat(6000)] },
        } },
    } };
    const page = { url: () => 'https://chatgpt.com/c/conv-owned',
        request: { get: vi.fn(async url => ({ ok: () => true, status: () => 200, dispose: async () => {},
            json: async () => url.endsWith('/api/auth/session') ? { accessToken: 'test-token' } : conversation })) },
        // Inactive/stale renderer: no DOM response will ever be supplied.
        evaluate: vi.fn(() => new Promise(() => {})),
        locator: vi.fn(() => ({ all: async () => [], count: async () => 0 })),
        waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)),
        bringToFront: vi.fn(), goto: vi.fn(), reload: vi.fn(),
    };
    const deps = { getPage: async () => page, getTargetId: async () => 'target-owned', getPort: () => 19333 };
    return { session: getSession(session.sessionId), page, deps, conversation };
}

describe('poll recovers a completed background response', () => {
    it('rechecks the server after a stalled DOM and recovers a newly finished answer', async () => {
        const { session, page, deps, conversation } = setup({ terminal: false });
        let now = Date.now(), reads = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        page.waitForTimeout = async () => { now += 15_001; };
        const get = page.request.get.getMockImplementation();
        page.request.get.mockImplementation(async (...args) => {
            if (args[0].includes('/backend-api/') && ++reads === 2) {
                conversation.mapping['response-owned'].message.status = 'finished_successfully';
                conversation.mapping['response-owned'].message.end_turn = true;
            }
            return get(...args);
        });
        const result = await pollWebAi(deps, { session: session.sessionId, timeout: 120 });
        expect(reads).toBe(2);
        expect(result).toMatchObject({ status: 'complete', responseMessageId: 'response-owned' });
        expect(page.bringToFront).not.toHaveBeenCalled();
    });

    it.each([false, true])('persists the exact final without activating or reloading, expired=%s', async expired => {
        const { session, page, deps, conversation } = setup({ expired });
        const result = await pollWebAi(deps, { session: session.sessionId, generation: 1, timeout: 2 });
        expect(result).toMatchObject({ ok: true, status: 'complete', sessionId: session.sessionId,
            generation: 1, responseMessageId: 'response-owned', usedFallbacks: ['server-conversation'] });
        expect(result.answerText).toBe(conversation.mapping['response-owned'].message.content.parts[0]);
        expect(getSession(session.sessionId)).toMatchObject({ status: 'complete', answer: result.answerText,
            targetId: 'target-owned', conversationId: 'conv-owned', submittedUserMessageId: 'user-owned', lastError: null });
        expect(page.bringToFront).not.toHaveBeenCalled(); expect(page.goto).not.toHaveBeenCalled(); expect(page.reload).not.toHaveBeenCalled();
    });
    it('recovers an expired generation without an explicit timeout override', async () => {
        const { session, deps } = setup({ expired: true });
        const result = await pollWebAi(deps, { session: session.sessionId });
        expect(result).toMatchObject({ status: 'complete', responseMessageId: 'response-owned' });
        expect(getSession(session.sessionId).deadlineAt).toBe(session.deadlineAt);
    });
    it('returns a recoverable interstitial on HTTP 429 without changing the session', async () => {
        const { session, deps, page } = setup();
        page.request.get.mockResolvedValue({ status: () => 429, dispose: async () => {} });
        const result = await pollWebAi(deps, { session: session.sessionId, timeout: 1 });
        expect(result).toMatchObject({ status: 'blocked', errorCode: 'provider.interstitial',
            stage: 'provider-interstitial', retryHint: 'wait-and-retry', recoverable: true,
            sessionId: session.sessionId, warnings: ['provider-rate-limited'] });
        expect(getSession(session.sessionId)).toEqual(session);
    });
    it('continues only with fresh progress and does not carry it through a failed browser probe', async () => {
        const { session, deps } = setup({ terminal: false });
        const result = await pollWebAi(deps, { session: session.sessionId, timeout: 0.08,
            continuationObservation: { fingerprint: 'earlier-node', state: 'pending' } });
        expect(result).toMatchObject({ ok: true, status: 'polling', terminal: false, progressVerified: true });
        expect(result.errorCode).toBeUndefined();
        expect(result.error).toBeUndefined();
        deps.getPage = () => new Promise(() => {});
        const unverified = await pollWebAi(deps, { session: session.sessionId, timeout: 0.08,
            continuationObservation: result.providerObservation });
        expect(unverified).toMatchObject({ ok: false, status: 'awaiting-response', progressVerified: false,
            providerState: 'unknown', errorCode: 'poll.wait-expired' });
        expect(getSession(session.sessionId).status).toBe('sent');
    });
    it('does not commit when a newer generation begins during the server read', async () => {
        const { session, page, deps } = setup();
        const get = page.request.get.getMockImplementation();
        page.request.get.mockImplementation(async (...args) => {
            const result = await get(...args);
            if (args[0].includes('/backend-api/')) await beginSessionGeneration(session.sessionId, { vendor: 'chatgpt', prompt: 'next question' }, {
                targetId: 'target-owned', conversationUrl: page.url(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
            });
            return result;
        });
        const result = await pollWebAi(deps, { session: session.sessionId, generation: 1, timeout: 1 });
        expect(result.errorCode).toBe('session.generation-superseded');
        expect(getSession(session.sessionId)).toMatchObject({ generation: 2, answer: null, status: 'sent' });
    });
    it('never recovers another branch or another target', async () => {
        const { session, deps, conversation, page } = setup();
        conversation.mapping['response-owned'].parent = 'other-user';
        const result = await pollWebAi(deps, { session: session.sessionId, timeout: 0.08 });
        expect(result.status).not.toBe('complete'); expect(getSession(session.sessionId).answer).toBeNull();
        deps.getTargetId = async () => 'other-target';
        page.request.get.mockClear();
        const mismatch = await pollWebAi(deps, { session: session.sessionId, timeout: 0.2 });
        expect(mismatch.ok).toBe(false); expect(page.request.get).not.toHaveBeenCalled();
    });
    it('does not equate an unchanged in-progress flag with actual progressing work', async () => {
        const { session, deps } = setup({ terminal: false });
        const result = await pollWebAi(deps, { session: session.sessionId, timeout: 0.08 });
        expect(result).toMatchObject({ status: 'awaiting-response', terminal: false, waitExpired: true, progressVerified: false, recoverable: true });
        expect(result.errorCode).toBe('poll.wait-expired');
        expect(getSession(session.sessionId)).toMatchObject({ status: 'sent', answer: null });
    });
    it('does not turn an unobserved expired response into provider failure', async () => {
        const { session, page, deps } = setup({ expired: true });
        page.request.get.mockRejectedValue(new Error('network unavailable'));
        const result = await pollWebAi(deps, { session: session.sessionId, timeout: 0.08 });
        expect(result).toMatchObject({ status: 'awaiting-response', terminal: false, providerState: 'unknown', recoverable: true });
        expect(result.errorCode).toBe('poll.wait-expired');
    });
    it('does not satisfy require-all by substituting text-only server proof', async () => {
        const { session, page, deps } = setup();
        const result = await pollWebAi(deps, { session: session.sessionId, timeout: 0.08, fileArtifactPolicy: 'require-all' });
        expect(result.ok).toBe(false); expect(result.status).not.toBe('complete');
        expect(getSession(session.sessionId).answer).toBeNull(); expect(page.request.get).not.toHaveBeenCalled();
    });
});

describe('progress must be observed, not inferred from a stale indicator', () => {
    it('accepts new provider nodes and expires unchanged evidence', () => {
        const first = mergeServerObservation(null, { state: 'pending', fingerprint: 'a' }, 1000);
        expect(first.progressVerified).toBe(false);
        const next = mergeServerObservation(first, { state: 'pending', fingerprint: 'b' }, 2000);
        expect(next.progressVerified).toBe(true);
        const stale = mergeServerObservation(next, { state: 'pending', fingerprint: 'b' }, 302001);
        expect(stale.progressVerified).toBe(false);
    });
});

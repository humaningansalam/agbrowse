import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_HOME = process.env.BROWSER_AGENT_HOME;
let tmpHome;

beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'agbrowse-session-generation-'));
    process.env.BROWSER_AGENT_HOME = tmpHome;
    vi.resetModules();
});

afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_HOME === undefined) delete process.env.BROWSER_AGENT_HOME;
    else process.env.BROWSER_AGENT_HOME = ORIGINAL_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
});

describe('logical ChatGPT session generations', () => {
    it('creates generation 1 with canonical immutable conversation identity', async () => {
        const { createSession } = await import('../../web-ai/session.mjs');
        const session = createSession(
            { vendor: 'chatgpt', prompt: 'first' },
            {
                targetId: 'target-a',
                conversationUrl: 'https://chat.openai.com/g/example/c/ABC-123/?x=1#fragment',
            },
        );

        expect(session).toMatchObject({
            generation: 1,
            targetId: 'target-a',
            conversationId: 'ABC-123',
            conversationUrl: 'https://chatgpt.com/c/ABC-123',
        });
    });

    it('advances the generation while retaining one session, target and conversation', async () => {
        const { beginSessionGeneration, createSession, getSession, listSessions } = await import('../../web-ai/session.mjs');
        const first = createSession(
            { vendor: 'chatgpt', prompt: 'first' },
            { targetId: 'target-a', conversationUrl: 'https://chatgpt.com/c/A-1' },
        );
        const second = await beginSessionGeneration(
            first.sessionId,
            { vendor: 'chatgpt', prompt: 'second' },
            { targetId: 'target-a', conversationUrl: 'https://chatgpt.com/c/A-1' },
        );

        expect(second).toMatchObject({
            sessionId: first.sessionId,
            generation: 2,
            targetId: 'target-a',
            conversationId: 'A-1',
            conversationUrl: 'https://chatgpt.com/c/A-1',
            status: 'sent',
            answer: null,
        });
        expect(listSessions({ sessionId: first.sessionId })).toHaveLength(1);
        expect(getSession(first.sessionId)?.generation).toBe(2);
    });

    it('rejects every stale-generation write under the store lock', async () => {
        const {
            GENERATION_CHANGED,
            beginSessionGeneration,
            createSession,
            getSession,
            updateSessionForGeneration,
        } = await import('../../web-ai/session.mjs');
        const first = createSession(
            { vendor: 'chatgpt', prompt: 'first' },
            { targetId: 'target-a', conversationUrl: 'https://chatgpt.com/c/A-1' },
        );
        await beginSessionGeneration(
            first.sessionId,
            { vendor: 'chatgpt', prompt: 'second' },
            { targetId: 'target-a', conversationUrl: 'https://chatgpt.com/c/A-1' },
        );

        const stale = await updateSessionForGeneration(first.sessionId, 1, {
            status: 'complete', answer: 'wrong', completedAt: new Date().toISOString(),
        });

        expect(stale).toBe(GENERATION_CHANGED);
        expect(getSession(first.sessionId)).toMatchObject({
            generation: 2,
            status: 'sent',
            answer: null,
        });
    });

    it('rejects rebinding a session to a different durable ChatGPT conversation', async () => {
        const { createSession, updateSession } = await import('../../web-ai/session.mjs');
        const session = createSession(
            { vendor: 'chatgpt', prompt: 'first' },
            { targetId: 'target-a', conversationUrl: 'https://chatgpt.com/c/A-1' },
        );

        expect(() => updateSession(session.sessionId, {
            conversationUrl: 'https://chatgpt.com/c/B-2',
        })).toThrow(expect.objectContaining({
            errorCode: 'session.conversation-mismatch',
            mutationAllowed: false,
        }));
    });

    it('keeps completed evidence immutable until the next generation starts', async () => {
        const { beginSessionGeneration, createSession, getSession, updateSession } = await import('../../web-ai/session.mjs');
        const session = createSession(
            { vendor: 'chatgpt', prompt: 'first' },
            { targetId: 'target-a', conversationUrl: 'https://chatgpt.com/c/A-1' },
        );
        const completedAt = new Date().toISOString();
        updateSession(session.sessionId, { status: 'complete', answer: 'answer-1', completedAt });
        updateSession(session.sessionId, { status: 'polling', answer: null, completedAt: null });

        expect(getSession(session.sessionId)).toMatchObject({
            generation: 1,
            status: 'complete',
            answer: 'answer-1',
            completedAt,
        });

        const next = await beginSessionGeneration(
            session.sessionId,
            { vendor: 'chatgpt', prompt: 'second' },
            { targetId: 'target-a', conversationUrl: 'https://chatgpt.com/c/A-1' },
        );
        expect(next).toMatchObject({ generation: 2, status: 'sent', answer: null, completedAt: null });
    });

    it('returns superseded when a poll is explicitly tied to an older generation', async () => {
        const { pollWebAi } = await import('../../web-ai/chatgpt.mjs');
        const { beginSessionGeneration, createSession } = await import('../../web-ai/session.mjs');
        const session = createSession(
            { vendor: 'chatgpt', prompt: 'first' },
            {
                targetId: 'target-a',
                conversationUrl: 'https://chatgpt.com/c/A-1',
                envelopeSummary: { assistantCount: 0 },
            },
        );
        await beginSessionGeneration(
            session.sessionId,
            { vendor: 'chatgpt', prompt: 'second' },
            {
                targetId: 'target-a',
                conversationUrl: 'https://chatgpt.com/c/A-1',
                envelopeSummary: { assistantCount: 0 },
            },
        );

        const result = await pollWebAi({
            getPage: async () => ({ url: () => 'https://chatgpt.com/c/A-1' }),
        }, {
            vendor: 'chatgpt', session: session.sessionId, generation: 1, timeout: 1,
        });

        expect(result).toMatchObject({
            ok: false,
            status: 'superseded',
            sessionId: session.sessionId,
            generation: 1,
            currentGeneration: 2,
            errorCode: 'session.generation-superseded',
        });
    });

    it('does not let an old finalizer overwrite the newer generation', async () => {
        const { finalizeProviderTab } = await import('../../web-ai/tab-finalizer.mjs');
        const { beginSessionGeneration, createSession, getSession } = await import('../../web-ai/session.mjs');
        const staleSession = createSession(
            { vendor: 'chatgpt', prompt: 'first' },
            { targetId: 'target-a', conversationUrl: 'https://chatgpt.com/c/A-1' },
        );
        await beginSessionGeneration(
            staleSession.sessionId,
            { vendor: 'chatgpt', prompt: 'second' },
            { targetId: 'target-a', conversationUrl: 'https://chatgpt.com/c/A-1' },
        );

        const result = await finalizeProviderTab({ getPort: () => 9222 }, {
            vendor: 'chatgpt',
            session: staleSession,
            generation: 1,
            page: { url: () => 'https://chatgpt.com/c/A-1' },
            answerText: 'stale answer',
        });

        expect(result).toEqual({ finalized: false, reason: 'generation-superseded' });
        expect(getSession(staleSession.sessionId)).toMatchObject({
            generation: 2,
            status: 'sent',
            answer: null,
        });
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readServerResponse, selectServerResponse } from '../../web-ai/chatgpt-server-response.mjs';

let home, previousHome;
beforeEach(async () => {
    previousHome = process.env.BROWSER_AGENT_HOME;
    home = await mkdtemp(join(tmpdir(), 'agbrowse-server-response-'));
    process.env.BROWSER_AGENT_HOME = home;
});
afterEach(async () => {
    if (previousHome === undefined) delete process.env.BROWSER_AGENT_HOME;
    else process.env.BROWSER_AGENT_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
});

const session = { conversationId: 'conversation-A', submittedUserMessageId: 'user-A' };
function fixture() {
    return { conversation_id: 'conversation-A', current_node: 'final-A', mapping: {
        'user-A': { id: 'user-A', parent: null, message: { id: 'user-A', author: { role: 'user' } } },
        'final-A': { id: 'final-A', parent: 'user-A', message: { id: 'final-A', author: { role: 'assistant' }, channel: 'final',
            status: 'finished_successfully', end_turn: true, content: { content_type: 'text', parts: ['정확한 응답'] } } },
    } };
}

describe('server final response correlation', () => {
    it('recovers the final after the exact submitted user, with no DOM/title lookup', () => {
        expect(selectServerResponse(fixture(), session)).toMatchObject({ state: 'complete', responseMessageId: 'final-A', answerText: '정확한 응답' });
    });
    it.each(['wrong-conversation', 'wrong-user', 'other-branch', 'later-user', 'cycle', 'missing-parent'])('rejects %s', kind => {
        const c = fixture(); const s = { ...session };
        if (kind === 'wrong-conversation') c.conversation_id = 'conversation-B';
        if (kind === 'wrong-user') s.submittedUserMessageId = 'user-B';
        if (kind === 'other-branch') { c.mapping['user-B'] = { id: 'user-B', parent: null, message: { id: 'user-B', author: { role: 'user' } } }; c.mapping['final-A'].parent = 'user-B'; }
        if (kind === 'later-user') { c.mapping.next = { id: 'next', parent: 'user-A', message: { id: 'next', author: { role: 'user' } } }; c.mapping['final-A'].parent = 'next'; }
        if (kind === 'cycle') c.mapping['final-A'].parent = 'final-A';
        if (kind === 'missing-parent') c.mapping['final-A'].parent = 'gone';
        expect(selectServerResponse(c, s).state).toBe('unknown');
        expect(selectServerResponse(c, s).answerText).toBeUndefined();
    });
    it.each(['analysis', 'commentary', null])('never treats %s as a final answer', channel => {
        const c = fixture(); c.mapping['final-A'].message.channel = channel;
        const result = selectServerResponse(c, session);
        expect(result.state).not.toBe('complete');
        expect(result.answerText).toBeUndefined();
    });
    it.each(['in_progress', 'incomplete', 'error'])('never completes status %s', status => {
        const c = fixture(); c.mapping['final-A'].message.status = status;
        expect(selectServerResponse(c, session).state).not.toBe('complete');
    });
    it('rejects nonterminal and multimodal finals', () => {
        const c = fixture(); c.mapping['final-A'].message.end_turn = false;
        expect(selectServerResponse(c, session).state).not.toBe('complete');
        c.mapping['final-A'].message.end_turn = true;
        c.mapping['final-A'].message.content.parts.push({ image: 'data' });
        expect(selectServerResponse(c, session)).toMatchObject({ state: 'unknown', reason: 'non-text-final' });
    });
    it('follows tool/commentary ancestors but never returns their content', () => {
        const c = fixture();
        c.mapping.tool = { id: 'tool', parent: 'user-A', message: { id: 'tool', author: { role: 'tool' },
            content: { parts: ['not an answer'] }, status: 'finished_successfully' } };
        c.mapping['final-A'].parent = 'tool';
        expect(selectServerResponse(c, session)).toMatchObject({ state: 'complete', answerText: '정확한 응답' });
        c.current_node = 'tool';
        expect(selectServerResponse(c, session).answerText).toBeUndefined();
    });
});

describe('background-safe, bounded authenticated read', () => {
    function pageFor(conversation = fixture()) {
        const dispose = vi.fn(async () => {});
        const get = vi.fn(async url => ({ ok: () => true, status: () => 200, dispose,
            json: async () => url.endsWith('/api/auth/session') ? { accessToken: 'secret-do-not-expose' } : conversation }));
        return { url: () => 'https://chatgpt.com/c/conversation-A', request: { get }, bringToFront: vi.fn(), evaluate: vi.fn(), dispose };
    }
    it('uses the same context, never activates the tab, never returns the token', async () => {
        const page = pageFor(); const result = await readServerResponse(page, session);
        expect(result.state).toBe('complete');
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(page.bringToFront).not.toHaveBeenCalled(); expect(page.evaluate).not.toHaveBeenCalled();
        expect(page.request.get.mock.calls[1][1]).toMatchObject({ maxRedirects: 0, headers: { Authorization: 'Bearer secret-do-not-expose' } });
        expect(page.dispose).toHaveBeenCalledTimes(2);
    });
    it('does not send credentials to another origin or conversation', async () => {
        const page = pageFor(); page.url = () => 'https://example.com/c/conversation-A';
        expect((await readServerResponse(page, session)).state).toBe('unknown');
        expect(page.request.get).not.toHaveBeenCalled();
    });
    it('bounds a stuck request and never starts the second request after expiry', async () => {
        const page = pageFor(); let release;
        page.request.get.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const result = await readServerResponse(page, session, { timeoutMs: 25 });
        expect(result).toMatchObject({ state: 'unknown', reason: 'probe-timeout' });
        release({ ok: () => true, json: async () => ({ accessToken: 'secret' }), dispose: async () => {} });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(page.request.get).toHaveBeenCalledTimes(1);
    });
});

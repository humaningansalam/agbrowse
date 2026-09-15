import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { launchTransportChromium } from './playwright-launch.mjs';
import { sendWebAi, pollWebAi } from '../../web-ai/chatgpt.mjs';
import { watchSession, watchSessionOnce } from '../../web-ai/watcher.mjs';
import { handleMcpMessage } from '../../web-ai/mcp-server.mjs';
import { assertSessionPollable, createSession, getSession, listSessions, updateSession } from '../../web-ai/session.mjs';

const previousHome = process.env.BROWSER_AGENT_HOME;
const home = mkdtempSync(join(tmpdir(), 'agbrowse-submit-body-'));
process.env.BROWSER_AGENT_HOME = home;
let browser;
beforeAll(async () => { browser = await launchTransportChromium(chromium); });
afterAll(async () => {
    await browser?.close();
    if (previousHome === undefined) delete process.env.BROWSER_AGENT_HOME;
    else process.env.BROWSER_AGENT_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
});

async function makePage(body, conversation = 'fixture') {
    const page = await browser.newPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({
        contentType: 'text/html', body: `<!doctype html><html><head><style>
        .sr-only { position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0); }
        #prompt-textarea { min-height:30px;width:400px; }
        </style></head><body>${body}</body></html>`,
    }));
    await page.goto(conversation ? `https://chatgpt.com/c/${conversation}` : 'https://chatgpt.com/');
    const cdp = await page.context().newCDPSession(page);
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    await cdp.detach();
    return { page, target: targetInfo.targetId, deps: {
        getPage: async () => page,
        getTargetId: async () => targetInfo.targetId,
        getCdpSession: async () => page.context().newCDPSession(page),
    } };
}

describe('submission truth and exact response body in a real renderer', () => {
    it('rejects a missing attachment before creating a session or touching a page', async () => {
        const before = listSessions().length;
        let pageCalls = 0;
        await expect(sendWebAi({ getPage: async () => { pageCalls++; throw Error('must not touch page'); } }, {
            vendor: 'chatgpt', prompt: 'review', filePaths: [join(home, 'missing-file.dart')],
        })).rejects.toMatchObject({ errorCode: 'provider.attachment-preflight', mutationAllowed: false });
        expect(pageCalls).toBe(0);
        expect(listSessions()).toHaveLength(before);
    });

    it.each(['preparing', 'submitting', 'submission-unknown'])('rejects %s instead of emitting a normal watch tick', async status => {
        const session = createSession({ vendor: 'chatgpt', prompt: 'pending' }, { status, targetId: `pending-${status}` });
        const noPage = { getPage: async () => { throw Error('must not touch page'); } };
        expect(() => assertSessionPollable(session)).toThrow(/no confirmed submission/);
        await expect(pollWebAi(noPage, { session: session.sessionId, timeout: 2 })).rejects.toMatchObject({ errorCode: 'session.submission-unverified' });
        await expect(watchSession(noPage, { session: session.sessionId })).rejects.toMatchObject({ errorCode: 'session.submission-unverified' });
        await expect(watchSessionOnce(noPage, { session: session.sessionId })).rejects.toMatchObject({ errorCode: 'session.submission-unverified' });
        // Expired metadata must not turn an unfinished send into a retryable
        // response timeout on either MCP resume surface.
        updateSession(session.sessionId, { deadlineAt: new Date(0).toISOString() });
        for (const name of ['web_ai_wait_response', 'web_ai_session_resume']) {
            let touched = false;
            const reply = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                params: { name, arguments: { sessionId: session.sessionId, timeout: 2 } },
            }, { getPage: async () => { touched = true; throw Error('must not attach'); } });
            expect(reply.result?.isError).toBe(true);
            expect(reply.result?.content?.[0]?.text).toContain('no confirmed submission to poll');
            expect(touched).toBe(false);
        }
        if (status !== 'preparing') {
            await expect(sendWebAi(noPage, { vendor: 'chatgpt', prompt: 'do not duplicate', session: session.sessionId }))
                .rejects.toMatchObject({ errorCode: 'session.submission-unverified' });
            expect(getSession(session.sessionId).generation).toBe(1);
        }
    });

    it('refuses a legacy sent home-page row but accepts an anchored legacy conversation', () => {
        const orphan = createSession({ vendor: 'chatgpt', prompt: 'old failed send' }, { targetId: 'orphan' });
        expect(() => assertSessionPollable(orphan)).toThrow(/no confirmed submission/);
        const legacy = createSession({ vendor: 'chatgpt', prompt: 'old successful send' }, {
            targetId: 'legacy', conversationUrl: 'https://chatgpt.com/c/legacy',
        });
        expect(() => assertSessionPollable(legacy)).not.toThrow();
    });

    it('is submitting at the actual click and only publishes sent after user and conversation binding', async () => {
        const { page, target, deps } = await makePage(`
            <main id="thread"></main><form onsubmit="return false">
            <div contenteditable="true" id="prompt-textarea"></div>
            <button type="button" data-testid="send-button" id="send">Send</button></form>
            <script>document.querySelector('#send').onclick=async()=>{
                await window.recordSubmitState();
                const editor=document.querySelector('#prompt-textarea');
                const user=document.createElement('section'); user.dataset.testid='conversation-turn-1'; user.dataset.turn='user';
                const message=document.createElement('div'); message.dataset.messageId='user-submitted'; message.dataset.messageAuthorRole='user';
                message.textContent=editor.innerText; user.append(message); document.querySelector('#thread').append(user); editor.textContent='';
                history.replaceState(null,'','/c/committed-fixture');
            };</script>`, null);
        let atClick;
        await page.exposeFunction('recordSubmitState', () => {
            atClick = listSessions().find(s => s.targetId === target);
        });
        try {
            const result = await sendWebAi(deps, { vendor: 'chatgpt', prompt: 'Return a number.', timeout: 20 });
            expect(atClick).toMatchObject({ status: 'submitting', submittedUserMessageId: null });
            expect(result).toMatchObject({ ok: true, status: 'sent', submittedUserMessageId: 'user-submitted', conversationId: 'committed-fixture' });
            expect(getSession(result.sessionId)).toMatchObject({ status: 'sent', conversationId: 'committed-fixture', submittedUserMessageId: 'user-submitted' });
        } finally { await page.close(); }
    });

    it('preserves an uncertain submit and refuses duplicate sending after a lost acknowledgement', async () => {
        const { page, target, deps } = await makePage(`
            <main id="thread"></main><form onsubmit="return false">
            <div contenteditable="true" id="prompt-textarea"></div>
            <button type="button" data-testid="send-button" id="send">Send</button></form>
            <script>document.querySelector('#send').onclick=async()=>{
                const editor=document.querySelector('#prompt-textarea');
                const user=document.createElement('section'); user.dataset.testid='conversation-turn-1'; user.dataset.turn='user';
                const message=document.createElement('div'); message.dataset.messageId='committed-with-lost-ack'; message.dataset.messageAuthorRole='user';
                message.textContent=editor.innerText;user.append(message);document.querySelector('#thread').append(user);editor.textContent='';
                await window.loseAcknowledgement();
            };</script>`, null);
        const originalUrl = page.url.bind(page);
        let acknowledgementLost = false;
        await page.exposeFunction('loseAcknowledgement', () => { acknowledgementLost = true; });
        page.url = () => { if (acknowledgementLost) throw Error('simulated URL observation loss after submit'); return originalUrl(); };
        try {
            await expect(sendWebAi(deps, { vendor: 'chatgpt', prompt: 'one submission only', timeout: 20 }))
                .rejects.toMatchObject({ evidence: { promptSubmitted: null } });
            const session = listSessions().find(row => row.targetId === target);
            expect(session).toMatchObject({ status: 'submission-unknown', generation: 1 });
            await expect(sendWebAi(deps, { vendor: 'chatgpt', session: session.sessionId, prompt: 'duplicate' }))
                .rejects.toMatchObject({ errorCode: 'session.submission-unverified' });
            expect(await page.locator('[data-message-author-role="user"]').count()).toBe(1);
            expect(getSession(session.sessionId).generation).toBe(1);
        } finally { page.url = originalUrl; await page.close(); }
    });

    it.each([true, false])('collects all body blocks and sibling completion controls (message id=%s)', async hasMessageId => {
        const { page, target, deps } = await makePage(`
            <main>
            <section data-testid="conversation-turn-1" data-turn="user"><div data-message-author-role="user" data-message-id="u-body">question</div></section>
            <section data-testid="conversation-turn-2" data-turn="assistant">
              <h4 class="sr-only">ChatGPT의 말:</h4><div>tool progress must not become the answer</div>
              <div data-message-author-role="assistant" ${hasMessageId ? 'data-message-id="a-body"' : ''}><div class="markdown">First paragraph.</div><div class="markdown">Second paragraph.</div></div>
              <button data-testid="copy-turn-action-button">Copy response</button>
            </section>
            <section data-testid="conversation-turn-3" data-turn="assistant"><h4 class="sr-only">ChatGPT의 말:</h4></section>
            </main>`, 'body-fixture');
        const session = createSession({ vendor: 'chatgpt', prompt: 'question' }, {
            targetId: target, conversationUrl: page.url(), deadlineAt: new Date(Date.now() + 30_000).toISOString(),
            envelopeSummary: { assistantCount: 0 },
        });
        updateSession(session.sessionId, { submittedUserMessageId: 'u-body', submittedUserTurnId: 'conversation-turn-99' });
        try {
            const result = await pollWebAi(deps, { session: session.sessionId, timeout: 8, skipFinalize: true });
            expect(result).toMatchObject({ ok: true, status: 'complete', sessionId: session.sessionId });
            expect(result.answerText).toContain('First paragraph.');
            expect(result.answerText).toContain('Second paragraph.');
            expect(result.answerText).not.toContain('ChatGPT의 말');
            expect(result.answerText).not.toContain('tool progress');
            expect(getSession(session.sessionId).responseMessageId).toBe(hasMessageId ? 'a-body' : null);
            expect(getSession(session.sessionId).responseTurnId).toBe('conversation-turn-2');
        } finally { await page.close(); }
    });
});

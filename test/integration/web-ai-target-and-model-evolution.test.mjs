import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { chromiumLaunchOptions } from './playwright-launch.mjs';
import { getAvailablePort } from '../helpers/temp-env.mjs';
import { getPageByTargetId } from '../../skills/browser/tab-manager.mjs';
import { selectChatGptModel } from '../../web-ai/chatgpt-model.mjs';
import { buildWebAiSnapshot } from '../../web-ai/ax-snapshot.mjs';
import {
    CHATGPT_ASSISTANT_SELECTORS,
    readAssistantSnapshotSources,
    resolveTopLevelAssistantTurns,
} from '../../web-ai/chatgpt-response-dom.mjs';

describe('shared CDP and evolving ChatGPT UI', () => {
    let browser;
    let port;
    beforeAll(async () => {
        port = Number(await getAvailablePort());
        browser = await chromium.launch({ ...chromiumLaunchOptions(), args: [`--remote-debugging-port=${port}`] });
    });
    afterAll(async () => { await browser?.close(); });

    it('attaches only its target while another renderer is paused, and reconnects without closing either page', async () => {
        const own = await browser.newPage();
        const other = await browser.newPage();
        await own.setContent('<title>target-ownership-fixture</title><p>own</p>');
        const otherCdp = await other.context().newCDPSession(other);
        const ownCdp = await own.context().newCDPSession(own);
        const { targetInfo } = await ownCdp.send('Target.getTargetInfo');
        await ownCdp.detach();
        let resumed = false;
        otherCdp.on('Debugger.resumed', () => { resumed = true; });
        await otherCdp.send('Debugger.enable');
        const pauseObserved = new Promise(resolve => otherCdp.once('Debugger.paused', resolve));
        const blockedEvaluation = otherCdp.send('Runtime.evaluate', { expression: 'debugger; 1' }).catch(() => null);
        await pauseObserved;
        let attached;
        try {
            const started = Date.now();
            attached = await getPageByTargetId(port, targetInfo.targetId);
            expect(attached.context().pages()).toHaveLength(1);
            expect(await attached.title()).toBe('target-ownership-fixture');
            expect(resumed).toBe(false);
            expect(Date.now() - started).toBeLessThan(8000);
            await attached.context().browser().close();
            attached = await getPageByTargetId(port, targetInfo.targetId);
            expect(await attached.locator('p').innerText()).toBe('own');
            expect(other.isClosed()).toBe(false);
            expect(resumed).toBe(false);
        } finally {
            await attached?.context().browser()?.close();
            await otherCdp.send('Debugger.resume').catch(() => {});
            await blockedEvaluation;
            await otherCdp.detach();
            await own.close();
            await other.close();
        }
    });

    it('reports an unreadable snapshot within its bound rather than hanging', async () => {
        const page = { accessibility: { snapshot: () => new Promise(() => {}) } };
        await expect(buildWebAiSnapshot(page, { timeoutMs: 50 })).rejects.toMatchObject({
            errorCode: 'cdp.unreachable', stage: 'snapshot', mutationAllowed: false,
        });
    });

    it('finds a future family without old families and follows labelled, reordered slider stops', async () => {
        const page = await browser.newPage();
        await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: pickerHtml() }));
        await page.goto('https://chatgpt.com/');
        try {
            const selected = await selectChatGptModel(page, 'thinking', { family: 'nova-12-orbit', effort: 'xhigh' });
            expect(selected).toMatchObject({ selected: 'thinking', effort: 'xhigh', modelSelection: { verified: true, familyLabel: 'Nova 12 Orbit' } });
            expect(await page.locator('#slider').getAttribute('aria-valuenow')).toBe('60');
            const pro = await selectChatGptModel(page, 'pro');
            expect(pro).toMatchObject({ selected: 'pro', modelSelection: { verified: true, familyLabel: 'Nova 12 Orbit' } });
            expect(await page.locator('#slider').getAttribute('aria-valuenow')).toBe('20');
        } finally { await page.close(); }
    });

    it('does not relabel Latest as a named model and reports unavailable UI families', async () => {
        const page = await browser.newPage();
        await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: pickerHtml() }));
        await page.goto('https://chatgpt.com/');
        try {
            const latest = await selectChatGptModel(page, 'pro', { family: 'latest' });
            expect(latest.modelSelection).toMatchObject({ familyLabel: 'Latest', normalizedModel: 'pro', verified: true });
            await expect(selectChatGptModel(page, 'pro', { family: 'nonexistent-model' })).rejects.toMatchObject({
                errorCode: 'provider.model-mismatch', evidence: { availableFamilies: ['Latest', 'Nova 12 Orbit'] },
            });
        } finally { await page.close(); }
    });

    it('uses stable message ids after turn renumbering and never collects the next user request', async () => {
        const page = await browser.newPage();
        await page.setContent(`
            <section id="user" data-testid="conversation-turn-8" data-turn="user"><div data-message-author-role="user" data-message-id="u">question</div></section>
            <section data-testid="conversation-turn-9" data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a">right answer</div></section>
            <section data-testid="conversation-turn-10" data-turn="user"><div data-message-author-role="user" data-message-id="next-u">other question</div></section>
            <section data-testid="conversation-turn-11" data-turn="assistant"><div data-message-author-role="assistant" data-message-id="next-a">wrong answer</div></section>
        `);
        const options = {
            assistantSelectors: CHATGPT_ASSISTANT_SELECTORS,
            resolverSource: resolveTopLevelAssistantTurns.toString(),
            submittedUserMessageId: 'u', submittedUserTurnId: 'conversation-turn-9',
        };
        try {
            const first = await page.evaluate(readAssistantSnapshotSources, options);
            expect(first.userAnchorFound).toBe(true);
            expect(first.wrapped.map(row => row.messageId)).toEqual(['a']);
            await page.locator('#user').evaluate(node => node.remove());
            const virtualized = await page.evaluate(readAssistantSnapshotSources, {
                ...options, responseMessageId: 'a', responseTurnId: 'conversation-turn-27',
            });
            expect(virtualized.responseAnchorFound).toBe(true);
            expect(virtualized.wrapped.map(row => row.messageId)).toEqual(['a']);
        } finally { await page.close(); }
    });
});

function pickerHtml() {
    return `<!doctype html><html><body>
    <form><div contenteditable="true" id="prompt-textarea"></div>
      <button type="button" id="picker" class="__composer-pill" aria-haspopup="menu" aria-controls="menu">Pro</button></form>
    <div id="menu" role="menu" data-state="closed" aria-labelledby="picker" style="display:none">
      <div role="menuitem" id="tier-label">Pro</div>
      <div id="slider" role="slider" tabindex="0" aria-valuemin="10" aria-valuemax="60" aria-valuenow="20" aria-valuetext="Pro" style="width:200px;height:30px"></div>
      <div role="menuitemradio" aria-checked="true" data-state="checked">Latest</div>
      <div role="menuitemradio" aria-checked="false" data-state="unchecked">Nova 12 Orbit</div>
    </div>
    <script>
      const menu=document.querySelector('#menu'), picker=document.querySelector('#picker'), slider=document.querySelector('#slider');
      const labels=['Instant','Pro','Medium','Future tier','High','Extra High']; let index=1;
      picker.onclick=()=>{menu.style.display='block';menu.dataset.state='open'};
      document.addEventListener('keydown', e=>{if(e.key==='Escape'){menu.style.display='none';menu.dataset.state='closed'}});
      slider.addEventListener('keydown',e=>{
        if(e.key==='Home') index=0;
        else if(e.key==='ArrowRight') index=Math.min(index+1,labels.length-1);
        else if(e.key==='ArrowLeft') index=Math.max(index-1,0);
        else return;
        e.preventDefault(); slider.setAttribute('aria-valuenow',String(10+index*10));
        slider.setAttribute('aria-valuetext',labels[index]); picker.textContent=labels[index];
        document.querySelector('#tier-label').textContent=labels[index];
      });
      for(const row of document.querySelectorAll('[role="menuitemradio"]'))row.onclick=()=>{
        for(const peer of document.querySelectorAll('[role="menuitemradio"]')){
          peer.setAttribute('aria-checked',String(peer===row));peer.dataset.state=peer===row?'checked':'unchecked';
        }
        menu.style.display='none';menu.dataset.state='closed';
      };
    </script></body></html>`;
}

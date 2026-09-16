import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pollWebAi, queryWebAi } from '../../web-ai/chatgpt.mjs';
import { getSession, listSessions, saveBaseline, updateSession } from '../../web-ai/session.mjs';

// Isolate the on-disk baseline store. web-ai/session.mjs resolves
// BROWSER_AGENT_HOME per call and persists web-ai-baselines.json there;
// without isolation this file races sibling test workers on the shared
// default home (CI flake: a sessionless poll read another worker's baseline
// and returned conversation-mismatch instead of timeout). Every sibling
// baseline-touching test file already isolates this way.
const ORIGINAL_BROWSER_HOME = process.env.BROWSER_AGENT_HOME;
const TEMP_BROWSER_HOME = mkdtempSync(join(tmpdir(), 'agbrowse-fake-chatgpt-'));
process.env.BROWSER_AGENT_HOME = TEMP_BROWSER_HOME;

afterAll(() => {
    if (ORIGINAL_BROWSER_HOME === undefined) delete process.env.BROWSER_AGENT_HOME;
    else process.env.BROWSER_AGENT_HOME = ORIGINAL_BROWSER_HOME;
    rmSync(TEMP_BROWSER_HOME, { recursive: true, force: true });
});

describe('web-ai fake ChatGPT fixture', () => {
    it('fills composer, stores baseline, filters placeholder, and returns final answer', async () => {
        const page = createFakeChatGptPage();
        const result = await queryWebAi({
            getPage: async () => page,
            getCdpSession: async () => ({
                send: async (method, payload) => {
                    if (method === 'Input.insertText') {
                        page.insertedText = payload.text;
                        page.composerValue = payload.text;
                    }
                },
                detach: async () => undefined,
            }),
        }, {
            vendor: 'chatgpt',
            prompt: 'Reply exactly: OK',
            project: 'cli-jaw',
            goal: 'fixture test',
            output: 'one line',
            constraints: 'inline only',
            timeout: 2,
            allowCopyMarkdownFallback: true,
        });

        expect(result.ok).toBe(true);
        expect(result.status).toBe('complete');
        expect(result.answerText).toBe('OK');
        expect(result.answerArtifact).toMatchObject({
            provider: 'chatgpt',
            conversationUrl: 'https://chatgpt.com/c/fake',
            capturedBy: 'copy-button',
            text: 'OK',
            markdown: 'OK',
            exactnessScore: 1,
        });
        expect(result.answerArtifact.responseStableMs).toBeGreaterThanOrEqual(1000);
        expect(result.baseline.assistantCount).toBe(1);
        expect(result.usedFallbacks).toContain('copy-markdown');
        expect(result.baseline.promptHash).toMatch(/^[a-f0-9]{64}$/);
        expect(page.insertedText).toContain('## Question\nReply exactly: OK');
        expect(page.composerResolverValidated).toBe(true);
        expect(page.sendResolverValidated).toBe(true);
        expect(page.copyResolverValidated).toBe(true);
        expect(page.copyMarkdownSelectors[0]).toBe('button[data-testid="copy-turn-action-button"]');
        expect(page.clickedSend).toBe(true);
        expect(page.keys).not.toContain('Enter');
        const session = getSession(result.sessionId);
        const resolverSteps = session.trace.filter(step => step.action === 'target-resolve');
        expect(resolverSteps.map(step => step.intentId)).toEqual(expect.arrayContaining(['composer.fill', 'send.click', 'copy.lastResponse']));
        expect(resolverSteps.every(step => step.status === 'ok')).toBe(true);
        expect(JSON.stringify(resolverSteps)).not.toContain('Reply exactly: OK');
        expect(result.traceSummary).toMatchObject({
            sessionId: result.sessionId,
            totalSteps: 3,
        });
    });

    it('keeps one logical session and advances generation for a later prompt', async () => {
        const page = createFakeChatGptPage();
        const deps = {
            getPage: async () => page,
            getTargetId: async () => 'target-fake',
            getCdpSession: async () => ({
                send: async (method, payload) => {
                    if (method === 'Input.insertText') {
                        page.insertedText = payload.text;
                        page.composerValue = payload.text;
                    }
                    return {};
                },
                detach: async () => undefined,
            }),
        };
        const first = await queryWebAi(deps, {
            vendor: 'chatgpt', prompt: 'first', timeout: 2,
        });
        const second = await queryWebAi(deps, {
            vendor: 'chatgpt', prompt: 'second', timeout: 2,
            session: first.sessionId,
        });

        expect(second.sessionId).toBe(first.sessionId);
        expect(second.generation).toBe(2);
        expect(second.answerText).toBe('OK');
        const rows = listSessions({ vendor: 'chatgpt' })
            .filter((session) => session.sessionId === first.sessionId);
        expect(rows).toHaveLength(1);
        expect(getSession(first.sessionId)).toMatchObject({
            generation: 2,
            conversationId: 'fake',
            conversationUrl: 'https://chatgpt.com/c/fake',
            status: 'complete',
            answer: 'OK',
        });
    });

    it('accepts turn-only identity with scoped controls', async () => {
        const page = createFakeChatGptPage({ identity: 'turn' });
        const result = await runFakeQuery(page);
        expect(result.status).toBe('complete');
    });

    it('accepts message-only identity with scoped controls', async () => {
        const page = createFakeChatGptPage({ identity: 'message' });
        const result = await runFakeQuery(page);
        expect(result.status).toBe('complete');
    });

    it('accepts identity-less completion only at or after the assistant baseline', async () => {
        const page = createFakeChatGptPage({ identity: 'none' });
        const result = await runFakeQuery(page);
        expect(result.status).toBe('complete');
        expect(result.baseline.assistantCount).toBe(1);
    });

    it('requires both identities when both are sampled', async () => {
        const page = createFakeChatGptPage({ mismatchMessageId: true });
        const result = await runFakeQuery(page, { timeout: 1 });
        expect(result.status).not.toBe('complete');
        expect(result.warnings).toContain('recovery-deferred-unverified');
    });

    it('returns deferred unverified when completion evaluation fails in a session', async () => {
        const page = createFakeChatGptPage({ failCompletionEvaluate: true });
        const result = await runFakeQuery(page, { timeout: 1 });
        expect(result).toMatchObject({ status: 'awaiting-response', terminal: false, progressVerified: false });
        expect(result.warnings).toContain('recovery-deferred-unverified');
    });

    it('returns recoverable provider poll-timeout without a session when selectors drift', async () => {
        const page = createFakeChatGptPage({ url: 'https://chatgpt.com/c/non-session-drift', failSnapshotEvaluate: true });
        saveBaseline({
            vendor: 'chatgpt', url: page.url(), envelope: {}, assistantCount: 1, textHash: 'fake',
        });
        // Hermetic "without a session": earlier fixture tests leave sent/polling
        // sessions behind, and a sessionless poll adopts the newest active one
        // (pickActiveSession falls back to active.at(-1)), then fails closed on
        // that session's different conversation URL instead of reaching the
        // timeout path this test asserts.
        for (const leaked of listSessions({ vendor: 'chatgpt' })) {
            updateSession(leaked.sessionId, { status: 'complete' });
        }
        const result = await pollWebAi({ getPage: async () => page }, { vendor: 'chatgpt', timeout: 1 });
        expect(result).toMatchObject({
            status: 'timeout', recoverable: true, error: 'timed out waiting for answer',
        });
    });

    it('returns deferred streaming recovery for the sampled response', async () => {
        const page = createFakeChatGptPage({ streaming: true });
        const result = await runFakeQuery(page, { timeout: 1 });
        expect(result).toMatchObject({ status: 'awaiting-response', terminal: false, progressVerified: false });
        expect(result.warnings).toContain('recovery-deferred-streaming');
    });

    it('does not complete copy-markdown timeout fallback without correlated controls', async () => {
        const page = createFakeChatGptPage({ finishResponse: false });
        const result = await runFakeQuery(page, { timeout: 1, allowCopyMarkdownFallback: true });
        expect(result).toMatchObject({ status: 'awaiting-response', terminal: false, progressVerified: false });
        expect(result.warnings).toContain('recovery-deferred-unverified');
    });

    it('completes an image-only response before the tightened text gate', async () => {
        const outputImage = '/tmp/agbrowse-fake-generated-image.png';
        rmSync(outputImage, { force: true });
        const page = createFakeChatGptPage({ imageOnly: true });
        const previousFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/png' },
        });
        try {
            const result = await runFakeQuery(page, { outputImage }, {
                send: async (method, payload) => {
                    if (method === 'Input.insertText') {
                        page.insertedText = payload.text;
                        page.composerValue = payload.text;
                        return {};
                    }
                    return method === 'Runtime.evaluate'
                    ? { result: { value: [{
                        url: 'https://chatgpt.com/backend-api/estuary/content?id=file_fake',
                        fileId: 'file_fake', alt: 'Generated image', width: 512, height: 512,
                    }] } }
                    : method === 'Network.getCookies' ? { cookies: [] } : {};
                },
                detach: async () => undefined,
            });
            expect(result).toMatchObject({ status: 'complete', answerText: expect.stringContaining('Generated image.') });
            expect(result.usedFallbacks).toContain('generated-image');
        } finally {
            globalThis.fetch = previousFetch;
            rmSync(outputImage, { force: true });
        }
    });

});

function createFakeChatGptPage(options = {}) {
    const page = {
        composerValue: '',
        insertedText: '',
        keys: [],
        assistantTexts: ['old answer'],
        userTurns: [{ messageId: 'u0', turnId: 'conversation-user-0', text: 'old question' }],
        assistantTurns: [{
            text: 'old answer', messageId: 'm0', turnId: 'conversation-turn-0', finished: true,
            afterUserMessageId: 'u0', afterUserTurnId: 'conversation-user-0',
        }],
        options,
        turnTexts: ['old answer'],
        clickedSend: false,
        composerResolverValidated: false,
        sendResolverValidated: false,
        copyResolverValidated: false,
        copyMarkdownSelectors: [],
        url: () => options.url || 'https://chatgpt.com/c/fake',
        keyboard: {
            insertText: async text => {
                page.insertedText = text;
                page.composerValue = text;
            },
            press: async key => {
                page.keys.push(key);
                if (key === 'Enter') commitPrompt(page);
            },
        },
        innerText: async selector => selector === 'body' ? page.assistantTexts.join('\n') : '',
        waitForTimeout: async () => {
            if (page.assistantTexts.at(-1) === 'Pro thinking...') {
                page.assistantTexts[page.assistantTexts.length - 1] = 'OK';
                const text = options.imageOnly ? 'Edit' : 'OK';
                page.assistantTexts[page.assistantTexts.length - 1] = text;
                Object.assign(page.assistantTurns.at(-1), { text, finished: options.finishResponse !== false });
            }
        },
        evaluate: async (_fn, arg, legacySendSelectors) => {
            if (_fn?.name === 'readLatestUserTurnIdentity') {
                const user = page.userTurns.at(-1);
                return user ? { messageId: user.messageId, turnId: user.turnId } : null;
            }
            if (_fn?.name === 'readAssistantSnapshotSources') {
                const submittedUser = page.userTurns.findLast(user =>
                    (!arg?.submittedUserMessageId || user.messageId === arg.submittedUserMessageId)
                    && (!arg?.submittedUserTurnId || user.turnId === arg.submittedUserTurnId));
                let turns = submittedUser
                    ? page.assistantTurns.filter(turn =>
                        turn.afterUserMessageId === submittedUser.messageId
                        || turn.afterUserTurnId === submittedUser.turnId)
                    : [];
                const responseAnchorExpected = Boolean(arg?.responseMessageId || arg?.responseTurnId);
                const responseAnchorFound = responseAnchorExpected && page.assistantTurns.some(turn =>
                    (!arg?.responseMessageId || turn.messageId === arg.responseMessageId)
                    && (!arg?.responseTurnId || turn.turnId === arg.responseTurnId));
                if (!submittedUser && responseAnchorFound) {
                    turns = page.assistantTurns.filter(turn =>
                        (!arg?.responseMessageId || turn.messageId === arg.responseMessageId)
                        && (!arg?.responseTurnId || turn.turnId === arg.responseTurnId));
                }
                return {
                    ok: true,
                    userAnchorExpected: Boolean(arg?.submittedUserMessageId || arg?.submittedUserTurnId),
                    userAnchorFound: Boolean(submittedUser),
                    responseAnchorExpected,
                    responseAnchorFound,
                    wrapped: turns.map((turn, turnIndex) => ({
                        ...turn, turnIndex, source: 'wrapped', domOrder: turnIndex,
                    })),
                    wrapperless: [],
                };
            }
            if (_fn?.name === 'readTopLevelAssistantSnapshots') {
                if (options.failSnapshotEvaluate) throw new Error('snapshot evaluate failed');
                return page.assistantTurns.map((turn, turnIndex) => ({ ...turn, turnIndex }));
            }
            if (_fn?.name === 'readChatGptStreamingState') return options.streaming === true;
            // The turn-ordering gate must be answered explicitly. Falling through
            // to `null` used to read as "verified ordered", which meant the gate
            // could be deleted from production without failing a single test.
            if (_fn?.name === 'readAssistantTurnOrderingInPage') {
                return options.turnOrdering || 'ordered';
            }
            if (String(_fn).includes('finishedSelector') && arg?.sample) {
                if (options.failCompletionEvaluate) throw new Error('evaluate failed');
                const turnIndex = page.assistantTurns.findLastIndex(turn =>
                    (!arg.sample.messageId || turn.messageId === arg.sample.messageId)
                    && (!arg.sample.turnId || turn.turnId === arg.sample.turnId));
                const turn = page.assistantTurns[turnIndex];
                return {
                    finished: options.mismatchMessageId ? false : Boolean(turn?.finished),
                    messageId: options.mismatchMessageId ? 'different-message' : turn?.messageId || null,
                    turnId: turn?.turnId || null,
                    turnIndex,
                };
            }
            if (typeof arg === 'string' && arg.includes('copy-turn-action-button')) {
                const lastAnswer = page.assistantTexts.at(-1) || '';
                return lastAnswer && lastAnswer !== 'Pro thinking...';
            }
            if (arg?.selectorSet?.copyButtonSelectors) {
                page.copyMarkdownSelectors = arg.selectorSet.copyButtonSelectors;
                return { ok: true, text: 'OK' };
            }
            const sendSelectors = Array.isArray(legacySendSelectors) ? legacySendSelectors : arg?.sendSelectors;
            if (!Array.isArray(sendSelectors)) return null;
            commitPrompt(page);
            return 'clicked';
        },
        locator: selector => createFakeLocator(page, selector),
    };
    return page;
}

function createFakeLocator(page, selector) {
    const isComposer = selector.includes('prompt-textarea') || selector.includes('composer-textarea') || selector.includes('ProseMirror') || selector.includes('contenteditable');
    const isSendButton = selector.includes('send-button') || selector.includes('composer-send') || selector.includes('button[type="submit"]') || selector.includes('aria-label*="Send"');
    const isCopyButton = selector.includes('copy-turn-action-button') || selector.includes('aria-label*="Copy"');
    const isTurn = selector.includes('conversation-turn') || selector.includes('data-message-author-role') || selector.includes('data-turn');
    const isAssistant = selector.includes('assistant');
    return {
        first: () => createFakeLocator(page, selector),
        evaluateAll: async () => false,
        count: async () => {
            if (isComposer || isSendButton) return 1;
            if (isCopyButton) return 1;
            if (isAssistant) return page.assistantTexts.length;
            if (isTurn) return page.turnTexts.length;
            return 0;
        },
        waitFor: async () => undefined,
        isVisible: async () => isComposer || isSendButton || isCopyButton,
        isEnabled: async () => true,
        isEditable: async () => isComposer,
        fill: async value => { page.composerValue = value; },
        click: async () => {
            if (isSendButton) commitPrompt(page);
        },
        evaluate: async fn => {
            if (isComposer && typeof fn === 'function') {
                page.composerResolverValidated = true;
                return { role: 'textbox', label: 'Message ChatGPT', tagName: 'textarea', isEditable: true };
            }
            if (isSendButton && typeof fn === 'function') {
                page.sendResolverValidated = true;
                return { role: 'button', label: 'Send message', tagName: 'button', isEditable: false };
            }
            if (isCopyButton && typeof fn === 'function') {
                page.copyResolverValidated = true;
                return { role: 'button', label: 'Copy', tagName: 'button', isEditable: false };
            }
            if (isSendButton) return false;
            if (isComposer && page.composerValue) return undefined;
            if (typeof fn === 'function') return undefined;
            return undefined;
        },
        inputValue: async () => page.composerValue,
        innerText: async () => isComposer ? page.composerValue : '',
        all: async () => {
            if (isAssistant) return page.assistantTexts.map(text => ({ innerText: async () => text }));
            if (isTurn) return page.turnTexts.map(text => ({ innerText: async () => text }));
            return [];
        },
    };
}

function commitPrompt(page) {
    page.clickedSend = true;
    const userIndex = page.userTurns.length;
    const userTurn = {
        text: page.composerValue,
        messageId: `u${userIndex}`,
        turnId: `conversation-user-${userIndex}`,
    };
    page.userTurns.push(userTurn);
    page.turnTexts.push(page.composerValue);
    page.composerValue = '';
    page.assistantTexts.push('Pro thinking...');
    page.assistantTurns.push({
        text: 'Pro thinking...',
        messageId: ['turn', 'none'].includes(page.options.identity) ? null : `m${page.assistantTurns.length}`,
        turnId: ['message', 'none'].includes(page.options.identity) ? null : `conversation-turn-${page.assistantTurns.length}`,
        afterUserMessageId: userTurn.messageId,
        afterUserTurnId: userTurn.turnId,
        finished: false,
    });
    page.turnTexts.push('Pro thinking...');
}

async function runFakeQuery(page, input = {}, cdpOverride = null) {
    return queryWebAi({
        getPage: async () => page,
        getCdpSession: async () => cdpOverride || ({
            send: async (method, payload) => {
                if (method === 'Input.insertText') {
                    page.insertedText = payload.text;
                    page.composerValue = payload.text;
                }
                return {};
            },
            detach: async () => undefined,
        }),
    }, {
        vendor: 'chatgpt', prompt: 'Reply exactly: OK', project: 'fixture', goal: 'test',
        output: 'one line', constraints: 'inline only', timeout: 2,
        ...input,
    });
}

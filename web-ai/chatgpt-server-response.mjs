// @ts-check
import { createHash } from 'node:crypto';
import { extractDurableConversationId } from './conversation-url.mjs';
import { withPollDeadline } from './poll-deadline.mjs';

const HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

/** Exact Chat conversations can be reconciled even after a stored wait expired. */
export function canReconcileChatGptSession(session) {
    return session?.vendor === 'chatgpt' && Boolean(session.submittedUserMessageId)
        && Boolean(session.conversationId || extractDurableConversationId(session.conversationUrl))
        && session.researchMode !== 'deep' && session.envelopeSummary?.surface !== 'work'
        && session.surface !== 'work' && session.sessionType !== 'deep-research';
}

/** Do not label an unchanged provider snapshot as indefinitely advancing. */
export function mergeServerObservation(previous, next, now = Date.now()) {
    const changed = Boolean(next.fingerprint) && next.fingerprint !== previous?.fingerprint;
    const lastProgressAt = changed ? new Date(now).toISOString() : previous?.lastProgressAt || null;
    const advancing = ['generating', 'pending'].includes(next.state)
        && ((changed && Boolean(previous?.fingerprint)) || previous?.progressVerified === true);
    return { ...next, answerText: undefined, lastProgressAt,
        state: advancing ? 'generating' : next.state,
        progressVerified: advancing
            && Number.isFinite(Date.parse(lastProgressAt || ''))
            && now - Date.parse(lastProgressAt) < 5 * 60_000 };
}

/** A per-call bound; a past generation deadline does not erase its answer. */
export function chatGptReconcileTimeoutSec(input, session, fallbackSec = 30) {
    const explicit = Number(input?.timeout);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const remaining = (Date.parse(session?.deadlineAt || '') - Date.now()) / 1000;
    return Number.isFinite(remaining) && remaining > 0 ? remaining : fallbackSec;
}

/**
 * Only inspect the current branch after the EXACT submitted user message.
 * Titles, turn numbers, newest timestamps, and other branches are not identity.
 * Only final-channel text is an answer; tool/reasoning/commentary is never one.
 * @param {any} conversation
 * @param {any} session
 * @returns {any}
 */
export function selectServerResponse(conversation, session) {
    const cid = session?.conversationId || extractDurableConversationId(session?.conversationUrl);
    const userId = session?.submittedUserMessageId;
    const unknown = reason => ({ state: 'unknown', source: 'conversation', reason });
    if (!cid || !userId) return unknown('submitted-message-identity-missing');
    if (!conversation || (conversation.conversation_id || conversation.id) !== cid) return unknown('conversation-mismatch');
    const mapping = conversation.mapping;
    if (!mapping || typeof mapping !== 'object' || !conversation.current_node) return unknown('branch-unavailable');
    const seen = new Set(), chain = [];
    let id = conversation.current_node;
    while (id) {
        if (seen.has(id) || seen.size >= 100_000) return unknown('invalid-branch');
        seen.add(id);
        const node = mapping[id];
        if (!node || node.id !== id) return unknown('invalid-branch');
        chain.push(node);
        if (node.message?.id === userId && node.message?.author?.role === 'user') break;
        id = node.parent;
    }
    if (chain.at(-1)?.message?.id !== userId) return unknown('submitted-message-not-in-current-branch');
    const descendants = chain.slice(0, -1).reverse();
    if (descendants.some(node => node.message?.author?.role === 'user')) return unknown('later-user-in-current-branch');
    const tail = descendants.at(-1)?.message;
    // Hash structural progress, not private reasoning text. No raw conversation
    // or authentication material is exposed to the caller or persisted.
    const fingerprint = createHash('sha256').update(JSON.stringify(descendants.map(node => [
        node.id, node.message?.status, node.message?.update_time,
        node.message?.metadata?.finished_duration_sec,
        // Public final-channel text can grow within one node. Never hash or
        // return private reasoning content as a progress/answer surrogate.
        node.message?.channel === 'final' && Array.isArray(node.message?.content?.parts)
            ? createHash('sha256').update(JSON.stringify(node.message.content.parts.filter(part => typeof part === 'string'))).digest('hex')
            : null,
    ]))).digest('hex');
    const base = { source: 'conversation', conversationId: cid, submittedUserMessageId: userId,
        currentNode: conversation.current_node, fingerprint, observedAt: new Date().toISOString() };
    if (tail?.author?.role === 'assistant' && tail.channel === 'final'
        && (!tail.recipient || tail.recipient === 'all')
        && tail.status === 'finished_successfully' && tail.end_turn === true) {
        const parts = tail.content?.parts;
        if (!Array.isArray(parts) || !parts.length || !parts.every(part => typeof part === 'string')) {
            return { ...base, state: 'unknown', reason: 'non-text-final' };
        }
        const answerText = parts.join('\n').trim();
        if (!answerText) return { ...base, state: 'unknown', reason: 'empty-final' };
        return { ...base, state: 'complete', responseMessageId: tail.id, answerText };
    }
    // In-progress is provider evidence, not an inferred timer/stop-button state.
    return { ...base, state: tail?.status === 'in_progress' ? 'generating' : 'pending' };
}

/**
 * A bounded same-account GET, independent of the selected Chrome tab. Prefer
 * the browser context's request client (unaffected by background JS throttling).
 * Never follow redirects with credentials; never print or persist tokens.
 * @param {any} page
 * @param {any} session
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<any>}
 */
export async function readServerResponse(page, session, { timeoutMs = 6_000 } = {}) {
    const unavailable = reason => ({ state: 'unknown', source: 'conversation', reason });
    const cid = session?.conversationId || extractDurableConversationId(session?.conversationUrl);
    if (!session?.submittedUserMessageId || !cid || !/^[a-zA-Z0-9-]+$/.test(cid)) return unavailable('submitted-message-identity-missing');
    let url;
    try { url = new URL(page.url()); } catch { return unavailable('page-unavailable'); }
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname)
        || extractDurableConversationId(url.href) !== cid) return unavailable('conversation-mismatch');
    // No global client: a caller may have a different account/profile/session.
    const request = page.request || page.context?.()?.request;
    if (typeof request?.get !== 'function') return unavailable('request-client-unavailable');
    let authResponse, conversationResponse;
    return withPollDeadline(async (_deadline, token) => {
        try {
            authResponse = await request.get(`${url.origin}/api/auth/session`, { timeout: timeoutMs, maxRedirects: 0 });
            if (authResponse.status() === 429) return { state: 'blocked', source: 'conversation', reason: 'http-429' };
            if (!authResponse.ok()) return unavailable('authentication-unavailable');
            const auth = await authResponse.json();
            if (!auth?.accessToken || token.expired) return unavailable('authentication-unavailable');
            if (page.url() !== url.href) return unavailable('conversation-changed');
            conversationResponse = await request.get(`${url.origin}/backend-api/conversation/${encodeURIComponent(cid)}`, {
                timeout: Math.max(1, _deadline - Date.now()), maxRedirects: 0,
                headers: { Authorization: `Bearer ${auth.accessToken}` },
            });
            if (conversationResponse.status() === 429) return { state: 'blocked', source: 'conversation', reason: 'http-429' };
            if (!conversationResponse.ok()) return unavailable(`http-${conversationResponse.status()}`);
            const conversation = await conversationResponse.json();
            if (token.expired || page.url() !== url.href) return unavailable('conversation-changed');
            return selectServerResponse(conversation, session);
        } catch { return unavailable('request-failed'); }
        finally {
            await authResponse?.dispose?.().catch(() => {});
            await conversationResponse?.dispose?.().catch(() => {});
        }
    }, { timeoutMs, onExpired: () => unavailable('probe-timeout') });
}

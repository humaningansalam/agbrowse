// @ts-check
import { createTab, probeTabAlive, getPageByTargetId, waitForPageByTargetId, listManagedTabs, closeTab } from '../skills/browser/tab-manager.mjs';
import {
    bindSessionConversation,
    DEADLINE_PASSED,
    GENERATION_CHANGED,
    getSession,
    listSessions,
    sessionConversationId,
    sessionGeneration,
    updateSession,
    updateSessionForGeneration,
} from './session.mjs';
import { waitForConversationReady } from './navigation-ready.mjs';
import { isWorkSession as _isWorkSession } from './chatgpt-work-picker.mjs';
import { extractDurableConversationId, isDurableConversationUrl } from './conversation-url.mjs';
import { WebAiError } from './errors.mjs';

/** @typedef {import('./session-store.mjs').WebAiSession} WebAiSession */

/**
 * @typedef {Object} RecoverDeps
 * @property {() => number} getPort
 * @property {(targetId?: string) => Promise<unknown>} [getPage]
 */

/**
 * @typedef {Object} RecoverResult
 * @property {boolean} recovered
 * @property {'existing-tab' | 'new-tab' | 'unverified'} strategy
 * @property {string | null} [targetId]
 * @property {'alive'|'gone'|'unknown'} [liveness]
 * @property {string} [reason]
 */

/**
 * Recover a session's tab
 * @param {RecoverDeps} deps
 * @param {WebAiSession} session
 * @param {{ stillActive?: () => boolean }} [options]
 * @returns {Promise<RecoverResult>}
 */
export async function recoverSessionTab(deps, session, options = {}) {
    if (!session) throw new Error('recoverSessionTab: session required');

    const port = deps.getPort();
    const stillActive = options.stillActive;
    const targetUrl = session.conversationUrl || session.originalUrl || 'about:blank';
    const generation = sessionGeneration(session);
    const isRunningWork = _isWorkSession(session) && session.status !== 'complete';

    // Work-session guard (04 section 6, round-2): a running Work session with a
    // bare-origin conversationUrl (e.g. "https://chatgpt.com/") must NOT be
    // recovered by opening that URL -- it would land on a home tab, not the task.
    // Fail closed with a typed error so the poll path can surface it.
    if (isRunningWork && isWorkSessionWithBareOrigin(session)) {
        throw new Error(
            `Work session ${session.sessionId} has bare-origin conversationUrl ` +
            `(${session.conversationUrl}); cannot recover to correct task tab. ` +
            `Error: provider.work-reattach-unverified`
        );
    }

    // 1. Observe the exact stored target. A target that is alive or whose
    // liveness is unknown is never navigated or replaced by recovery.
    const liveness = await probeTabAlive(port, /** @type {string} */ (session.targetId));
    // A tab we could not observe is not a tab we may replace: creating a new one
    // here would rebind the session target and abandon a live conversation.
    if (liveness === 'unknown') {
        return {
            recovered: false,
            strategy: 'unverified',
            liveness: 'unknown',
            reason: 'tab liveness could not be verified',
        };
    }
    if (liveness === 'alive') {
        const page = await getPageByTargetId(port, /** @type {string} */ (session.targetId)).catch(() => null);
        if (!page) {
            return {
                recovered: false,
                strategy: 'unverified',
                liveness: 'alive',
                targetId: session.targetId,
                reason: 'live target could not be attached',
            };
        }
        let currentUrl;
        try {
            currentUrl = /** @type {any} */ (page).url();
        } catch {
            return {
                recovered: false,
                strategy: 'unverified',
                liveness: 'alive',
                targetId: session.targetId,
                reason: 'live target URL could not be read',
            };
        }
        if (isRunningWork && !isWorkTabUrlConsistent(session, currentUrl)) {
            return {
                recovered: false,
                strategy: 'existing-tab',
                liveness: 'alive',
                targetId: session.targetId,
                reason: 'work-conversation-mismatch',
            };
        }
        if (session.vendor === 'chatgpt') {
            const expectedConversationId = sessionConversationId(session);
            const actualConversationId = extractDurableConversationId(currentUrl);
            if (expectedConversationId && actualConversationId !== expectedConversationId) {
                return {
                    recovered: false,
                    strategy: 'existing-tab',
                    liveness: 'alive',
                    targetId: session.targetId,
                    reason: 'conversation-mismatch',
                };
            }
            if (!expectedConversationId && actualConversationId) {
                const bound = await bindSessionConversation(
                    session.sessionId,
                    generation,
                    currentUrl,
                    stillActive,
                );
                if (bound === DEADLINE_PASSED) return deadlineRecoveryFailure('existing-tab', session.targetId);
                if (bound === GENERATION_CHANGED) {
                    return {
                        recovered: false,
                        strategy: 'existing-tab',
                        targetId: session.targetId,
                        reason: 'generation-superseded',
                    };
                }
            }
        } else if (targetUrl !== 'about:blank' && !urlsCompatible(targetUrl, currentUrl)) {
            return {
                recovered: false,
                strategy: 'existing-tab',
                liveness: 'alive',
                targetId: session.targetId,
                reason: 'conversation-mismatch',
            };
        }
        return {
            recovered: true,
            strategy: 'existing-tab',
            liveness: 'alive',
            targetId: session.targetId,
        };
    }

    // 2. Only a positively gone target may be replaced. ChatGPT recovery
    // requires the exact durable /c/<id> URL already owned by this session.
    if (liveness !== 'gone') {
        return {
            recovered: false,
            strategy: 'unverified',
            liveness,
            targetId: session.targetId,
            reason: 'target-not-proven-gone',
        };
    }
    if (session.vendor === 'chatgpt' && !isDurableConversationUrl(targetUrl)) {
        return {
            recovered: false,
            strategy: 'new-tab',
            liveness: 'gone',
            targetId: session.targetId,
            reason: 'unsafe-conversation-url',
        };
    }

    const newTab = await createTab(port, 'about:blank', { activate: false, reuseBlank: false });
    try {
        let recoveredConversationUrl = session.conversationUrl || targetUrl;
        if (targetUrl !== 'about:blank') {
            const newPage = await waitForPageByTargetId(port, newTab.targetId).catch(() => null);
            if (!newPage) throw new Error(`recovery target ${newTab.targetId} could not be attached`);
            await /** @type {any} */ (newPage).goto(targetUrl, { waitUntil: 'load', timeout: 30_000 });
            const finalUrl = /** @type {any} */ (newPage).url();
            await waitForConversationReady(newPage, finalUrl);
            if (session.vendor === 'chatgpt') {
                const expectedConversationId = sessionConversationId(session);
                const actualConversationId = extractDurableConversationId(finalUrl);
                if (!expectedConversationId || actualConversationId !== expectedConversationId) {
                    throw new Error(
                        `recovered conversation mismatch: expected ${expectedConversationId || 'unknown'}, got ${actualConversationId || 'unverified'}`,
                    );
                }
                recoveredConversationUrl = session.conversationUrl || targetUrl;
            } else if (!urlsCompatible(targetUrl, finalUrl)) {
                throw new Error(`recovered URL ${finalUrl} does not match ${targetUrl}`);
            } else {
                recoveredConversationUrl = finalUrl;
            }
        }

        // 3. Update session binding
        const binding = await updateSessionForGeneration(session.sessionId, generation, {
            targetId: newTab.targetId,
            ...(session.vendor === 'chatgpt' ? {} : { conversationUrl: recoveredConversationUrl }),
            tabState: {
                ...session.tabState,
                recoveryCount: (session.tabState?.recoveryCount || 0) + 1,
                lastActiveAt: new Date().toISOString(),
            },
        }, stillActive);
        if (binding === DEADLINE_PASSED) {
            await closeTab(port, newTab.targetId).catch(() => undefined);
            return deadlineRecoveryFailure('new-tab', newTab.targetId);
        }
        if (binding === GENERATION_CHANGED) {
            await closeTab(port, newTab.targetId).catch(() => undefined);
            return {
                recovered: false,
                strategy: 'new-tab',
                targetId: newTab.targetId,
                reason: 'generation-superseded',
            };
        }

        return {
            recovered: true,
            strategy: 'new-tab',
            liveness: 'gone',
            targetId: newTab.targetId
        };
    } catch (err) {
        // G8: Clean up the newly created target on failure (Oracle 83c3ca2)
        await closeTab(port, newTab.targetId).catch(() => undefined);
        throw err;
    }
}

/**
 * @param {'existing-tab'|'new-tab'} strategy
 * @param {string|null|undefined} targetId
 * @returns {RecoverResult}
 */
function deadlineRecoveryFailure(strategy, targetId) {
    return {
        recovered: false,
        strategy,
        targetId: targetId || null,
        reason: 'deadline-passed',
    };
}

/**
 * @typedef {Object} VerifyResult
 * @property {boolean} valid
 * @property {string | null} [targetId]
 * @property {boolean} needsRecovery
 * @property {'alive'|'gone'|'unknown'} [liveness]
 */

/**
 * Verify session tab is still valid
 * @param {RecoverDeps} deps
 * @param {WebAiSession | null | undefined} session
 * @returns {Promise<VerifyResult>}
 */
export async function verifySessionTab(deps, session) {
    if (!session?.targetId) {
        return { valid: false, needsRecovery: true };
    }

    const liveness = await probeTabAlive(deps.getPort(), session.targetId);
    // Carry the verdict upward. Collapsing `unknown` into `needsRecovery: false`
    // makes `resolveSessionPage` report `strategy: 'recovered'` for a tab it
    // never recovered.
    if (liveness === 'unknown') {
        return { valid: false, targetId: session.targetId, needsRecovery: false, liveness: 'unknown' };
    }
    const alive = liveness === 'alive';

    if (alive) {
        const page = await getPageByTargetId(deps.getPort(), session.targetId).catch(() => null);
        if (!page) return { valid: false, targetId: session.targetId, needsRecovery: false, liveness: 'unknown' };
        try {
            page.url();
        } catch {
            return { valid: false, targetId: session.targetId, needsRecovery: false, liveness: 'unknown' };
        }
        return { valid: true, targetId: session.targetId, needsRecovery: false, liveness: 'alive' };
    }

    return { valid: false, targetId: session.targetId, needsRecovery: true, liveness: 'gone' };
}

/**
 * Detect orphaned sessions (bound tab closed/destroyed)
 * @param {number} port - Browser CDP port
 * @returns {Promise<{checked: number, orphaned: number}>}
 */
export async function reconcileSessionTabs(port) {
    const [liveTabs, activeSessions] = await Promise.all([
        listManagedTabs(port),
        listSessions({ active: true })
    ]);

    const liveTargetIds = new Set(liveTabs.map(t => t.targetId));
    let orphaned = 0;

    for (const session of activeSessions) {
        if (!session.targetId) continue;

        if (!liveTargetIds.has(session.targetId)) {
            const now = new Date().toISOString();
            await updateSession(session.sessionId, {
                status: 'error',
                lastError: {
                    errorCode: 'tab.target-lost',
                    message: `Tab ${session.targetId} was closed or destroyed`
                },
                tabState: {
                    ...session.tabState,
                    state: 'lost',
                    lostAt: now
                }
            });
            orphaned++;
        }
    }

    return { checked: activeSessions.length, orphaned };
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isPageDeathError(err) {
    const e = /** @type {{ message?: unknown }} */ (err);
    const msg = String(e?.message || err || '').toLowerCase();
    return (
        msg.includes('target closed') ||
        msg.includes('page closed') ||
        msg.includes('browser has been closed') ||
        msg.includes('crash')
    );
}

/**
 * Classify a lost CDP client transport without conflating it with a dead page,
 * target, or browser. Liveness is decided separately over DevTools HTTP.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isCdpDisconnectError(err) {
    const seen = new Set();
    let current = err;
    while (current != null && !seen.has(current)) {
        seen.add(current);
        const msg = String((/** @type {any} */ (current))?.message || current || '').toLowerCase();
        if (isPageDeathError(current)) return false;
        if (
            msg.includes('browser disconnected') ||
            msg.includes('connection closed') ||
            msg.includes('websocket is not open') ||
            msg.includes('websocket closed') ||
            msg.includes('connection to the browser') ||
            msg.includes('cdp session detached') ||
            msg.includes('session closed') ||
            (msg.includes('protocol error') && (msg.includes('connection') || msg.includes('session')))
        ) return true;
        current = (/** @type {any} */ (current))?.cause;
    }
    return false;
}

// ─── Work-session recovery guards (04 section 6, round-2 fix) ──────────

/**
 * Check whether a URL is a bare ChatGPT origin (home page, not a /c/<id> task).
 * A bare-origin conversationUrl on a running Work session is the root cause of
 * the wrong-tab rebind bug: recovery resolves ANY chatgpt.com tab as a match.
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
export function isBareOriginUrl(url) {
    if (!url) return false;
    try {
        const u = new URL(url);
        const path = u.pathname.replace(/\/+$/, '') || '/';
        return path === '/' || path === '';
    } catch {
        return false;
    }
}

/**
 * For a RUNNING work session, verify that the tab's current URL is consistent
 * with the session's taskUrl (a /c/<uuid> page). Returns false for:
 *   - generic home page tabs (bare origin)
 *   - tabs showing a DIFFERENT /c/<uuid> conversation
 * Returns true when the tab shows the exact taskUrl or any /c/<uuid> page
 * (in case of minor URL variations). For sessions without taskUrl, any /c/ page
 * is acceptable; bare-origin is not.
 * @param {Record<string, unknown>} session
 * @param {string|null|undefined} tabUrl
 * @returns {boolean}
 */
export function isWorkTabUrlConsistent(session, tabUrl) {
    if (!tabUrl) return false;
    const taskUrl = /** @type {string|null|undefined} */ (
        session.envelopeSummary?.taskUrl || session.conversationUrl
    );

    // Bare-origin tab URL is never valid for a running Work session
    if (isBareOriginUrl(tabUrl)) return false;

    // If we have a taskUrl with /c/<uuid>, the tab must match it
    if (taskUrl && /\/c\/[a-f0-9-]+/.test(taskUrl)) {
        try {
            const taskPath = new URL(taskUrl).pathname;
            const tabPath = new URL(tabUrl).pathname;
            return taskPath === tabPath;
        } catch {
            return false;
        }
    }

    // No specific taskUrl -- accept any /c/<uuid> page, reject bare origin
    return /\/c\/[a-f0-9-]+/.test(tabUrl);
}

/**
 * Detect sessions with bare-origin conversationUrl on surface=work.
 * These are the dangerously broken shape from the round-1 bug.
 * @param {Record<string, unknown>} session
 * @returns {boolean}
 */
export function isWorkSessionWithBareOrigin(session) {
    if (!_isWorkSession(session)) return false;
    const recoveryTarget = session.conversationUrl || session.originalUrl;
    return isBareOriginUrl(/** @type {string|null|undefined} */ (recoveryTarget));
}


/**
 * @template T
 * @typedef {Object} ResolvedPage
 * @property {unknown} page
 * @property {string | null} targetId
 * @property {WebAiSession} session
 */

/**
 * @typedef {Object} ResolveSessionPageOk
 * @property {false} mismatch
 * @property {unknown} page
 * @property {string} targetId
 * @property {WebAiSession} session
 * @property {boolean} recovered
 * @property {'existing-tab' | 'new-tab' | 'recovered'} strategy
 * @property {string[]} warnings
 * @property {string} url
 * @property {string | null} conversationUrl
 */

/**
 * @typedef {Object} ResolveSessionPageMismatch
 * @property {true} mismatch
 * @property {null} page
 * @property {string | null} targetId
 * @property {WebAiSession} session
 * @property {false} recovered
 * @property {'existing-tab' | 'new-tab' | 'recovered'} strategy
 * @property {string[]} warnings
 * @property {string | null} url
 * @property {string | null} conversationUrl
 */

/**
 * The tab could not be OBSERVED, so it was neither reused nor recovered. This is
 * distinct from `ResolveSessionPageMismatch`: that one knows the tab is unusable,
 * this one knows nothing. Consumers must be able to tell those apart mechanically,
 * which a warning string does not allow.
 *
 * @typedef {Object} ResolveSessionPageUnverified
 * @property {true} mismatch
 * @property {null} page
 * @property {string | null} targetId
 * @property {WebAiSession} session
 * @property {false} recovered
 * @property {'unverified'} strategy
 * @property {'unknown'} liveness
 * @property {string[]} warnings
 * @property {string | null} url
 * @property {string | null} conversationUrl
 */

/** @typedef {ResolveSessionPageOk | ResolveSessionPageMismatch | ResolveSessionPageUnverified} ResolveSessionPageResult */

/**
 * @param {WebAiSession} session
 * @param {'existing-tab'|'new-tab'} strategy
 * @returns {ResolveSessionPageMismatch}
 */
function deadlineResolveFailure(session, strategy) {
    return {
        mismatch: true,
        page: null,
        targetId: session.targetId || null,
        session,
        recovered: false,
        strategy,
        warnings: [`session ${session.sessionId} deadline passed during tab recovery`],
        url: null,
        conversationUrl: session.conversationUrl || null,
    };
}

/**
 * Fail-closed guard for ChatGPT later-session / new-tab recovery targets
 * (32.3). A safe target is an HTTPS ChatGPT URL that references a CONCRETE
 * conversation (`/c/<id>`, incl. under a GPT prefix) — never the provider root,
 * a foreign host, or a traversal/smuggling string. Used by 35.1's new-tab
 * recovery and any later-session send to avoid landing on the wrong thread.
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
export function isSafeChatGptConversationUrl(url) {
    return isDurableConversationUrl(url);
}

/**
 * New-tab conversation recovery (35.1). Opens a saved ChatGPT conversation URL
 * in a FRESH tab — the agreed alternative to oracle's sidebar DOM-search
 * (master plan 36 §2). The 32.3 guard runs FIRST, so an unsafe target never
 * opens a tab. On URL mismatch the stray tab is closed. Never throws.
 * @param {{ getPort: () => number }} deps
 * @param {{ conversationUrl?: string|null }} [opts]
 * @returns {Promise<{ opened: true, page: any, targetId: string, conversationUrl: string } | { opened: false, reason: string, targetId?: string|null }>}
 */
export async function openConversationInNewTab(deps, { conversationUrl } = {}) {
    if (!isSafeChatGptConversationUrl(conversationUrl)) {
        return { opened: false, reason: 'unsafe-conversation-url' };
    }
    const safeUrl = /** @type {string} */ (conversationUrl);
    const port = deps.getPort();
    let targetId = null;
    try {
        const newTab = await createTab(port, safeUrl);
        targetId = newTab.targetId;
        const newPage = await waitForPageByTargetId(port, targetId).catch(() => null);
        if (!newPage) {
            await closeTab(port, targetId).catch(() => undefined); // G8: close orphaned target
            return { opened: false, reason: 'page-unavailable', targetId };
        }
        await waitForConversationReady(newPage, newPage.url()).catch(() => undefined);
        if (!urlsCompatible(safeUrl, newPage.url())) {
            await closeTab(port, targetId).catch(() => undefined);
            return { opened: false, reason: 'conversation-mismatch' };
        }
        return { opened: true, page: newPage, targetId, conversationUrl: safeUrl };
    } catch (err) {
        if (targetId) await closeTab(port, targetId).catch(() => undefined);
        return { opened: false, reason: `new-tab-failed:${/** @type {any} */ (err)?.message || 'unknown'}` };
    }
}

/**
 * @param {string|null|undefined} storedUrl
 * @param {string|null|undefined} liveUrl
 */
export function urlsCompatible(storedUrl, liveUrl) {
    if (!storedUrl || !liveUrl) return false;
    if (storedUrl === liveUrl) return true;
    try {
        const a = new URL(storedUrl);
        const b = new URL(liveUrl);
        if (a.hostname !== b.hostname) return false;
        const aPath = a.pathname.replace(/\/+$/, '') || '/';
        const bPath = b.pathname.replace(/\/+$/, '') || '/';
        return aPath === bPath || aPath === '/' || bPath.startsWith(`${aPath}/`);
    } catch {
        return false;
    }
}

/**
 * Resolve the page bound to a session.
 *
 * Returns either a populated `mismatch: false` result (page non-null) or a
 * typed `mismatch: true` result (page null). Mismatch is only reported when
 * `allowNavigate === false` AND either the resolved tab's URL drifted from
 * the session's stored conversation/original URL, or the stored target is
 * closed and a new tab would have to be opened to recover.
 *
 * @param {RecoverDeps} deps
 * @param {string} sessionId
 * @param {{ allowNavigate?: boolean, stillActive?: () => boolean }} [options]
 * @returns {Promise<ResolveSessionPageResult>}
 */
export async function resolveSessionPage(deps, sessionId, options = {}) {
    const allowNavigate = options.allowNavigate === true;
    const stillActive = options.stillActive;

    const session = getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const port = deps.getPort();
    const current = /** @type {WebAiSession} */ (session);
    const storedUrl = current.conversationUrl || current.originalUrl || null;

    const { valid, needsRecovery, liveness } = await verifySessionTab(deps, current);

    // Liveness unverified: do not recover, do not claim we did. Reported as its
    // own variant so callers can retry rather than treat the tab as unusable.
    if (liveness === 'unknown') {
        return {
            mismatch: true,
            page: null,
            targetId: current.targetId || null,
            session: current,
            recovered: false,
            strategy: 'unverified',
            liveness: 'unknown',
            warnings: [`session ${sessionId} tab liveness could not be verified`],
            url: null,
            conversationUrl: current.conversationUrl || null,
        };
    }

    if (!valid) {
        if (!allowNavigate) {
            // Stored tab is closed/dead and caller did not authorize navigation.
            return {
                mismatch: true,
                page: null,
                targetId: current.targetId || null,
                session: current,
                recovered: false,
                strategy: needsRecovery ? 'new-tab' : 'recovered',
                warnings: [`session ${sessionId} tab is not valid; pass --navigate to recover`],
                url: null,
                conversationUrl: current.conversationUrl || null,
            };
        }
        const recoveryTargetUrl = storedUrl;
        if (needsRecovery && recoveryTargetUrl) {
            const recovery = await recoverSessionTab(deps, current, { stillActive });
            // `unverified` means the probe failed, not that recovery failed.
            // Collapsing it into the generic throw loses the one detail that
            // tells the caller to retry rather than replace the tab.
            if (recovery.strategy === 'unverified') {
                return {
                    mismatch: true,
                    page: null,
                    targetId: current.targetId || null,
                    session: current,
                    recovered: false,
                    strategy: 'unverified',
                    liveness: 'unknown',
                    warnings: [`session ${sessionId} tab liveness could not be verified`],
                    url: null,
                    conversationUrl: current.conversationUrl || null,
                };
            }
            if (!recovery.recovered) {
                if (recovery.reason === 'deadline-passed') return deadlineResolveFailure(current, recovery.strategy);
                if (recovery.reason === 'generation-superseded') {
                    return {
                        mismatch: true,
                        page: null,
                        targetId: current.targetId || null,
                        session: current,
                        recovered: false,
                        strategy: recovery.strategy,
                        warnings: [`session ${sessionId} generation was superseded during recovery`],
                        url: null,
                        conversationUrl: current.conversationUrl || null,
                    };
                }
                throw new Error(`Session ${sessionId} tab recovery failed`);
            }
            const recovered = /** @type {WebAiSession} */ (getSession(sessionId));
            const page = await getPageByTargetId(port, /** @type {string} */ (recovered.targetId));
            if (!page) throw new Error(`Session ${sessionId} page not found after recovery`);
            return {
                mismatch: false,
                page,
                targetId: /** @type {string} */ (recovered.targetId),
                session: recovered,
                recovered: true,
                strategy: recovery.strategy === 'new-tab' ? 'new-tab' : 'recovered',
                warnings: [],
                url: page.url?.() || recoveryTargetUrl,
                conversationUrl: recovered.conversationUrl || null,
            };
        }
        throw new Error(`Session ${sessionId} tab is not valid and cannot be recovered`);
    }

    const page = await getPageByTargetId(port, /** @type {string} */ (current.targetId));
    if (!page) throw new Error(`Session ${sessionId} page not found for targetId ${current.targetId}`);

    let liveUrl = page.url();
    if (_isWorkSession(current) && current.status !== 'complete') {
        if (isWorkSessionWithBareOrigin(current) || !isWorkTabUrlConsistent(current, liveUrl)) {
            return {
                mismatch: true,
                page: null,
                targetId: /** @type {string} */ (current.targetId),
                session: current,
                recovered: false,
                strategy: 'existing-tab',
                warnings: [`Work session ${sessionId} target is not the saved task conversation; refusing navigation. Error: provider.work-reattach-unverified`],
                url: liveUrl,
                conversationUrl: current.conversationUrl,
            };
        }
    }

    if (current.vendor === 'chatgpt') {
        const expectedConversationId = sessionConversationId(current);
        const actualConversationId = extractDurableConversationId(liveUrl);
        if (expectedConversationId && actualConversationId !== expectedConversationId) {
            return {
                mismatch: true,
                page: null,
                targetId: /** @type {string} */ (current.targetId),
                session: current,
                recovered: false,
                strategy: 'existing-tab',
                warnings: [`current target shows conversation ${actualConversationId || 'unverified'}, expected ${expectedConversationId}; refusing hidden navigation`],
                url: liveUrl,
                conversationUrl: current.conversationUrl,
            };
        }
        if (!expectedConversationId && actualConversationId) {
            const binding = await bindSessionConversation(
                sessionId,
                sessionGeneration(current),
                liveUrl,
                stillActive,
            );
            if (binding === DEADLINE_PASSED) return deadlineResolveFailure(current, 'existing-tab');
            if (binding === GENERATION_CHANGED) {
                return {
                    mismatch: true,
                    page: null,
                    targetId: /** @type {string} */ (current.targetId),
                    session: current,
                    recovered: false,
                    strategy: 'existing-tab',
                    warnings: [`session ${sessionId} generation changed while binding conversation identity`],
                    url: liveUrl,
                    conversationUrl: current.conversationUrl,
                };
            }
            const updated = /** @type {WebAiSession} */ (binding || getSession(sessionId));
            return {
                mismatch: false,
                page,
                targetId: /** @type {string} */ (current.targetId),
                session: updated,
                recovered: false,
                strategy: 'existing-tab',
                warnings: [],
                url: liveUrl,
                conversationUrl: updated.conversationUrl || null,
            };
        }
    } else if (current.conversationUrl && !urlsCompatible(current.conversationUrl, liveUrl)) {
        // Non-ChatGPT providers retain explicit-navigation compatibility. The
        // immutable conversation contract in this release applies to the
        // ChatGPT Director/Expert path.
        if (!allowNavigate) {
            return {
                mismatch: true,
                page: null,
                targetId: /** @type {string} */ (current.targetId),
                session: current,
                recovered: false,
                strategy: 'existing-tab',
                warnings: [`current tab ${liveUrl} does not match session conversationUrl ${current.conversationUrl}`],
                url: liveUrl,
                conversationUrl: current.conversationUrl,
            };
        }
        await page.goto(current.conversationUrl, { waitUntil: 'load', timeout: 30_000 });
        liveUrl = page.url();
        await waitForConversationReady(page, liveUrl);
    }

    return {
        mismatch: false,
        page,
        targetId: /** @type {string} */ (current.targetId),
        session: current,
        recovered: false,
        strategy: 'existing-tab',
        warnings: [],
        url: liveUrl || current.conversationUrl || current.originalUrl || '',
        conversationUrl: current.conversationUrl || null,
    };
}

/**
 * Reconnect to the session's saved target without navigation or replacement.
 * The caller must independently prove endpoint and target liveness first.
 * @param {RecoverDeps} deps
 * @param {string} sessionId
 * @returns {Promise<ResolvedPage<unknown>>}
 */
export async function reattachSessionPage(deps, sessionId) {
    const session = getSession(sessionId);
    if (!session?.targetId) throw new Error(`Session ${sessionId} has no targetId for CDP reattach`);
    const page = await getPageByTargetId(deps.getPort(), session.targetId);
    if (!page) throw new Error(`Session ${sessionId} target ${session.targetId} unavailable after CDP reconnect`);
    page.url();
    return { page, targetId: session.targetId, session };
}

/**
 * Execute operation with session's bound page
 * GPT Pro recommendation: resolve page directly, don't use active tab routing
 * Catches page death mid-operation and retries once after recovery
 * @template T
 * @param {RecoverDeps} deps
 * @param {string} sessionId
 * @param {(ctx: ResolvedPage<T>) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withSessionPage(deps, sessionId, fn) {
    return withSessionPageGuarded(deps, sessionId, fn, {});
}

/**
 * The deadline-aware form: watch, resume and MCP poll run under a stored
 * deadline, and the recovery inside the resolver performs binding writes.
 * `stillActive` is threaded down so those writes are refused under the store
 * lock once the deadline has passed — the resolver's own pre-checks say
 * nothing about the moment a contended write lands.
 *
 * @template T
 * @param {RecoverDeps} deps
 * @param {string} sessionId
 * @param {(ctx: ResolvedPage<T>) => Promise<T> | T} fn
 * @param {{ stillActive?: () => boolean }} [options]
 * @returns {Promise<T>}
 */
export async function withSessionPageGuarded(deps, sessionId, fn, options = {}) {
    const stillActive = options.stillActive;
    const first = await resolveSessionPage(deps, sessionId, { allowNavigate: true, stillActive });
    if (/** @type {any} */ (first).strategy === 'unverified') throw livenessUnverifiedError(sessionId, deps, first);
    if (first.mismatch) throw sessionPageMismatchError(sessionId, first);
    try {
        return await fn(/** @type {ResolvedPage<T>} */ ({ page: first.page, targetId: first.targetId, session: first.session }));
    } catch (err) {
        if (!isPageDeathError(err)) throw err;
        // Re-probe after page death. The resolver may create a replacement only
        // when the exact target is positively reported gone.
        const recovered = await resolveSessionPage(deps, sessionId, { allowNavigate: true, stillActive });
        if (/** @type {any} */ (recovered).strategy === 'unverified') throw livenessUnverifiedError(sessionId, deps, recovered);
        if (recovered.mismatch) throw sessionPageMismatchError(sessionId, recovered);
        return fn(/** @type {ResolvedPage<T>} */ ({ page: recovered.page, targetId: recovered.targetId, session: recovered.session }));
    }
}

/**
 * Preserve strict target/conversation mismatch as a typed non-mutating error.
 *
 * @param {string} sessionId
 * @param {ResolveSessionPageMismatch} resolved
 */
function sessionPageMismatchError(sessionId, resolved) {
    const expectedConversationId = sessionConversationId(resolved.session);
    const actualConversationId = extractDurableConversationId(resolved.url);
    const generationSuperseded = resolved.warnings.some((warning) => warning.includes('generation'));
    return new WebAiError({
        errorCode: generationSuperseded
            ? 'session.generation-superseded'
            : expectedConversationId
                ? 'session.conversation-mismatch'
                : 'cdp.target-mismatch',
        stage: generationSuperseded ? 'session-generation' : 'target-resolution',
        vendor: resolved.session.vendor || undefined,
        retryHint: generationSuperseded ? 'use-latest-generation' : 'use-correct-session',
        mutationAllowed: false,
        message: resolved.warnings[0] || `session ${sessionId} target identity mismatch`,
        evidence: {
            sessionId,
            generation: sessionGeneration(resolved.session),
            expectedTargetId: resolved.session.targetId || null,
            actualTargetId: resolved.targetId || null,
            expectedConversationId,
            actualConversationId,
            url: resolved.url || null,
        },
    });
}

/**
 * The recovery predicate for a session bounded by a STORED deadline.
 *
 * Watch, resume and MCP poll do not hold a poller run token while the tab is
 * being recovered — the authority there is the absolute `deadlineAt` on the
 * session row. No deadline means always active (a session that never promised
 * a bound cannot lose one).
 *
 * @param {{ deadlineAt?: string|null }|null|undefined} session
 * @returns {() => boolean}
 */
export function storedDeadlineStillActive(session) {
    const parsed = Date.parse(session?.deadlineAt || '');
    if (!Number.isFinite(parsed)) return () => true;
    return () => Date.now() < parsed;
}

/**
 * A tab we could not observe is not a wrong tab. Falling through to the generic
 * "resolver returned mismatch" error loses the one fact the caller needs: retry
 * once the browser answers, rather than replace the tab.
 *
 * @param {string} sessionId
 * @param {RecoverDeps} deps
 * @param {any} resolved
 * @returns {WebAiError}
 */
function livenessUnverifiedError(sessionId, deps, resolved) {
    return new WebAiError({
        errorCode: 'cdp.unreachable',
        stage: 'target-resolution',
        vendor: resolved?.session?.vendor || 'chatgpt',
        retryHint: 'retry',
        message: resolved?.warnings?.[0] || `session ${sessionId} tab liveness could not be verified`,
        mutationAllowed: false,
        evidence: {
            sessionId,
            targetId: resolved?.targetId || null,
            port: Number(deps.getPort?.() || process.env.CDP_PORT || 9222),
            liveness: 'unknown',
        },
    });
}

/**
 * When send records a provider root URL before the SPA assigns a concrete
 * conversation URL, the bound tab may later move from "/" to "/c/..." (or
 * provider equivalent). In that case the live tab is newer truth; do not
 * navigate it back to the stale root.
 * @param {string|null|undefined} savedUrl
 * @param {string|null|undefined} currentUrl
 */

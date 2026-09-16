// @ts-check
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
    generateSessionId,
    insertSession,
    listStoredSessions,
    listStoredSessionsAsync,
    mutateSessionAsync,
    patchSession,
    readSessionAsync,
    DEADLINE_PASSED,
    pruneSessions,
} from './session-store.mjs';
import { normalizeChatGptModelChoice } from './chatgpt-model.mjs';
import { normalizeGrokModelChoice } from './grok-model.mjs';
import { normalizeGeminiModelChoice, isGeminiDeepThinkChoice } from './gemini-model.mjs';
import {
    canonicalChatGptConversationUrl,
    extractDurableConversationId,
} from './conversation-url.mjs';
import { WebAiError } from './errors.mjs';

/**
 * @typedef {import('./session-store.mjs').WebAiSession} WebAiSession
 */

/** Returned when an observer tries to write an older logical request. */
export const GENERATION_CHANGED = Symbol('session-generation-changed');

const COMPLETED_SESSION_STATUSES = new Set(['complete', 'completed']);

/**
 * Legacy rows are generation 1 until their first follow-up advances them.
 *
 * @param {WebAiSession|null|undefined} session
 * @returns {number}
 */
export function sessionGeneration(session) {
    const value = Number(session?.generation);
    return Number.isInteger(value) && value > 0 ? value : 1;
}

/**
 * Durable ChatGPT conversation identity, including legacy rows that only
 * persisted a concrete conversation URL.
 *
 * @param {WebAiSession|null|undefined} session
 * @returns {string|null}
 */
export function sessionConversationId(session) {
    if (!session || session.vendor !== 'chatgpt') return null;
    return typeof session.conversationId === 'string' && session.conversationId
        ? session.conversationId
        : extractDurableConversationId(session.conversationUrl);
}

/**
 * @typedef {{
 *   vendor?: string,
 *   system?: string,
 *   prompt?: string,
 *   project?: string,
 *   goal?: string,
 *   context?: string,
 *   question?: string,
 *   output?: string,
 *   constraints?: string,
 *   attachmentPolicy?: string,
 *   model?: string,
 *   filePath?: string,
 *   timeout?: number|string,
 *   deadline?: string|number,
 *   deadlineAt?: string|number,
 *   [extra: string]: unknown,
 * }} WebAiEnvelope
 */

/**
 * @typedef {{
 *   vendor: string|null,
 *   url: string|null,
 *   promptHash: string,
 *   assistantCount: number,
 *   textHash: string,
 *   capturedAt: string,
 *   [extra: string]: unknown,
 * }} WebAiBaseline
 */

/** @type {Map<string, WebAiBaseline>} */
const baselines = new Map();
/**
 * The path the in-memory map was loaded from, or null when nothing is loaded.
 *
 * Keyed by path rather than a plain `loaded` flag: the map is module-global, so
 * a boolean let rows loaded under one `BROWSER_AGENT_HOME` answer reads under a
 * different one — and the next save copied both homes' rows into whichever was
 * current. Tests that switch homes saw the previous home's baselines.
 *
 * @type {string|null}
 */
let loadedFrom = null;
/**
 * Resolved per call, not at import. A frozen constant captured whatever
 * `BROWSER_AGENT_HOME` held at first import, so a test pointing the variable at
 * a temp directory in its body still read and wrote baselines under the
 * developer's real `~/.browser-agent` — static imports run before test bodies.
 *
 * @returns {string}
 */
function storePath() {
    return join(process.env.BROWSER_AGENT_HOME || join(homedir(), '.browser-agent'), 'web-ai-baselines.json');
}

/**
 * @param {WebAiEnvelope} envelope
 * @returns {string}
 */
export function hashPrompt(envelope) {
    const payload = {
        vendor: envelope.vendor,
        system: envelope.system || '',
        prompt: envelope.prompt || '',
        project: envelope.project || '',
        goal: envelope.goal || '',
        context: envelope.context || '',
        question: envelope.question || '',
        output: envelope.output || '',
        constraints: envelope.constraints || '',
        attachmentPolicy: envelope.attachmentPolicy || 'inline-only',
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * @param {string|null|undefined} vendor
 * @param {string|null|undefined} url
 * @returns {string}
 */
export function makeBaselineKey(vendor, url) {
    return `${vendor}:${url || 'unknown-url'}`;
}

/**
 * @param {{ vendor: string, url: string, envelope: WebAiEnvelope, assistantCount: number, textHash: string }} input
 * @returns {WebAiBaseline}
 */
export function saveBaseline({ vendor, url, envelope, assistantCount, textHash }) {
    loadStore();
    /** @type {WebAiBaseline} */
    const baseline = {
        vendor,
        url,
        promptHash: hashPrompt(envelope),
        assistantCount,
        textHash,
        capturedAt: new Date().toISOString(),
    };
    baselines.set(makeBaselineKey(vendor, url), baseline);
    saveStore();
    return baseline;
}

/**
 * @param {string} vendor
 * @param {string} url
 * @returns {WebAiBaseline|null}
 */
export function getBaseline(vendor, url) {
    loadStore();
    return baselines.get(makeBaselineKey(vendor, url)) || null;
}

/**
 * @param {string} vendor
 * @param {{ sameHostUrl?: string }} [options]
 * @returns {WebAiBaseline|null}
 */
export function getLatestBaseline(vendor, options = {}) {
    loadStore();
    const sameHost = normalizeHost(options.sameHostUrl);
    const matches = Array.from(baselines.values())
        .filter((baseline) => baseline.vendor === vendor)
        .filter((baseline) => !sameHost || normalizeHost(baseline.url) === sameHost)
        .sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
    return matches.at(-1) || null;
}

/**
 * @param {string|null|undefined} url
 * @returns {string}
 */
function normalizeHost(url) {
    try {
        return new URL(/** @type {string} */ (url)).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

/**
 * @param {string} vendor
 * @param {string} url
 */
export function clearBaseline(vendor, url) {
    loadStore();
    baselines.delete(makeBaselineKey(vendor, url));
    saveStore();
}

function loadStore() {
    const path = storePath();
    if (loadedFrom === path) return;
    // The home changed under us. Drop the other home's rows instead of merging
    // them into this one.
    baselines.clear();
    loadedFrom = path;
    if (!existsSync(path)) return;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        for (const baseline of parsed.baselines || []) {
            if (baseline.vendor && baseline.url) baselines.set(makeBaselineKey(baseline.vendor, baseline.url), baseline);
        }
    } catch {
        baselines.clear();
    }
}

function saveStore() {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ baselines: Array.from(baselines.values()) }, null, 2)}\n`);
}

// ─── Phase 1 PR1: session API on top of session-store.mjs ─────────────────
// Legacy `saveBaseline`/`getBaseline`/`getLatestBaseline`/`clearBaseline` keep
// writing `web-ai-baselines.json` for one minor release. New code should
// prefer `createSession` / `findActiveSession` / `getSession` / `updateSession`.

/**
 * @param {WebAiEnvelope|null|undefined} envelope
 * @param {{ vendor?: string, status?: string, deadlineAt?: string|null, targetId?: string|null, tabId?: string|null, tabState?: Record<string, unknown>, originalUrl?: string|null, conversationUrl?: string|null, conversationId?: string|null, generation?: number, envelopeSummary?: Record<string, unknown> }} [meta]
 * @returns {WebAiSession}
 */
export function createSession(envelope, meta = {}) {
    const now = new Date().toISOString();
    const vendor = envelope?.vendor || meta.vendor || null;
    const observedConversationUrl = meta.conversationUrl || meta.originalUrl || null;
    const observedConversationId = vendor === 'chatgpt'
        ? (meta.conversationId || extractDurableConversationId(observedConversationUrl))
        : null;
    const conversationUrl = vendor === 'chatgpt'
        ? canonicalChatGptConversationUrl(observedConversationUrl)
        : observedConversationUrl;
    /** @type {WebAiSession} */
    const session = {
        sessionId: generateSessionId(),
        vendor,
        createdAt: now,
        updatedAt: now,
        deadlineAt: meta.deadlineAt || null,
        generation: Number.isInteger(meta.generation) && Number(meta.generation) > 0
            ? Number(meta.generation)
            : 1,
        targetId: meta.targetId || null,
        tabId: meta.tabId || null,
        tabState: meta.tabState || {
            createdAt: now,
            lastActiveAt: now,
            recoveryCount: 0,
            closeCount: 0,
        },
        originalUrl: meta.originalUrl || null,
        conversationUrl,
        conversationId: observedConversationId || null,
        submittedUserMessageId: null,
        submittedUserTurnId: null,
        responseMessageId: null,
        responseTurnId: null,
        promptHash: `sha256:${hashPrompt(envelope || {})}`,
        envelopeSummary: meta.envelopeSummary || {},
        status: meta.status || 'sent',
        answer: null,
        lastError: null,
        warnings: [],
        lastDomHash: null,
        lastAxHash: null,
        lastStreamingState: 'unknown',
        lastResponseCharCount: 0,
        trace: [],
        artifacts: [],
    };
    return insertSession(session);
}

/**
 * @param {string} sessionId
 * @param {Partial<WebAiSession> & Record<string, unknown>} [patch]
 * @returns {WebAiSession|null}
 */
export function updateSession(sessionId, patch = {}) {
    return patchSession(sessionId, (current) => buildSessionPatch(current, patch));
}

/**
 * Compute the effective patch for a session update against the CURRENT row.
 *
 * Shared by the sync and async forms so the ChatGPT conversation-URL filter
 * cannot drift between them: a non-durable URL is dropped from the patch no
 * matter which lock the write goes through.
 *
 * @param {WebAiSession} current
 * @param {Partial<WebAiSession> & Record<string, unknown>} patch
 * @returns {Partial<WebAiSession> & Record<string, unknown>}
 */
function buildSessionPatch(current, patch) {
    const nextPatch = { ...patch };
    if (current.vendor === 'chatgpt') {
        const currentConversationId = sessionConversationId(current);
        const requestedConversationId = typeof nextPatch.conversationId === 'string'
            ? nextPatch.conversationId
            : null;
        if (
            requestedConversationId &&
            currentConversationId &&
            requestedConversationId !== currentConversationId
        ) {
            throw conversationMismatchError(current, requestedConversationId, nextPatch.conversationUrl);
        }
        if (Object.hasOwn(nextPatch, 'conversationUrl')) {
            const candidateUrl = /** @type {string|null|undefined} */ (nextPatch.conversationUrl);
            const candidateConversationId = extractDurableConversationId(candidateUrl);
            if (!candidateConversationId) {
                delete nextPatch.conversationUrl;
                delete nextPatch.conversationId;
            } else if (currentConversationId && candidateConversationId !== currentConversationId) {
                throw conversationMismatchError(current, candidateConversationId, candidateUrl);
            } else {
                nextPatch.conversationId = currentConversationId || candidateConversationId;
                nextPatch.conversationUrl = canonicalChatGptConversationUrl(candidateUrl);
            }
        } else if (currentConversationId && !current.conversationId) {
            nextPatch.conversationId = currentConversationId;
        }
    }

    const requestedGeneration = Number(nextPatch.generation);
    const startsNewGeneration = Number.isInteger(requestedGeneration)
        && requestedGeneration > sessionGeneration(current);
    const hasCompletedEvidence = COMPLETED_SESSION_STATUSES.has(current.status)
        || Boolean(current.completedAt)
        || current.answer != null;
    if (hasCompletedEvidence && !startsNewGeneration) {
        if (
            Object.hasOwn(nextPatch, 'status') &&
            !COMPLETED_SESSION_STATUSES.has(String(nextPatch.status || ''))
        ) {
            delete nextPatch.status;
        }
        if (Object.hasOwn(nextPatch, 'answer') && nextPatch.answer !== current.answer) {
            delete nextPatch.answer;
        }
        if (Object.hasOwn(nextPatch, 'completedAt') && nextPatch.completedAt !== current.completedAt) {
            delete nextPatch.completedAt;
        }
    }
    return { ...nextPatch, updatedAt: new Date().toISOString() };
}

/**
 * The awaited, deadline-aware form of {@link updateSession}.
 *
 * The sync form reads, decides, then takes the blocking lock — so its decision
 * is made against a row that can change while the lock is waited for, and the
 * wait itself stops the event loop. Here both the decision and the write
 * happen inside the awaited lock, and `stillActive` is re-checked once the
 * lock is held: a caller whose deadline passed during the wait gets
 * `DEADLINE_PASSED` back and nothing is written.
 *
 * @param {string} sessionId
 * @param {Partial<WebAiSession> & Record<string, unknown>} [patch]
 * @param {() => boolean} [stillActive]
 * @returns {Promise<WebAiSession|null|typeof DEADLINE_PASSED>}
 */
export function updateSessionAsync(sessionId, patch = {}, stillActive) {
    return mutateSessionAsync(sessionId, (current) => buildSessionPatch(current, patch), stillActive);
}

/**
 * Start the next prompt inside an existing logical conversation. The session
 * id, target binding and ChatGPT conversation identity remain stable; only the
 * prompt generation and current-result fields advance.
 *
 * @param {string} sessionId
 * @param {WebAiEnvelope|null|undefined} envelope
 * @param {{ status?: string, targetId?: string|null, conversationUrl?: string|null, deadlineAt?: string|null, envelopeSummary?: Record<string, unknown>, modelSelection?: unknown }} [meta]
 * @returns {Promise<WebAiSession|null|typeof DEADLINE_PASSED>}
 */
export function beginSessionGeneration(sessionId, envelope, meta = {}) {
    return mutateSessionAsync(sessionId, (current) => {
        // A lost submit acknowledgement is not permission to submit twice.
        if (['submitting', 'submission-unknown'].includes(current.status)) {
            assertSessionPollable(current);
        }
        const vendor = envelope?.vendor || current.vendor;
        if (vendor && current.vendor && vendor !== current.vendor) {
            throw new WebAiError({
                errorCode: 'session.vendor-mismatch',
                stage: 'session-generation',
                retryHint: 'use-session-vendor',
                vendor: String(vendor),
                mutationAllowed: false,
                message: `session ${sessionId} belongs to ${current.vendor}, not ${vendor}`,
                evidence: { sessionId, sessionVendor: current.vendor, requestedVendor: vendor },
            });
        }
        if (meta.targetId && current.targetId && meta.targetId !== current.targetId) {
            throw new WebAiError({
                errorCode: 'cdp.target-mismatch',
                stage: 'session-generation',
                retryHint: 'use-correct-session',
                vendor: current.vendor || undefined,
                mutationAllowed: false,
                message: `session ${sessionId} is bound to target ${current.targetId}, not ${meta.targetId}`,
                evidence: { sessionId, expectedTargetId: current.targetId, actualTargetId: meta.targetId },
            });
        }

        const currentConversationId = sessionConversationId(current);
        const liveConversationId = extractDurableConversationId(meta.conversationUrl);
        if (current.vendor === 'chatgpt' && currentConversationId && liveConversationId !== currentConversationId) {
            throw conversationMismatchError(current, liveConversationId, meta.conversationUrl);
        }

        const now = new Date().toISOString();
        const nextConversationId = currentConversationId || liveConversationId || null;
        return buildSessionPatch(current, {
            generation: sessionGeneration(current) + 1,
            generationStartedAt: now,
            targetId: current.targetId || meta.targetId || null,
            conversationId: nextConversationId,
            conversationUrl: nextConversationId
                ? canonicalChatGptConversationUrl(meta.conversationUrl || current.conversationUrl)
                : current.conversationUrl,
            deadlineAt: meta.deadlineAt || current.deadlineAt || null,
            promptHash: `sha256:${hashPrompt(envelope || {})}`,
            envelopeSummary: meta.envelopeSummary || {},
            ...(meta.modelSelection !== undefined ? { modelSelection: meta.modelSelection } : {}),
            status: meta.status || 'sent',
            answer: null,
            completedAt: null,
            submittedUserMessageId: null,
            submittedUserTurnId: null,
            responseMessageId: null,
            responseTurnId: null,
            lastError: null,
            warnings: [],
            lastDomHash: null,
            lastAxHash: null,
            lastStreamingState: 'unknown',
            lastResponseCharCount: 0,
            responseObservation: null,
        });
    });
}

/**
 * Reject an unfinished submit before attaching a browser or extending a poll.
 * Older durable conversations without turn anchors remain readable; a provider
 * home page with no committed message is not a conversation to poll.
 * @param {WebAiSession|null|undefined} session
 */
export function assertSessionPollable(session) {
    if (!session || session.vendor !== 'chatgpt') return;
    const summary = session.envelopeSummary || {};
    if (session.surface === 'work' || summary.surface === 'work'
        || session.sessionType === 'work' || session.taskUrl
        || session.sessionType === 'deep-research' || summary.researchMode === 'deep'
        || summary.research === 'deep' || session.researchMode === 'deep') return;
    if (COMPLETED_SESSION_STATUSES.has(session.status) || session.completedAt) return;
    const pending = ['preparing', 'submitting', 'submission-unknown'].includes(session.status);
    const failed = /** @type {any} */ (session.lastError)?.stage === 'submission';
    const unbound = !sessionConversationId(session)
        && !session.submittedUserMessageId && !session.submittedUserTurnId;
    if (!pending && !failed && !unbound) return;
    throw new WebAiError({
        errorCode: 'session.submission-unverified',
        stage: 'submission', vendor: 'chatgpt', mutationAllowed: false,
        retryHint: session.status === 'preparing' ? 'wait-for-send-result' : 'inspect-session-before-retry',
        message: `Session ${session.sessionId} has no confirmed submission to poll (${session.status}); do not infer send success from sessions list`,
        evidence: {
            sessionId: session.sessionId, generation: sessionGeneration(session),
            targetId: session.targetId, status: session.status,
            promptSubmitted: session.status === 'preparing' ? false
                : failed ? /** @type {any} */ (session.lastError).promptSubmitted ?? null : null,
        },
    });
}

/**
 * Generation-fenced read-modify-write. The comparison and mutation happen
 * under the same store lock.
 *
 * @param {string} sessionId
 * @param {number} generation
 * @param {(current: WebAiSession) => (Partial<WebAiSession> & Record<string, unknown>)|null} mutate
 * @param {() => boolean} [stillActive]
 * @returns {Promise<WebAiSession|null|typeof DEADLINE_PASSED|typeof GENERATION_CHANGED>}
 */
export async function mutateSessionForGeneration(sessionId, generation, mutate, stillActive) {
    const expectedGeneration = Number(generation);
    let mismatch = false;
    const result = await mutateSessionAsync(sessionId, (current) => {
        if (sessionGeneration(current) !== expectedGeneration) {
            mismatch = true;
            return null;
        }
        const patch = mutate(current);
        if (!patch) return null;
        const nextPatch = { ...patch };
        delete nextPatch.generation;
        return buildSessionPatch(current, nextPatch);
    }, stillActive);
    if (mismatch) return GENERATION_CHANGED;
    return result;
}

/**
 * @param {string} sessionId
 * @param {number} generation
 * @param {Partial<WebAiSession> & Record<string, unknown>} [patch]
 * @param {() => boolean} [stillActive]
 */
export function updateSessionForGeneration(sessionId, generation, patch = {}, stillActive) {
    return mutateSessionForGeneration(sessionId, generation, () => patch, stillActive);
}

/**
 * @param {string} sessionId
 * @param {number} generation
 * @param {Partial<WebAiSession> & { warnings?: unknown[], warning?: unknown, lastError?: unknown }} [patch]
 * @param {() => boolean} [stillActive]
 */
export function markSessionTimeoutForGeneration(sessionId, generation, patch = {}, stillActive) {
    return mutateSessionForGeneration(
        sessionId,
        generation,
        (current) => buildTimeoutPatch(current, patch),
        stillActive,
    );
}

/**
 * Bind the first durable ChatGPT conversation URL, or verify that a later
 * observation refers to the same immutable conversation.
 *
 * @param {string} sessionId
 * @param {number} generation
 * @param {string|null|undefined} conversationUrl
 * @param {() => boolean} [stillActive]
 */
export function bindSessionConversation(sessionId, generation, conversationUrl, stillActive) {
    return mutateSessionForGeneration(sessionId, generation, (current) => {
        if (current.vendor !== 'chatgpt') return { conversationUrl };
        const actualConversationId = extractDurableConversationId(conversationUrl);
        const expectedConversationId = sessionConversationId(current);
        if (!actualConversationId || (expectedConversationId && actualConversationId !== expectedConversationId)) {
            throw conversationMismatchError(current, actualConversationId, conversationUrl);
        }
        return {
            conversationId: expectedConversationId || actualConversationId,
            conversationUrl: canonicalChatGptConversationUrl(conversationUrl),
        };
    }, stillActive);
}

/**
 * @param {string} sessionId
 * @param {number} generation
 * @returns {Promise<boolean>}
 */
export async function isSessionGenerationCurrent(sessionId, generation) {
    const current = await readSessionAsync(sessionId);
    return Boolean(current && sessionGeneration(current) === Number(generation));
}

/**
 * @param {WebAiSession} current
 * @param {string|null} actualConversationId
 * @param {unknown} actualUrl
 */
function conversationMismatchError(current, actualConversationId, actualUrl) {
    const expectedConversationId = sessionConversationId(current);
    return new WebAiError({
        errorCode: 'session.conversation-mismatch',
        stage: 'conversation-identity',
        retryHint: 'use-correct-session',
        vendor: current.vendor || undefined,
        mutationAllowed: false,
        message: `session ${current.sessionId} is bound to conversation ${expectedConversationId || 'unknown'}, not ${actualConversationId || 'unverified'}`,
        evidence: {
            sessionId: current.sessionId,
            targetId: current.targetId || null,
            expectedConversationId,
            actualConversationId: actualConversationId || null,
            actualUrl: typeof actualUrl === 'string' ? actualUrl : null,
        },
    });
}

/**
 * Mark an incomplete session as timed out without downgrading completed work.
 *
 * @param {string} sessionId
 * @param {Partial<WebAiSession> & { warnings?: unknown[], warning?: unknown, lastError?: unknown }} [patch]
 * @returns {WebAiSession|null}
 */
export function markSessionTimeout(sessionId, patch = {}) {
    const session = getSession(sessionId);
    if (!session) return null;
    return updateSession(sessionId, buildTimeoutPatch(session, patch));
}

/**
 * Decide what a timeout write should actually record, given the current row.
 *
 * Kept separate so the sync and async timeout paths share one rule: completed
 * evidence is never downgraded to `timeout`, only annotated.
 *
 * @param {WebAiSession} session
 * @param {Partial<WebAiSession> & { warnings?: unknown[], warning?: unknown, lastError?: unknown }} patch
 * @returns {Partial<WebAiSession> & Record<string, unknown>}
 */
function buildTimeoutPatch(session, patch) {
    const { warning, warnings: patchWarnings, ...sessionPatch } = patch;
    const warnings = mergeWarnings(session.warnings || [], patchWarnings || [], warning);
    const hasCompletedEvidence = session.status === 'complete' ||
        session.status === 'completed' ||
        Boolean(session.completedAt) ||
        Boolean(session.answer);
    if (hasCompletedEvidence) {
        return {
            warnings: mergeWarnings(warnings, ['timeout-after-complete-ignored']),
            status: session.status === 'completed' ? 'completed' : 'complete',
        };
    }
    return { ...sessionPatch, status: 'timeout', warnings };
}

/**
 * The awaited, deadline-aware form of {@link markSessionTimeout}.
 *
 * The completed-evidence decision is made against the row read INSIDE the
 * lock — the sync form decides before acquiring, so a run that completed while
 * the lock was waited for could still be downgraded. `stillActive` follows the
 * same post-lock contract as {@link updateSessionAsync}. Note the predicate
 * semantics for timeout bookkeeping: the write that RECORDS an expiry is
 * usually made by the run that owns the outcome, so callers pass a predicate
 * only when this write belongs to a run that can lose a race (a detached
 * loser must not write), not for the authoritative timeout record itself.
 *
 * @param {string} sessionId
 * @param {Partial<WebAiSession> & { warnings?: unknown[], warning?: unknown, lastError?: unknown }} [patch]
 * @param {() => boolean} [stillActive]
 * @returns {Promise<WebAiSession|null|typeof DEADLINE_PASSED>}
 */
export function markSessionTimeoutAsync(sessionId, patch = {}, stillActive) {
    return mutateSessionAsync(
        sessionId,
        (current) => buildSessionPatch(current, buildTimeoutPatch(current, patch)),
        stillActive,
    );
}

export { DEADLINE_PASSED };

/**
 * @param {unknown[]} base
 * @param {unknown[]} extra
 * @param {unknown} [single]
 * @returns {unknown[]}
 */
function mergeWarnings(base, extra, single) {
    const out = Array.isArray(base) ? [...base] : [];
    for (const warning of [...(Array.isArray(extra) ? extra : []), single]) {
        if (warning == null) continue;
        const key = typeof warning === 'string' ? warning : JSON.stringify(warning);
        if (!out.some((existing) => (typeof existing === 'string' ? existing : JSON.stringify(existing)) === key)) {
            out.push(warning);
        }
    }
    return out;
}

/**
 * @param {string|null|undefined} sessionId
 * @returns {WebAiSession|null}
 */
export function getSession(sessionId) {
    if (!sessionId) return null;
    return listStoredSessions({ sessionId, limit: 1 })[0] || null;
}

/**
 * @param {Parameters<typeof listStoredSessions>[0]} [filter]
 * @returns {WebAiSession[]}
 */
export function listSessions(filter = {}) {
    return listStoredSessions(filter);
}

/**
 * @param {{ vendor?: string, targetId?: string, conversationUrl?: string }} [args]
 * @returns {WebAiSession|null}
 */
export function findActiveSession({ vendor, targetId, conversationUrl } = {}) {
    if (!vendor) return null;
    const active = listStoredSessions({ vendor, active: true });
    return pickActiveSession(active, { targetId, conversationUrl });
}

/**
 * The same lookup, awaited instead of blocked on.
 *
 * The synchronous form reads under a lock whose wait stops the event loop, so
 * a caller holding a hard deadline stops counting time while it runs. Callers
 * under a poll deadline must use this one.
 *
 * @param {{ vendor?: string, targetId?: string|null, conversationUrl?: string|null }} [query]
 * @returns {Promise<WebAiSession|null>}
 */
export async function findActiveSessionAsync({ vendor, targetId, conversationUrl } = {}) {
    if (!vendor) return null;
    const active = await listStoredSessionsAsync({ vendor, active: true });
    return pickActiveSession(active, { targetId, conversationUrl });
}

/**
 * Selection order, shared so the sync and async forms cannot diverge.
 *
 * @param {WebAiSession[]} active
 * @param {{ targetId?: string|null, conversationUrl?: string|null }} query
 * @returns {WebAiSession|null}
 */
function pickActiveSession(active, { targetId, conversationUrl }) {
    if (active.length === 0) return null;
    if (targetId) {
        const byTarget = active.find((s) => s.targetId && s.targetId === targetId);
        if (byTarget) return byTarget;
    }
    if (conversationUrl) {
        const byConvo = active.find((s) => s.conversationUrl && s.conversationUrl === conversationUrl);
        if (byConvo) return byConvo;
    }
    return active.at(-1) || null;
}

/**
 * @param {Parameters<typeof pruneSessions>[0]} [input]
 * @returns {ReturnType<typeof pruneSessions>}
 */
export function pruneSessionsOlderThan(input = {}) {
    return pruneSessions(input);
}

// ─── Phase 9.1: Tab Binding ───────────────────────────────────────

/**
 * @param {string} sessionId
 * @param {string} targetId
 * @param {string|null} [tabId]
 * @returns {WebAiSession|null}
 */
export function bindSessionToTab(sessionId, targetId, tabId = null) {
    return updateSession(sessionId, {
        targetId,
        tabId: tabId || targetId,
        tabState: {
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            recoveryCount: 0,
            closeCount: 0,
        },
    });
}

/**
 * @param {string} sessionId
 * @param {Record<string, unknown>} [updates]
 * @returns {WebAiSession|null}
 */
export function updateSessionTabState(sessionId, updates = {}) {
    const session = getSession(sessionId);
    if (!session) return null;

    const current = session.tabState || {};
    return updateSession(sessionId, {
        tabState: {
            ...current,
            ...updates,
            lastActiveAt: new Date().toISOString(),
        },
    });
}

/**
 * @param {string} sessionId
 * @returns {WebAiSession|null}
 */
export function incrementRecoveryCount(sessionId) {
    const session = getSession(sessionId);
    if (!session) return null;

    const current = /** @type {number} */ (session.tabState?.recoveryCount || 0);
    return updateSessionTabState(sessionId, { recoveryCount: current + 1 });
}

/** @type {Record<string, number>} */
const VENDOR_DEFAULT_TIMEOUT_SEC = { chatgpt: 1200, gemini: 1200, grok: 600 };

/**
 * @param {WebAiEnvelope} [input]
 * @param {string} [vendor]
 * @returns {string}
 */
export function resolveDeadlineAt(input = {}, vendor = 'chatgpt') {
    if (input.deadlineAt) return new Date(input.deadlineAt).toISOString();
    if (input.deadline) return new Date(input.deadline).toISOString();
    const seconds = Number(input.timeout) > 0
        ? Number(input.timeout)
        : resolveTimeoutDefaultSec(input, vendor);
    return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * Resolve only a deadline the caller explicitly supplied for an existing
 * session. Unlike {@link resolveDeadlineAt}, this returns null when neither
 * --deadline nor --timeout was present, so an ordinary poll keeps inheriting
 * the stored generation deadline.
 *
 * @param {WebAiEnvelope} [input]
 * @param {number} [nowMs]
 * @returns {string|null}
 */
export function resolveExplicitSessionDeadlineAt(input = {}, nowMs = Date.now()) {
    if (input.deadlineAt) return new Date(input.deadlineAt).toISOString();
    if (input.deadline) return new Date(input.deadline).toISOString();
    if (input.timeout === undefined || input.timeout === null || String(input.timeout).trim() === '') return null;
    const seconds = Number(input.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return new Date(nowMs + seconds * 1000).toISOString();
}

/**
 * Apply an explicit poll/resume deadline before any expired-session fast path.
 * The write is generation-fenced so a stale command cannot extend a newer
 * prompt that started while it was preparing.
 *
 * @param {string} sessionId
 * @param {WebAiEnvelope} [input]
 * @param {number} [expectedGeneration]
 * @returns {Promise<WebAiSession|null>}
 */
export async function applyExplicitSessionDeadlineOverride(sessionId, input = {}, expectedGeneration) {
    const current = getSession(sessionId);
    if (!current) return null;
    if (COMPLETED_SESSION_STATUSES.has(current.status) || Boolean(current.completedAt)) return current;
    const deadlineAt = resolveExplicitSessionDeadlineAt(input);
    if (!deadlineAt) return current;
    const generation = Number.isInteger(Number(expectedGeneration)) && Number(expectedGeneration) > 0
        ? Number(expectedGeneration)
        : sessionGeneration(current);
    const updated = await updateSessionForGeneration(sessionId, generation, { deadlineAt });
    if (updated === GENERATION_CHANGED) {
        throw new WebAiError({
            errorCode: 'session.generation-superseded',
            stage: 'session-deadline',
            retryHint: 'poll-latest-generation',
            vendor: current.vendor || undefined,
            mutationAllowed: false,
            message: `session ${sessionId} advanced beyond generation ${generation} before its deadline override could be applied`,
            evidence: { sessionId, generation },
        });
    }
    return updated;
}

/**
 * Hardcoded default poll timeout (seconds) per normalized model tier.
 * Provider-specific long-reasoning tiers stay independent so one budget change
 * cannot silently change another provider's behavior.
 * An explicit --timeout / --deadline always overrides these defaults.
 * @type {Readonly<Record<string, number>>}
 */
export const TIER_DEFAULT_TIMEOUT_SEC = Object.freeze({
    instant: 120,
    thinking: 600,
    'chatgpt-pro': 5400,
    'grok-heavy': 3600,
    'deep-research': 3600,
});

/** ChatGPT Pro ceiling (seconds), exported for cross-module reuse (e.g. lease TTLs). */
export const CHATGPT_PRO_TIMEOUT_SEC = TIER_DEFAULT_TIMEOUT_SEC['chatgpt-pro'];
/** Backward-compatible alias; new consumers use CHATGPT_PRO_TIMEOUT_SEC. */
export const PRO_TIMEOUT_SEC = CHATGPT_PRO_TIMEOUT_SEC;

/**
 * Resolve a tier name to a default timeout (seconds), falling back to the vendor
 * default and finally 1200s when the tier is unknown.
 * @param {string|null} tier
 * @param {string} [vendor]
 * @returns {number}
 */
export function tierDefaultTimeoutSec(tier, vendor = 'chatgpt') {
    if (tier && TIER_DEFAULT_TIMEOUT_SEC[tier] != null) return TIER_DEFAULT_TIMEOUT_SEC[tier];
    return VENDOR_DEFAULT_TIMEOUT_SEC[vendor] || 1200;
}

/**
 * Map (vendor, model, research) to a normalized timeout tier, or null when unknown.
 * Reuses the existing per-vendor model normalizers; deep-research is signalled by
 * the separate `research` flag (chatgpt) or the deep-think alias (gemini).
 * @param {string} vendor
 * @param {unknown} model
 * @param {unknown} [research]
 * @returns {string|null}
 */
export function deriveTimeoutTier(vendor, model, research) {
    if (vendor === 'gemini') {
        if (isGeminiDeepThinkChoice(model)) return 'deep-research';
        const m = normalizeGeminiModelChoice(model);
        if (m === 'flash-lite') return 'instant';
        if (m === 'flash' || m === 'pro') return 'thinking';
        return null;
    }
    if (vendor === 'grok') {
        const m = normalizeGrokModelChoice(model);
        if (m === 'heavy') return 'grok-heavy';
        if (m === 'fast') return 'instant';
        return m ? 'thinking' : null;
    }
    // chatgpt (default vendor)
    if (String(research || '').trim().toLowerCase() === 'deep') return 'deep-research';
    const m = normalizeChatGptModelChoice(model);
    return m === 'pro' ? 'chatgpt-pro' : m;
}

/**
 * Tier-aware default poll timeout (seconds), applied when no explicit --timeout is given.
 * @param {{ model?: unknown, research?: unknown }} [input]
 * @param {string} [vendor]
 * @returns {number}
 */
export function resolveTimeoutDefaultSec(input = {}, vendor = 'chatgpt') {
    const tier = deriveTimeoutTier(vendor, input.model, input.research);
    return tierDefaultTimeoutSec(tier, vendor);
}

/**
 * The stored deadline's remaining time in milliseconds, or null when the
 * session carries no parseable deadline.
 *
 * Separate from `resolveTimeoutBudgetSec` because that function answers a
 * different question. It returns a POLLING BUDGET in whole seconds and floors
 * it at one, which keeps a nearly-expired session from being handed a budget
 * too small to do anything with — deliberate, and covered by its own tests.
 *
 * A hard deadline is not a budget. Rounding it up means the bound the caller
 * was promised can be overshot: 500ms left becomes 1000ms, and an already
 * expired deadline becomes a fresh second. Callers enforcing a strict bound
 * need the real remainder, including when it is zero or negative.
 *
 * @param {WebAiSession|null} [session]
 * @param {number} [nowMs]
 * @returns {number|null}
 */
export function storedDeadlineRemainderMs(session = null, nowMs = Date.now()) {
    const storedDeadlineMs = Date.parse(String(session?.deadlineAt || ''));
    if (!Number.isFinite(storedDeadlineMs)) return null;
    return storedDeadlineMs - nowMs;
}

/**
 * The timeout envelope for a session whose stored deadline has already passed,
 * or null when it still has time.
 *
 * Re-reads the session by id rather than trusting a snapshot. Every caller
 * checks this twice: once before taking the session command lock, and again
 * after — the lock retries 200 times at 25ms, so a session with 150ms left can
 * expire *while waiting for it*, and the pre-lock check alone let that run open
 * a tab. Reading a stale snapshot inside the lock would reproduce the same gap.
 *
 * Shaped to match the providers' own hard-timeout envelope
 * (`chatgpt.mjs` buildHardTimeoutResult) so a caller cannot tell the fast path
 * apart by its fields.
 *
 * @param {string} sessionId
 * @param {string} [fallbackVendor]
 * @param {number} [nowMs] explicit clock for deterministic tests; otherwise
 *   sampled AFTER the store read
 * @returns {Record<string, unknown>|null}
 */
export function expiredSessionTimeoutResult(sessionId, fallbackVendor = 'chatgpt', nowMs = undefined) {
    const session = getSession(sessionId);
    if (!session) return null;
    // A completed generation is durable evidence, not a request that can later
    // "expire" back into timeout. Return the stored terminal result before
    // consulting deadlineAt so poll/status callers never lose a finished answer.
    if (COMPLETED_SESSION_STATUSES.has(session.status) || Boolean(session.completedAt)) {
        return {
            ok: true,
            vendor: session.vendor || fallbackVendor,
            status: 'complete',
            sessionId: session.sessionId,
            generation: sessionGeneration(session),
            targetId: session.targetId || undefined,
            conversationId: sessionConversationId(session) || undefined,
            conversationUrl: session.conversationUrl || session.originalUrl || undefined,
            url: session.conversationUrl || session.originalUrl || undefined,
            answerText: typeof session.answer === 'string' ? session.answer : '',
            usedFallbacks: [],
            warnings: Array.isArray(session.warnings) ? session.warnings : [],
            recoverable: false,
            completedAt: session.completedAt || undefined,
            ...(Array.isArray(session.artifacts) && session.artifacts.length
                ? { artifacts: session.artifacts }
                : {}),
        };
    }
    // Sampled AFTER the read, not as a default parameter. `getSession` takes
    // the store lock, which retries and can block for seconds; a clock read
    // before it would compare a fresh session against a stale time and let an
    // already-expired session through. A caller-supplied `nowMs` still wins so
    // tests stay deterministic.
    const effectiveNowMs = nowMs === undefined ? Date.now() : nowMs;
    const remainderMs = storedDeadlineRemainderMs(session, effectiveNowMs);
    if (remainderMs === null || remainderMs > 0) return null;
    return {
        ok: false,
        vendor: session.vendor || fallbackVendor,
        status: 'timeout',
        sessionId: session.sessionId,
        conversationUrl: session.conversationUrl || session.originalUrl || undefined,
        answerText: '',
        usedFallbacks: [],
        warnings: ['poll-deadline-exceeded'],
        recoverable: true,
        errorCode: 'provider.poll-timeout',
        retryHint: 'poll-or-resume',
        error: 'timed out waiting for answer',
    };
}

/**
 * The timeout to hand a provider poll, in seconds, never outliving the stored
 * deadline.
 *
 * Every entry point that resumes an existing session needs this, and each one
 * got it wrong differently. Resolving a budget and passing it down floored the
 * remainder to a whole second, which reads to the provider as an explicit
 * `--timeout` the user typed. Omitting it instead is only safe for ChatGPT,
 * whose wrapper reads `deadlineAt` itself — Gemini and Grok fall back to their
 * own 1200s and 600s defaults (`gemini-live.mjs:646`, `grok-live.mjs:277`), so
 * omitting turns a 400ms remainder into twenty minutes.
 *
 * Fractional by design. Returning whole seconds is what let a sub-second
 * remainder round up past the deadline it was supposed to enforce.
 *
 * @param {WebAiEnvelope} [input] the caller's own request; an explicit timeout wins
 * @param {WebAiSession|null} [session]
 * @param {string} [vendor]
 * @param {number} [nowMs]
 * @returns {number} seconds, > 0; approaches zero as the deadline arrives
 */
export function resolvePollTimeoutSec(input = {}, session = null, vendor = 'chatgpt', nowMs = Date.now()) {
    const explicitSec = Number(input.timeout);
    const requestedSec = Number.isFinite(explicitSec) && explicitSec > 0
        ? explicitSec
        : resolveTimeoutBudgetSec(input, session, vendor, nowMs);
    const remainderMs = storedDeadlineRemainderMs(session, nowMs);
    if (remainderMs === null) return requestedSec;
    // Never zero or negative: a provider reads that as "no budget" and some
    // floor it back up. Callers that must refuse an expired session check the
    // remainder themselves — this function's job is only to not exceed it.
    return Math.max(0.001, Math.min(requestedSec, remainderMs / 1000));
}

/**
 * Resolve one polling budget in seconds.
 * Priority: explicit timeout -> stored deadline remainder -> tier/vendor default.
 * @param {WebAiEnvelope} [input]
 * @param {WebAiSession|null} [session]
 * @param {string} [vendor]
 * @param {number} [nowMs]
 * @returns {number}
 */
export function resolveTimeoutBudgetSec(
    input = {},
    session = null,
    vendor = 'chatgpt',
    nowMs = Date.now(),
) {
    const explicitTimeoutSec = Number(input.timeout);
    if (Number.isFinite(explicitTimeoutSec) && explicitTimeoutSec > 0) {
        return explicitTimeoutSec;
    }

    const storedDeadlineMs = Date.parse(String(session?.deadlineAt || ''));
    if (Number.isFinite(storedDeadlineMs)) {
        return Math.max(1, (storedDeadlineMs - nowMs) / 1000);
    }

    const summary = session?.envelopeSummary || {};
    return resolveTimeoutDefaultSec({
        model: input.model ?? summary.model,
        research: input.research ?? session?.researchMode ?? summary.research,
    }, session?.vendor || vendor);
}

/**
 * @param {WebAiEnvelope} [input]
 * @param {{ files?: unknown[], transport?: string, contextTransform?: string, attachments?: unknown[], repomix?: Record<string, unknown> } | null} [contextPack]
 * @returns {Record<string, unknown>}
 */
/**
 * The file artifact policy in force for this call.
 *
 * Monotonic on purpose: a stored `require-all` is NOT relaxed by a later poll
 * that omits the flag. Letting one forgetful invocation downgrade the session
 * would make the requirement advisory rather than a contract.
 *
 * @param {{ fileArtifactPolicy?: string }} [input]
 * @param {{ envelopeSummary?: Record<string, unknown> } | null} [session]
 * @returns {'best-effort'|'require-all'}
 */
export function resolveFileArtifactPolicy(input = {}, session = null) {
    const stored = session?.envelopeSummary?.fileArtifactPolicy;
    return input.fileArtifactPolicy === 'require-all' || stored === 'require-all'
        ? 'require-all'
        : 'best-effort';
}

/**
 * @param {WebAiEnvelope} [input]
 * @param {{ files?: unknown[], transport?: string, contextTransform?: string, attachments?: unknown[], repomix?: Record<string, unknown> } | null} [contextPack]
 * @returns {Record<string, unknown>}
 */
export function summarizeEnvelope(input = {}, contextPack = null) {
    /** @type {Record<string, unknown>} */
    const summary = {};
    if (input.model) summary.model = input.model;
    if (input.attachmentPolicy) summary.attachmentPolicy = input.attachmentPolicy;
    // Persisted so a later poll/watch/resume inherits the requirement the send
    // was given: the flag is not repeated on those commands.
    if (input.fileArtifactPolicy === 'require-all') summary.fileArtifactPolicy = 'require-all';
    if (input.filePath) summary.filePath = input.filePath;
    if (contextPack?.files?.length) summary.fileCount = contextPack.files.length;
    if (contextPack?.transport) summary.contextTransport = contextPack.transport;
    if (contextPack?.contextTransform === 'repomix') {
        summary.contextTransform = 'repomix';
        if (contextPack.attachments?.length) summary.contextAttachmentCount = contextPack.attachments.length;
        if (contextPack.repomix) summary.repomix = contextPack.repomix;
    }
    return summary;
}

/**
 * @param {WebAiSession|null|undefined} session
 * @returns {WebAiBaseline|null}
 */
export function sessionToBaseline(session) {
    if (!session) return null;
    return {
        vendor: session.vendor,
        url: session.conversationUrl || session.originalUrl,
        promptHash: typeof session.promptHash === 'string' && session.promptHash.startsWith('sha256:')
            ? session.promptHash.slice('sha256:'.length)
            : session.promptHash,
        assistantCount: Number(session.envelopeSummary?.assistantCount) || 0,
        textHash: '0',
        capturedAt: session.createdAt,
    };
}

// @ts-check
import {
    DEADLINE_PASSED,
    GENERATION_CHANGED,
    isSessionGenerationCurrent,
    sessionGeneration,
    updateSessionForGeneration,
} from './session.mjs';
import { poolTab } from './tab-pool.mjs';
import { trySaveTranscript, appendArtifactRecordAsync } from './session-artifacts.mjs';
import { resolveArchivePolicy, archiveConversation } from './chatgpt-archive.mjs';

const FINALIZABLE_STATUSES = new Set(['complete', 'completed']);

/**
 * @typedef {Object} FinalizeDeps
 * @property {() => number} [getPort]
 */

/**
 * @typedef {Object} FinalizeSession
 * @property {string} [sessionId]
 * @property {string} [targetId]
 * @property {string} [vendor]
 * @property {string} [conversationUrl]
 * @property {string} [originalUrl]
 */

/**
 * @typedef {Object} FinalizePage
 * @property {() => string} [url]
 */

/**
 * @typedef {Object} FinalizeOptions
 * @property {string} [vendor]
 * @property {FinalizeSession} [session]
 * @property {FinalizePage} [page]
 * @property {number} [generation]
 * @property {string} [answerText]
 * @property {string} [artifactText]
 * @property {string} [status]
 * @property {unknown[]} [warnings]
 * @property {string} [archiveFlag]
 * @property {string} [sessionType]
 * @property {() => boolean} [stillActive] false once the caller's deadline passed
 */

/**
 * @typedef {{ finalized: false, reason: string } | { finalized: true, pool: unknown, archived?: boolean, archiveSkippedReason?: string, artifactStatus?: unknown }} FinalizeResult
 */

/**
 * @param {FinalizeDeps} [deps]
 * @param {FinalizeOptions} [options]
 * @returns {Promise<FinalizeResult>}
 */
export async function finalizeProviderTab(deps, {
    vendor,
    session,
    page,
    generation,
    answerText,
    artifactText,
    status = 'complete',
    warnings = [],
    archiveFlag,
    sessionType = 'send-poll',
    stillActive,
} = {}) {
    if (!session?.sessionId || !session.targetId || !FINALIZABLE_STATUSES.has(status)) {
        return { finalized: false, reason: 'not-finalizable' };
    }
    // Checked before EVERY side-effect phase, not once at entry. Each phase can
    // block long enough for the deadline to pass inside it: the session write
    // takes the store lock, which retries up to 200 times at 25ms
    // (`session-store.mjs:136-164`), and the archive drives the provider UI. An
    // entry check alone let a losing run write the answer, persist a transcript
    // and click Archive after its caller was already handed `timeout`.
    const expired = () => stillActive?.() === false;
    const expectedGeneration = Number(generation || sessionGeneration(/** @type {any} */ (session)));
    const stillOwned = async () => !expired()
        && await isSessionGenerationCurrent(/** @type {string} */ (session.sessionId), expectedGeneration);
    if (expired()) {
        return { finalized: false, reason: 'poll-deadline-exceeded' };
    }
    if (!await stillOwned()) {
        return {
            finalized: false,
            reason: expired() ? 'poll-deadline-exceeded' : 'generation-superseded',
        };
    }
    const conversationUrl = page?.url?.() || session.conversationUrl || session.originalUrl || undefined;
    const baseWarnings = Array.isArray(warnings) ? warnings : [];
    const completed = await updateSessionForGeneration(session.sessionId, expectedGeneration, {
        status: 'complete',
        conversationUrl,
        answer: answerText,
        warnings: baseWarnings,
        completedAt: new Date().toISOString(),
    }, () => !expired());
    if (completed === DEADLINE_PASSED) {
        return { finalized: false, reason: 'poll-deadline-exceeded' };
    }
    if (completed === GENERATION_CHANGED) {
        return { finalized: false, reason: 'generation-superseded' };
    }
    /** @type {{ required: boolean, ok: boolean, descriptor?: unknown, stage?: string, error?: string }} */
    let artifactStatus = { required: false, ok: true };
    // The store lock sits between the write above and here. Re-checked so a
    // transcript file is not created for a run that lost while it waited.
    if (answerText && await stillOwned()) {
        const saved = trySaveTranscript(session.sessionId, artifactText || answerText);
        artifactStatus = saved.ok
            ? { required: true, ok: true, descriptor: saved.descriptor }
            : { required: true, ok: false, stage: saved.stage, error: saved.error };
        // Re-checked AFTER the save. Writing the transcript touches the
        // filesystem, so the deadline can pass inside it; both branches below
        // are session writes and must not start once it has.
        if (!await stillOwned()) {
            return { finalized: true, pool: null, archiveSkippedReason: expired() ? 'poll-deadline-exceeded' : 'generation-superseded' };
        }
        if (saved.ok) {
            const appended = await appendArtifactRecordAsync(
                session.sessionId,
                saved.descriptor,
                () => !expired(),
                expectedGeneration,
            );
            if (appended === DEADLINE_PASSED) {
                return { finalized: true, pool: null, archiveSkippedReason: 'poll-deadline-exceeded' };
            }
            if (appended === GENERATION_CHANGED) {
                return { finalized: true, pool: null, archiveSkippedReason: 'generation-superseded' };
            }
        } else {
            const warned = await updateSessionForGeneration(session.sessionId, expectedGeneration, {
                warnings: [...baseWarnings, `artifact-save-failed:${saved.stage}:${saved.error}`],
            }, () => !expired());
            if (warned === DEADLINE_PASSED) {
                return { finalized: true, pool: null, archiveSkippedReason: 'poll-deadline-exceeded' };
            }
            if (warned === GENERATION_CHANGED) {
                return { finalized: true, pool: null, archiveSkippedReason: 'generation-superseded' };
            }
        }
    }

    if (!await stillOwned()) {
        return { finalized: true, pool: null, archiveSkippedReason: expired() ? 'poll-deadline-exceeded' : 'generation-superseded' };
    }

    const { shouldArchive } = resolveArchivePolicy({
        archiveFlag: archiveFlag || 'auto',
        session: { ...session, conversationUrl, status: 'complete' },
        artifactStatus,
    });

    if (shouldArchive && page && conversationUrl) {
        try {
            // Checked BEFORE the archive, not only after it. `archiveConversation`
            // clicks through the provider UI, so an after-only check meant the
            // clicks had already happened on a conversation nobody was waiting on.
            if (!await stillOwned()) {
                return { finalized: true, pool: null, archiveSkippedReason: expired() ? 'poll-deadline-exceeded' : 'generation-superseded' };
            }
            const archiveResult = await archiveConversation(page, { conversationUrl });
            // Re-check AFTER the await. A caller bounded by a deadline can have
            // returned while the archive was in flight; writing then would move
            // a session nobody is waiting on. Checking only at entry is not
            // enough for work that spans an await.
            if (archiveResult.ok) {
                const archived = await updateSessionForGeneration(
                    session.sessionId,
                    expectedGeneration,
                    { archived: true },
                    () => !expired(),
                );
                if (archived === DEADLINE_PASSED) {
                    return { finalized: true, pool: null, archiveSkippedReason: 'poll-deadline-exceeded' };
                }
                if (archived === GENERATION_CHANGED) {
                    return { finalized: true, pool: null, archiveSkippedReason: 'generation-superseded' };
                }
                return { finalized: true, pool: null, archived: true };
            }
        } catch { /* archive is best-effort, fall through to pool */ }
    }

    if (!await stillOwned()) {
        return { finalized: true, pool: null, archiveSkippedReason: expired() ? 'poll-deadline-exceeded' : 'generation-superseded' };
    }

    const port = deps?.getPort?.() || 9222;
    const result = await poolTab(vendor || session.vendor || 'chatgpt', session.targetId, conversationUrl, {
        port,
        owner: 'web-ai',
        sessionType,
        sessionId: session.sessionId,
    });
    return {
        finalized: true,
        pool: result,
        archived: false,
        archiveSkippedReason: artifactStatus.required && artifactStatus.ok === false ? 'artifact-save-failed' : undefined,
        artifactStatus,
    };
}

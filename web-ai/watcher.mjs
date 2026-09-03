// @ts-check
/**
 * @typedef {any} Deps
 * @typedef {any} Input
 * @typedef {any} Page
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { pollWebAi } from './chatgpt.mjs';
import { isWorkSession, pollWorkSession } from './chatgpt-work-picker.mjs';
import { geminiPollWebAi } from './gemini-live.mjs';
import { grokPollWebAi } from './grok-live.mjs';
import {
    DEADLINE_PASSED,
    GENERATION_CHANGED,
    getSession,
    resolvePollTimeoutSec,
    sessionGeneration,
    updateSessionForGeneration,
} from './session.mjs';
import { isRecoverableCdpDisconnect, probeCdpLiveness } from './cdp-liveness.mjs';
import { isCdpDisconnectError, reattachSessionPage, storedDeadlineStillActive, withSessionPage, withSessionPageGuarded, urlsCompatible } from './tab-recovery.mjs';
import { WebAiError, wrapError } from './errors.mjs';
import {
    defineCapability, runCapabilities,
    probeHostMatches, probeFirstVisibleSelector, worstCapabilityState,
} from './capability.mjs';
import { featureDefinitionsForVendor } from './doctor.mjs';
import { domHashAround } from './dom-hash.mjs';
import * as profileLock from '../skills/browser/profile-lock.mjs';

export const DEFAULT_WATCH_INTERVAL_MS = 15_000;
export const DEFAULT_WATCH_POLL_TIMEOUT_SEC = 30;
export const DEFAULT_WATCH_LOCK_STALE_MS = 5 * 60_000;
export const TERMINAL_SESSION_STATUSES = new Set(['complete', 'timeout', 'error']);

const WATCHER_STREAMING_SELECTORS = {
    chatgpt: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'],
    grok: ['button[aria-label*="Stop" i]', 'button:has-text("Stop")'],
    gemini: ['button[aria-label*="Stop" i]', 'button[aria-label*="Stop generating" i]'],
};

const PROVIDER_HOSTS = {
    chatgpt: new Set(['chatgpt.com', 'chat.openai.com']),
    gemini: new Set(['gemini.google.com']),
    grok: new Set(['grok.com']),
};

/**
 * @param {any} deps
 * @param {any} input
 * @param {any} notifier
 */
export async function watchSession(deps, input = {}, notifier = null) {
    const options = normalizeWatchOptions(input);
    if (!options.sessionId) {
        throw new WebAiError({
            errorCode: 'watcher.session-missing',
            stage: 'watcher-start',
            retryHint: 'pass-session',
            message: 'web-ai watch requires --session <sessionId>',
        });
    }

    const startingSession = getSession(options.sessionId);
    if (!startingSession) {
        throw new WebAiError({
            errorCode: 'watcher.session-missing',
            stage: 'watcher-load-session',
            retryHint: 'sessions-list',
            message: `no session record for ${options.sessionId}`,
            evidence: { sessionId: options.sessionId },
        });
    }
    const generation = sessionGeneration(startingSession);
    const lock = acquireWatcherSessionLock(options.sessionId, { staleMs: options.lockStaleMs });
    const notify = notifier || createStdoutNotifier({ json: options.json });
    /** @type {any[]} */
    const events = [];
    const emit = async (/** @type {any} */ event) => {
        const enriched = { capturedAt: new Date().toISOString(), sessionId: options.sessionId, ...event };
        if (options.captureEvents) events.push(enriched);
        await notify(enriched);
    };

    let final = null;
    try {
        if (options.hasExplicitDeadlineOverride && options.deadlineAt) {
            const deadlineWrite = await updateSessionForGeneration(
                options.sessionId,
                generation,
                { deadlineAt: options.deadlineAt },
            );
            if (deadlineWrite === GENERATION_CHANGED) {
                return {
                    ok: false,
                    status: 'superseded',
                    sessionId: options.sessionId,
                    generation,
                    final: supersededWatchTick(startingSession, startingSession.vendor || 'chatgpt', generation),
                    eventsPrinted: true,
                    events: options.captureEvents ? /** @type {any} */ (events) : undefined,
                };
            }
        }
        await emit({ type: 'watch.start', status: 'watching', intervalMs: options.intervalMs, pollTimeoutSec: options.pollTimeoutSec });

        for (let iteration = 1; ; iteration += 1) {
            lock.heartbeat({ iteration });
            const tick = await watchSessionOnce(deps, {
                ...options,
                session: options.sessionId,
                generation,
            });
            final = tick;
            await emit({
                type: 'watch.tick',
                iteration,
                status: tick.status,
                terminal: tick.terminal === true,
                vendor: tick.vendor,
                url: tick.url || null,
                warnings: tick.warnings || [],
            });

            if (tick.terminal === true || tick.status === 'superseded') {
                await emit({ type: `watch.${tick.status}`, status: tick.status, terminal: true, vendor: tick.vendor });
                break;
            }
            // A typed fail-closed result ends the watch. Continuing to poll
            // would spin on a condition the caller already has to act on, and
            // the final `ok: true` below would then report success.
            if (tick.errorCode === 'provider.file-artifact') {
                final = { ...tick, terminal: true };
                await emit({ type: 'watch.file-artifact-unsatisfied', status: tick.status, terminal: true, vendor: tick.vendor });
                break;
            }
            if (options.once) {
                final = { ...tick, ok: true, status: 'watch-once', watchStatus: tick.status, terminal: false };
                break;
            }
            if (options.maxIterations && iteration >= options.maxIterations) {
                final = { ...tick, ok: true, status: 'watch-max-iterations', watchStatus: tick.status, terminal: false };
                await emit({ type: 'watch.max-iterations', status: 'watch-max-iterations', terminal: false, iteration });
                break;
            }
            await sleep(options.intervalMs);
        }
        return {
            // Not unconditionally true: a fail-closed tick has to reach the
            // caller as a failure.
            ok: final?.errorCode !== 'provider.file-artifact'
                && final?.errorCode !== 'session.generation-superseded',
            status: final?.status || 'watch-complete',
            sessionId: options.sessionId,
            generation,
            final,
            eventsPrinted: true,
            events: options.captureEvents ? /** @type {any} */ (events) : undefined,
        };
    } finally {
        lock.release();
    }
}

/**
 * @param {any} deps
 * @param {any} input
 * @param {{ probeCdpLiveness?: typeof probeCdpLiveness, reattachSessionPage?: typeof reattachSessionPage, callVendorPoll?: typeof callVendorPoll }} [recoveryDeps]
 */
export async function watchSessionOnce(deps, input = {}, recoveryDeps = {}) {
    const options = normalizeWatchOptions(input);
    const session = getSession(options.sessionId);
    if (!session) {
        throw new WebAiError({
            errorCode: 'watcher.session-missing',
            stage: 'watcher-load-session',
            retryHint: 'sessions-list',
            message: `no session record for ${options.sessionId}`,
            evidence: { sessionId: options.sessionId },
        });
    }
    const vendor = session.vendor || options.vendor || 'chatgpt';
    const generation = Number.isInteger(Number(input.generation)) && Number(input.generation) > 0
        ? Number(input.generation)
        : sessionGeneration(session);
    if (sessionGeneration(session) !== generation) {
        return supersededWatchTick(session, vendor, generation);
    }
    if (options.vendor && session.vendor && options.vendor !== session.vendor) {
        throw new WebAiError({
            errorCode: 'watcher.vendor-mismatch',
            stage: 'watcher-load-session',
            retryHint: 'omit-vendor-or-use-session-vendor',
            message: `session ${options.sessionId} belongs to ${session.vendor}, not ${options.vendor}`,
            vendor: options.vendor,
            evidence: { sessionVendor: session.vendor, requestedVendor: options.vendor },
        });
    }

    if (session.status === 'timeout' && !isDeadlineExpired(session.deadlineAt)) {
        const restored = await restorePollingBeforeDeadline(
            session.sessionId,
            generation,
            session.deadlineAt,
            {
                status: 'polling',
                warnings: appendUniqueWarning(session.warnings || [], 'watcher-resumed-transient-timeout'),
            },
        );
        if (restored === GENERATION_CHANGED) return supersededWatchTick(session, vendor, generation);
        if (restored !== DEADLINE_PASSED) session.status = restored?.status || session.status;
    }
    if (TERMINAL_SESSION_STATUSES.has(session.status)) {
        return {
            ok: true, sessionId: session.sessionId, vendor,
            status: session.status, terminal: true, generation,
            answerText: session.answer || null,
            warnings: session.warnings || [],
        };
    }
    if (isDeadlineExpired(session.deadlineAt)) {
        const expired = await updateSessionForGeneration(session.sessionId, generation, {
            status: 'timeout',
            lastError: { errorCode: 'provider.poll-timeout', message: 'watcher deadline reached' },
        });
        if (expired === GENERATION_CHANGED) return supersededWatchTick(session, vendor, generation);
        return {
            ok: true, sessionId: session.sessionId, vendor,
            status: 'timeout', terminal: true, generation,
            warnings: ['deadline-reached'],
        };
    }

    // Phase 9.1: Use withSessionPage to resolve session's specific page, not active tab.
    // resolveSessionPage (allowNavigate) already self-heals root->/c/ URL drift and
    // returns the updated session; use that healed copy for the attach check instead
    // of the stale outer `session`, which previously re-introduced a false
    // reattach-mismatch (issue #77 watch-path).
    const pollVendor = recoveryDeps.callVendorPoll || callVendorPoll;
    let consumedDisconnect = null;
    try {
        // The recovery inside the resolver performs binding writes; under a
        // stored deadline those writes are refused post-lock once it passes.
        const result = await withSessionPageGuarded(deps, options.sessionId, async ({ page, targetId, session: resolvedSession }) => {
        if (sessionGeneration(resolvedSession || session) !== generation) {
            return supersededWatchTick(session, vendor, generation);
        }
        const profileLockSummary = await readProfileLockSummary()
            .catch(err => ({ state: 'unknown', error: err?.message || String(err) }));
        const reattach = await ensureWatcherAttached(page, resolvedSession || session, options);
        if (!reattach.ok) {
            return {
                ok: false, sessionId: session.sessionId, vendor,
                status: 'reattach-mismatch', terminal: false,
                url: reattach.url, warnings: reattach.warnings,
                profileLock: profileLockSummary,
            };
        }

        const preflight = await runWatcherPreflight(page, vendor);
        if (preflight.worst === 'fail') {
            const failed = await updateSessionForGeneration(session.sessionId, generation, {
                status: 'polling',
                lastError: {
                    errorCode: 'capability.unsupported',
                    message: 'pre-poll capability failed',
                    evidence: preflight.rows,
                },
            });
            if (failed === GENERATION_CHANGED) return supersededWatchTick(session, vendor, generation);
            return {
                ok: false, sessionId: session.sessionId, vendor,
                status: 'capability-fail', terminal: false,
                warnings: ['pre-poll-capability-fail'],
                preflight, profileLock: profileLockSummary,
            };
        }

        // Create session-specific deps so poll functions use the right page
        const sessionDeps = {
            ...deps,
            getPage: async () => page,
            getTargetId: async () => targetId,
            // Bound to the RESOLVED page like `poll` and `sessions resume` do.
            // Inheriting the outer `getCdpSession` attaches to whatever page
            // that closure captured, so artifact detection could read a
            // different tab's DOM — or report no CDP at all.
            getCdpSession: async () => {
                const context = (/** @type {any} */ (page))?.context?.();
                if (!context?.newCDPSession) return deps.getCdpSession?.();
                return context.newCDPSession(page);
            },
        };

        const domHashBefore = await domHashAround(/** @type {any} */ (page), ['body'], { maxChars: options.domHashMaxChars }).catch(() => null);
        const pollResult = await pollVendor(sessionDeps, vendor, resolvedSession || session, {
            ...options,
            generation,
        });
        if (pollResult?.errorCode === 'session.generation-superseded' || pollResult?.status === 'superseded') {
            return supersededWatchTick(session, vendor, generation);
        }
        if (pollResult?.status === 'tab-crashed' && isCdpDisconnectError(pollResult.error)) {
            consumedDisconnect = { error: pollResult.error, pollResult };
            return pollResult;
        }
        const domHashAfter = await domHashAround(/** @type {any} */ (page), ['body'], { maxChars: options.domHashMaxChars }).catch(() => null);
        const answerText = typeof (/** @type {any} */ (pollResult)).answerText === 'string'
            ? (/** @type {any} */ (pollResult)).answerText
            : (typeof (/** @type {any} */ (pollResult)).answer === 'string' ? (/** @type {any} */ (pollResult)).answer : null);
        const refreshed = getSession(session.sessionId) || session;
        if (sessionGeneration(refreshed) !== generation) {
            return supersededWatchTick(session, vendor, generation);
        }
        let status = refreshed.status || pollResult.status || 'polling';
        /** @type {string[]} */
        const watcherWarnings = [];

        if (status === 'timeout' && !isDeadlineExpired(refreshed.deadlineAt || session.deadlineAt)) {
            const deadlineAtValue = refreshed.deadlineAt || session.deadlineAt;
            const restored = await restorePollingBeforeDeadline(session.sessionId, generation, deadlineAtValue, {
                status: 'polling',
                warnings: appendUniqueWarning(
                    refreshed.warnings || [],
                    `watcher-transient-poll-timeout:${options.pollTimeoutSec}s`,
                ),
            });
            if (restored === GENERATION_CHANGED) return supersededWatchTick(session, vendor, generation);
            if (restored !== DEADLINE_PASSED) status = restored?.status || status;
        }
        const observed = await updateSessionForGeneration(session.sessionId, generation, {
            lastDomHash: domHashAfter || domHashBefore || refreshed.lastDomHash || null,
            lastStreamingState: deriveStreamingState(status, pollResult),
            lastResponseCharCount: answerText ? answerText.length : (refreshed.lastResponseCharCount || 0),
        });
        if (observed === GENERATION_CHANGED) return supersededWatchTick(session, vendor, generation);

        return {
            ok: pollResult.ok !== false,
            sessionId: session.sessionId,
            vendor,
            status,
            generation,
            terminal: TERMINAL_SESSION_STATUSES.has(status),
            url: (/** @type {any} */ (page)).url?.() || null,
            answerText,
            warnings: mergeWarnings(reattach.warnings || [], pollResult.warnings || [], watcherWarnings),
            // Typed failures have to survive this adapter. Dropping the code,
            // stage, hint and evidence turned a fail-closed poll result into an
            // ordinary non-terminal tick, which is the silence the contract
            // exists to remove.
            ...(pollResult.errorCode ? { errorCode: pollResult.errorCode } : {}),
            ...(pollResult.stage ? { stage: pollResult.stage } : {}),
            ...(pollResult.retryHint ? { retryHint: pollResult.retryHint } : {}),
            ...(pollResult.evidence ? { evidence: pollResult.evidence } : {}),
            ...(pollResult.artifacts ? { artifacts: pollResult.artifacts } : {}),
            preflight,
            profileLock: profileLockSummary,
        };
        }, { stillActive: storedDeadlineStillActive(session) });
        if (!consumedDisconnect) return result;
    } catch (err) {
        if (!isCdpDisconnectError(err)) throw err;
        return recoverCdpDisconnect(deps, options, vendor, generation, err, null, recoveryDeps);
    }
    return recoverCdpDisconnect(
        deps,
        options,
        vendor,
        generation,
        consumedDisconnect.error,
        consumedDisconnect.pollResult,
        recoveryDeps,
    );
}

/**
 * One durable, target-preserving recovery attempt. This intentionally does not
 * re-run attach checks, preflight, or the original harvest callback.
 * @param {any} deps
 * @param {any} options
 * @param {string} vendor
 * @param {number} generation
 * @param {unknown} disconnect
 * @param {any} consumedResult
 * @param {{ probeCdpLiveness?: typeof probeCdpLiveness, reattachSessionPage?: typeof reattachSessionPage, callVendorPoll?: typeof callVendorPoll }} recoveryDeps
 */
async function recoverCdpDisconnect(deps, options, vendor, generation, disconnect, consumedResult, recoveryDeps) {
    const preserved = getSession(options.sessionId);
    if (!preserved) throw disconnect;
    if (sessionGeneration(preserved) !== generation) {
        return supersededWatchTick(preserved, vendor, generation);
    }
    const fingerprint = cdpDisconnectFingerprint(preserved.targetId, disconnect);
    if (preserved.cdpRecovery?.fingerprint === fingerprint) {
        return consumedResult || {
            ok: false, sessionId: preserved.sessionId, vendor,
            status: preserved.status || 'polling', terminal: false,
            warnings: appendUniqueWarning(preserved.warnings || [], 'watcher-cdp-recovery-already-attempted'),
        };
    }

    const attemptedAt = new Date().toISOString();
    const attempted = await updateSessionForGeneration(
        preserved.sessionId,
        generation,
        { cdpRecovery: { fingerprint, attemptedAt } },
    );
    if (attempted === GENERATION_CHANGED) return supersededWatchTick(preserved, vendor, generation);
    const probe = recoveryDeps.probeCdpLiveness || probeCdpLiveness;
    const liveness = await probe({ port: deps.getPort(), targetId: preserved.targetId });
    const recoverable = isRecoverableCdpDisconnect(liveness);
    const warning = recoverable ? 'watcher-cdp-reattach-once' : 'watcher-cdp-recovery-skipped';
    const recorded = await updateSessionForGeneration(preserved.sessionId, generation, {
        status: recoverable ? 'polling' : preserved.status,
        lastError: {
            errorCode: 'watcher.cdp-disconnected',
            message: recoverable
                ? 'CDP client disconnected; saved target is still reachable'
                : 'CDP connection lost and saved target liveness was not proven',
            evidence: { ...liveness, recoverable, fingerprint },
        },
        warnings: appendUniqueWarning(preserved.warnings || [], warning),
    });
    if (recorded === GENERATION_CHANGED) return supersededWatchTick(preserved, vendor, generation);
    if (!recoverable) {
        if (consumedResult) return { ...consumedResult, warnings: mergeWarnings(consumedResult.warnings || [], [warning]) };
        throw disconnect;
    }

    const reattach = recoveryDeps.reattachSessionPage || reattachSessionPage;
    const resolved = await reattach(deps, preserved.sessionId);
    const checkpoint = getSession(preserved.sessionId) || preserved;
    if (sessionGeneration(checkpoint) !== generation) {
        return supersededWatchTick(checkpoint, vendor, generation);
    }
    if (hasFinalizedSession(checkpoint)) {
        return {
            ok: true, sessionId: checkpoint.sessionId, vendor,
            status: checkpoint.status, terminal: true,
            answerText: checkpoint.answer || null,
            warnings: checkpoint.warnings || [],
        };
    }

    const sessionDeps = {
        ...deps,
        getPage: async () => resolved.page,
        getTargetId: async () => resolved.targetId,
        // Same reason as the ordinary tick: after a reattach the outer
        // `getCdpSession` still points at the page this recovery replaced.
        getCdpSession: async () => {
            const context = (/** @type {any} */ (resolved.page))?.context?.();
            if (!context?.newCDPSession) return deps.getCdpSession?.();
            return context.newCDPSession(resolved.page);
        },
    };
    const pollVendor = recoveryDeps.callVendorPoll || callVendorPoll;
    const pollResult = await pollVendor(sessionDeps, vendor, checkpoint, { ...options, generation });
    if (pollResult?.errorCode === 'session.generation-superseded' || pollResult?.status === 'superseded') {
        return supersededWatchTick(checkpoint, vendor, generation);
    }
    const refreshed = getSession(checkpoint.sessionId) || checkpoint;
    if (sessionGeneration(refreshed) !== generation) {
        return supersededWatchTick(refreshed, vendor, generation);
    }
    const status = refreshed.status || pollResult.status || 'polling';
    const answerText = typeof pollResult.answerText === 'string'
        ? pollResult.answerText
        : (typeof pollResult.answer === 'string' ? pollResult.answer : null);
    return {
        ok: pollResult.ok !== false,
        sessionId: checkpoint.sessionId,
        vendor,
        status,
        generation,
        terminal: TERMINAL_SESSION_STATUSES.has(status),
        url: resolved.page?.url?.() || null,
        answerText,
        warnings: mergeWarnings(pollResult.warnings || [], [warning]),
        // Carried through the recovery adapter for the same reason as the
        // ordinary tick: dropping them turns a fail-closed poll into a plain
        // non-terminal result.
        ...(pollResult.errorCode ? { errorCode: pollResult.errorCode } : {}),
        ...(pollResult.stage ? { stage: pollResult.stage } : {}),
        ...(pollResult.retryHint ? { retryHint: pollResult.retryHint } : {}),
        ...(pollResult.evidence ? { evidence: pollResult.evidence } : {}),
        ...(pollResult.artifacts ? { artifacts: pollResult.artifacts } : {}),
    };
}

/** @param {any} session */
function hasFinalizedSession(session) {
    return TERMINAL_SESSION_STATUSES.has(session?.status) || Boolean(session?.completedAt) || Boolean(session?.answer);
}

/** @param {string|null|undefined} targetId @param {unknown} err */
function cdpDisconnectFingerprint(targetId, err) {
    const message = String((/** @type {any} */ (err))?.message || err || '')
        .toLowerCase().replace(/\s+/g, ' ').trim();
    return `${targetId || 'missing-target'}:${message}`;
}

/**
 * @param {any} opts
 */
export function createStdoutNotifier({ json = false, stream = process.stdout } = {}) {
    return async function notify(/** @type {any} */ event) {
        if (json) {
            stream.write(`${JSON.stringify(event)}\n`);
            return;
        }
        const bits = [
            '[web-ai watch]', event.capturedAt,
            `session=${event.sessionId}`, `type=${event.type}`,
            `status=${event.status || 'unknown'}`,
        ];
        if (event.vendor) bits.push(`vendor=${event.vendor}`);
        if (event.terminal) bits.push('terminal=true');
        if (event.warnings?.length) bits.push(`warnings=${event.warnings.join(',')}`);
        stream.write(`${bits.join('  ')}\n`);
    };
}

/**
 * @param {any} input
 */
export function normalizeWatchOptions(input = {}) {
    const sessionId = input.session || input.sessionId || null;
    const intervalMs = durationToMs(input.interval || input.intervalMs || DEFAULT_WATCH_INTERVAL_MS, 's');
    const pollTimeoutSec = Number(input.pollTimeoutSec || input.pollTimeout || DEFAULT_WATCH_POLL_TIMEOUT_SEC);
    const maxIterations = input.maxIterations === undefined || input.maxIterations === null || input.maxIterations === ''
        ? null : Number(input.maxIterations);
    const hasExplicitTimeout = input.timeout !== undefined
        && input.timeout !== null
        && input.timeout !== '';
    const deadlineAt = input.deadline
        ? toIsoDeadline(input.deadline, 'deadline')
        : hasExplicitTimeout && Number(input.timeout) > 0
            ? new Date(Date.now() + Number(input.timeout) * 1000).toISOString()
            : input.deadlineAt || null;
    return {
        ...input,
        sessionId,
        intervalMs,
        pollTimeoutSec: Number.isFinite(pollTimeoutSec) && pollTimeoutSec > 0 ? pollTimeoutSec : DEFAULT_WATCH_POLL_TIMEOUT_SEC,
        maxIterations: Number.isFinite(maxIterations) && (/** @type {number} */ (maxIterations)) > 0 ? maxIterations : null,
        deadlineAt,
        hasExplicitDeadlineOverride: Boolean(deadlineAt),
        once: input.once === true,
        navigate: input.navigate === true,
        json: input.json === true,
        captureEvents: input.captureEvents === true,
        lockStaleMs: durationToMs(input.lockStaleMs || DEFAULT_WATCH_LOCK_STALE_MS, 'ms'),
        domHashMaxChars: Number(input.domHashMaxChars || 32768),
        navigateTimeoutMs: Number(input.navigateTimeoutMs || 30_000),
    };
}

/**
 * @param {any} sessionId
 * @param {any} opts
 */
export function acquireWatcherSessionLock(sessionId, { staleMs = DEFAULT_WATCH_LOCK_STALE_MS } = {}) {
    const dir = watcherLockPath(sessionId);
    const ownerToken = randomBytes(16).toString('hex');
    mkdirSync(watcherHome(), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            mkdirSync(dir);
            writeWatcherLockMetadata(dir, {
                sessionId, pid: process.pid, ownerToken,
                startedAt: new Date().toISOString(),
                heartbeatAt: new Date().toISOString(),
            });
            return {
                lockPath: dir,
                heartbeat(extra = {}) {
                    const current = readWatcherLockMetadata(dir);
                    if (current?.ownerToken !== ownerToken) return false;
                    writeWatcherLockMetadata(dir, {
                        sessionId, pid: process.pid, ownerToken,
                        heartbeatAt: new Date().toISOString(), ...extra,
                    });
                    return true;
                },
                release() {
                    const current = readWatcherLockMetadata(dir);
                    if (current?.ownerToken === ownerToken) {
                        rmSync(dir, { recursive: true, force: true });
                    }
                },
            };
        } catch (err) {
            if ((/** @type {any} */ (err))?.code !== 'EEXIST') throw err;
            const existing = readWatcherLockMetadata(dir);
            if (isWatcherLockStale(existing, staleMs)) {
                rmSync(dir, { recursive: true, force: true });
                continue;
            }
            throw new WebAiError({
                errorCode: 'watcher.already-running',
                stage: 'watcher-lock',
                retryHint: 'reuse-existing-watcher-or-remove-stale-lock',
                message: `a watcher is already running for session ${sessionId}`,
                evidence: existing,
            });
        }
    }
    throw new WebAiError({
        errorCode: 'watcher.already-running',
        stage: 'watcher-lock',
        retryHint: 'retry',
        message: `failed to acquire watcher lock for ${sessionId}`,
    });
}

/**
 * @param {any} page
 * @param {any} vendor
 */
export async function runWatcherPreflight(page, vendor) {
    const expectedHosts = (/** @type {any} */ (PROVIDER_HOSTS))[vendor] || new Set();
    const composer = featureDefinitionsForVendor(vendor).find(f => f.feature === 'composer');
    const capabilities = [
        defineCapability('provider.host', /** @type {any} */ ((/** @type {{page:any}} */ { page: p }) => probeHostMatches(p, expectedHosts))),
    ];
    if (composer) {
        capabilities.push(defineCapability('provider.composer-visible', /** @type {any} */ ((/** @type {{page:any}} */ { page: p }) =>
            probeFirstVisibleSelector(p, /** @type {string[]} */ (composer.selectors), {
                timeoutMs: 750,
                failState: 'warn',
                failNext: 'poll',
                okNext: 'poll',
            }))));
    }
    const rows = await runCapabilities({ page }, capabilities, { vendor });
    return { rows, worst: worstCapabilityState(rows) };
}

/**
 */
export async function readProfileLockSummary() {
    const candidates = ['getProfileLockStatus', 'readProfileLock', 'getProfileLock', 'inspectProfileLock'];
    for (const name of candidates) {
        if (typeof (/** @type {any} */ (profileLock))[name] !== 'function') continue;
        const value = await (/** @type {any} */ (profileLock))[name]();
        return { state: 'ok', source: name, evidence: scrubProfileLockEvidence(value) };
    }
    return { state: 'unknown', reason: 'no-compatible-profile-lock-export' };
}

/**
 * @param {any} page
 * @param {string} vendor
 */
export async function hasStreamingIndicator(page, vendor) {
    const selectors = (/** @type {Record<string, string[]>} */ (WATCHER_STREAMING_SELECTORS))[vendor] || [];
    for (const selector of selectors) {
        const first = page.locator?.(selector)?.first?.();
        if (typeof first?.isVisible === 'function' && await first.isVisible().catch(() => false)) return true;
    }
    return false;
}

// --- internal helpers ---

/**
 * @param {any} page
 * @param {any} session
 * @param {any} options
 */
async function ensureWatcherAttached(page, session, options) {
    const targetUrl = session.conversationUrl || session.originalUrl;
    if (!targetUrl) return { ok: true, warnings: ['session-has-no-conversation-url'] };
    const currentUrl = page.url?.() || '';
    // Use the canonical tolerant predicate (shared with resolveSessionPage) instead
    // of a stricter hash-only compare: same-conversation root->/c/ drift and trailing
    // slashes are compatible, while a genuinely different conversation or a
    // non-provider landing still mismatches. Only non-ChatGPT providers retain
    // the explicit --navigate compatibility path below.
    if (urlsCompatible(targetUrl, currentUrl)) return { ok: true, url: currentUrl, warnings: [] };
    if (session.vendor === 'chatgpt') {
        return {
            ok: false,
            url: currentUrl,
            warnings: [`current ChatGPT target ${currentUrl} does not match session conversation ${targetUrl}; refusing hidden navigation`],
        };
    }
    if (options.navigate) {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: options.navigateTimeoutMs });
        // G9: Verify conversation readiness after navigation (Oracle 83c3ca2).
        // Catches login pages, error pages, and incomplete loads that domcontentloaded misses.
        try {
            const readySelector = 'textarea[data-id="root"], [data-testid="prompt-textarea"], [id="prompt-textarea"], [data-message-author-role="assistant"]';
            await page.locator(readySelector).first()
                .waitFor({ state: 'visible', timeout: 10_000 })
                .catch(() => undefined);
        } catch { /* best-effort readiness check */ }
        const finalUrl = page.url?.() || targetUrl;
        return { ok: true, url: finalUrl, warnings: [`reattached:navigated-from=${currentUrl}`] };
    }
    return {
        ok: false,
        url: currentUrl,
        warnings: [`current tab ${currentUrl} does not match session conversationUrl ${targetUrl}; pass --navigate to switch tabs`],
    };
}

/**
 * @param {any} deps
 * @param {any} vendor
 * @param {any} session
 * @param {any} options
 */
async function callVendorPoll(deps, vendor, session, options) {
    const pollFn = isWorkSession(session) ? pollWorkSession
        : vendor === 'gemini' ? geminiPollWebAi
        : vendor === 'grok' ? grokPollWebAi
            : pollWebAi;
    try {
        return await pollFn(deps, {
            vendor,
            session: session.sessionId,
            generation: Number(options.generation || sessionGeneration(session)),
            // Clamped to the stored deadline, and fractional. This is a PER-POLL
            // slice — 30s by default — and passing it straight through let a
            // session with 400ms left poll for another 30 seconds, because the
            // provider treats an explicit timeout as the caller's authority.
            // A whole-second floor here was the same bug one order smaller: it
            // rounded 400ms back up to a full second.
            timeout: String(resolvePollTimeoutSec(
                { timeout: options.pollTimeoutSec },
                session,
                vendor,
            )),
            allowCopyMarkdownFallback: options.allowCopyMarkdownFallback === true,
            navigate: options.navigate === true,
        });
    } catch (rawErr) {
        const err = wrapError(rawErr);
        if (err.errorCode === 'provider.poll-timeout' && !isDeadlineExpired(session.deadlineAt)) {
            const generation = Number(options.generation || sessionGeneration(session));
            const restored = await restorePollingBeforeDeadline(session.sessionId, generation, session.deadlineAt, {
                status: 'polling',
                lastError: err.toJSON ? err.toJSON() : { errorCode: err.errorCode, message: err.message },
            });
            if (restored === GENERATION_CHANGED) {
                return supersededWatchTick(session, vendor, generation);
            }
            if (restored !== DEADLINE_PASSED) {
                return { ok: true, status: 'polling', warnings: [`transient-poll-timeout:${options.pollTimeoutSec}s`] };
            }
            return { ok: true, status: 'timeout', warnings: ['deadline-reached'] };
        }
        throw err;
    }
}

/**
 * Restore a transient timeout only while the stored absolute deadline is live.
 * The predicate is re-checked after the store lock is acquired.
 * @param {string} sessionId
 * @param {number} generation
 * @param {string|null|undefined} deadlineAtValue
 * @param {Record<string, unknown>} patch
 */
export function restorePollingBeforeDeadline(sessionId, generation, deadlineAtValue, patch) {
    return updateSessionForGeneration(
        sessionId,
        generation,
        patch,
        () => Date.now() < Date.parse(/** @type {string} */ (deadlineAtValue)),
    );
}

/**
 * @param {any} session
 * @param {string} vendor
 * @param {number} generation
 */
function supersededWatchTick(session, vendor, generation) {
    return {
        ok: false,
        sessionId: session.sessionId,
        vendor,
        status: 'superseded',
        terminal: true,
        generation,
        currentGeneration: sessionGeneration(getSession(session.sessionId) || session),
        answerText: null,
        warnings: ['session-generation-superseded'],
        errorCode: 'session.generation-superseded',
        retryHint: 'use-latest-generation',
    };
}

/**
 * @param {any} status
 * @param {any} result
 */
function deriveStreamingState(status, result = {}) {
    if (status === 'streaming' || result.streaming === true) return 'streaming';
    if (TERMINAL_SESSION_STATUSES.has(status)) return 'idle';
    return 'unknown';
}

/**
 * @param {any} warnings
 * @param {any} warning
 */
function appendUniqueWarning(warnings, warning) {
    return warnings.includes(warning) ? warnings : [...warnings, warning];
}

/**
 * @param  {...unknown[]} groups
 * @returns {string[]}
 */
function mergeWarnings(...groups) {
    /** @type {string[]} */
    const out = [];
    for (const group of groups) {
        for (const item of Array.isArray(group) ? group : []) {
            if (!out.includes(String(item))) out.push(String(item));
        }
    }
    return out;
}

/**
 * @param {any} deadlineAt
 */
function isDeadlineExpired(deadlineAt) {
    if (!deadlineAt) return false;
    const t = Date.parse(deadlineAt);
    return Number.isFinite(t) && Date.now() >= t;
}

/**
 * @param {any} value
 * @param {any} label
 */
function toIsoDeadline(value, label) {
    const t = Date.parse(value);
    if (!Number.isFinite(t)) {
        throw new WebAiError({
            errorCode: 'internal.unhandled',
            stage: 'watcher-start',
            retryHint: 'fix-argument',
            message: `invalid ${label}: ${value}`,
        });
    }
    return new Date(t).toISOString();
}

/**
 * @param {any} value
 * @param {any} defaultUnit
 */
function durationToMs(value, defaultUnit = 's') {
    if (typeof value === 'number') return value;
    const match = /^(\d+)\s*(ms|s|m|h)?$/i.exec(String(value || '').trim());
    if (!match) return DEFAULT_WATCH_INTERVAL_MS;
    const n = Number(match[1]);
    const unit = (match[2] || defaultUnit).toLowerCase();
    const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 1000;
    return n * factor;
}

/**
 */
function watcherHome() {
    return join(process.env.BROWSER_AGENT_HOME || join(homedir(), '.browser-agent'), 'web-ai-watchers');
}

/**
 * @param {any} sessionId
 */
function watcherLockPath(sessionId) {
    return join(watcherHome(), `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.lock`);
}

/**
 * @param {any} dir
 * @param {any} metadata
 */
function writeWatcherLockMetadata(dir, metadata) {
    writeFileSync(join(dir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

/**
 * @param {any} dir
 */
function readWatcherLockMetadata(dir) {
    try {
        if (!existsSync(join(dir, 'metadata.json'))) return null;
        return JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * @param {any} metadata
 * @param {any} staleMs
 */
function isWatcherLockStale(metadata, staleMs) {
    if (!metadata) return true;
    // A watcher owned by a live local process is not stealable. Forced exit or
    // kill makes the PID probe fail immediately, so the next watcher can
    // reclaim the directory without waiting for a TTL and without an ABA race
    // from the former owner heartbeat/release.
    return !pidAlive(Number(metadata.pid));
}

/**
 * @param {any} pid
 */
function pidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (err) { return (/** @type {any} */ (err))?.code === 'EPERM'; }
}

/**
 * @param {any} value
 */
function scrubProfileLockEvidence(value) {
    if (!value || typeof value !== 'object') return value ?? null;
    const out = {};
    for (const key of ['pid', 'ownerPid', 'token', 'targetId', 'endpoint', 'wsEndpoint', 'createdAt', 'updatedAt', 'acquiredAt']) {
        if (Object.prototype.hasOwnProperty.call(value, key)) (/** @type {any} */ (out))[key] = (/** @type {any} */ (value))[key];
    }
    return out;
}

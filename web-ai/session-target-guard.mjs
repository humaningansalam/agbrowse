// @ts-check

const DEFAULT_VENDOR = 'chatgpt';

/**
 * @param {any} value
 * @returns {string}
 */
export function normalizeWebAiVendor(value) {
    return String(value || DEFAULT_VENDOR);
}

/**
 * @param {any} session
 * @returns {SessionCandidate}
 */
/**
 * @param {string} vendor
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionPollRecoveryCommand(vendor, sessionId) {
    return `agbrowse web-ai poll --vendor ${normalizeWebAiVendor(vendor)} --session ${sessionId} --navigate --json`;
}

/**
 * @param {{
 *   vendor: string,
 *   session: any,
 *   actualTargetId: string,
 *   port?: number,
 *   url?: string,
 *   baseline?: any,
 * }} input
 * @returns {Record<string, any>}
 */
export function buildTargetMismatchResult(input) {
    const expectedTargetId = input.session?.targetId || null;
    const actualTargetId = input.actualTargetId || null;
    const port = Number(input.port || 9222);
    const sessionId = String(input.session?.sessionId || '');
    const recovery = sessionPollRecoveryCommand(input.vendor, sessionId);
    const targetMismatch = {
        expectedTargetId,
        actualTargetId,
        port,
        sessionId,
        vendor: input.vendor,
        recovery,
    };
    return {
        ok: false,
        vendor: input.vendor,
        status: 'target-mismatch',
        url: input.url || input.session?.conversationUrl || input.session?.originalUrl || '',
        sessionId,
        answerText: '',
        baseline: input.baseline,
        usedFallbacks: [],
        expectedTargetId,
        actualTargetId,
        port,
        targetMismatch,
        recovery,
        warnings: [`poll target changed: ${expectedTargetId || 'unknown'} -> ${actualTargetId || 'unknown'}`],
        error: 'target changed during poll',
    };
}

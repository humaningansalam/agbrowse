/**
 * Tab Manager — self-contained (no import from browser.mjs to avoid circular deps)
 */
// @ts-check
/// <reference types="playwright-core" />

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * @typedef {import('playwright-core').Browser} Browser
 * @typedef {import('playwright-core').Page} Page
 * @typedef {import('playwright-core').CDPSession} CDPSession
 * @typedef {{ browser: Browser, connectedAt: number }} CdpConnectionEntry
 * @typedef {{ id?: string, type?: string, url?: string, title?: string, attached?: boolean }} RawTab
 * @typedef {{ send: (method: string, params?: Record<string, unknown>) => Promise<any>, detach: () => Promise<void> }} CdpSessionLike
 * @typedef {{ targetId: string, url: string, title: string, activated: boolean, lastActiveAt: number|null, reusedBlank?: boolean }} CreateTabResult
 * @typedef {{ closed: boolean, targetId: string, alreadyClosed?: boolean }} CloseTabResult
 * @typedef {{ active: true, previousTargetId: string|undefined, currentTargetId: string, lastActiveAt: number|null }} SwitchTabResult
 * @typedef {{ targetId: string, url: string, title: string, type: string, attached?: boolean, lastActiveAt: number|null }} ManagedTabRow
 * @typedef {{ targetId: string, url: string, title: string, type: string }} TabInfo
 * @typedef {{ activate?: boolean, reuseBlank?: boolean, onCreated?: (targetId: string) => void|Promise<void> }} TabOpts
 */

/** One in-process connection per exact page, never a browser-wide attach. */
const targetConnections = new Map();
/** @type {Map<string, number>} */
const tabActivity = new Map();
let tabActivityLoaded = false;

const DATA_DIR = process.env.BROWSER_AGENT_HOME || join(homedir(), '.browser-agent');
const TAB_ACTIVITY_FILE = join(DATA_DIR, 'tab-activity.json');

function loadTabActivity() {
    if (tabActivityLoaded) return;
    tabActivityLoaded = true;
    if (!existsSync(TAB_ACTIVITY_FILE)) return;
    try {
        const parsed = /** @type {{ tabs?: Record<string, number> }} */ (JSON.parse(readFileSync(TAB_ACTIVITY_FILE, 'utf8')));
        for (const [targetId, lastActiveAt] of Object.entries(parsed.tabs || {})) {
            if (targetId && Number.isFinite(lastActiveAt)) tabActivity.set(targetId, lastActiveAt);
        }
    } catch {
        tabActivity.clear();
    }
}

function saveTabActivity() {
    mkdirSync(dirname(TAB_ACTIVITY_FILE), { recursive: true });
    const tabs = Object.fromEntries(tabActivity.entries());
    writeFileSync(TAB_ACTIVITY_FILE, `${JSON.stringify({ tabs }, null, 2)}\n`);
}

/**
 * @param {string} targetId
 * @param {number} [at]
 * @returns {number|null}
 */
export function markTabActive(targetId, at = Date.now()) {
    if (!targetId) return null;
    loadTabActivity();
    tabActivity.set(targetId, at);
    saveTabActivity();
    return at;
}

/**
 * @param {string} targetId
 */
export function forgetTabActivity(targetId) {
    if (!targetId) return;
    loadTabActivity();
    tabActivity.delete(targetId);
    saveTabActivity();
}

/**
 * @param {string} targetId
 * @returns {number|null}
 */
export function getTabActivity(targetId) {
    loadTabActivity();
    return tabActivity.get(targetId) || null;
}

/** @returns {Promise<typeof import('playwright-core')>} */
async function loadPlaywright() {
    try {
        return await import('playwright-core');
    } catch (error) {
        const err = /** @type {{ code?: string, message?: string }} */ (error);
        if (err?.code === 'ERR_MODULE_NOT_FOUND' || String(err?.message || '').includes('playwright-core')) {
            throw new Error(
                `playwright-core is required.\n` +
                `  Fix: cd <project-root> && npm install playwright-core`
            );
        }
        throw error;
    }
}

/**
 * @param {number} port
 * @returns {Promise<CDPSession|CdpSessionLike|null>}
 */
async function getCdpSession(port) {
    // Target creation/closure is browser-scoped and needs no renderer attach.
    return createRawBrowserCdpSession(port);
}

/**
 * @param {number} port
 * @returns {Promise<CdpSessionLike|null>}
 */
async function createRawBrowserCdpSession(port) {
    const version = /** @type {{ webSocketDebuggerUrl?: string }} */ (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5_000) }).then(resp => resp.json()));
    const endpoint = version?.webSocketDebuggerUrl;
    if (!endpoint) return null;
    const WebSocketImpl = globalThis.WebSocket || (await import('playwright-core/lib/utilsBundle')).ws;
    const ws = new WebSocketImpl(endpoint);
    let nextId = 1;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (reason?: unknown) => void }>} */
    const pending = new Map();
    ws.addEventListener('message', event => {
        /** @type {{ id?: number, error?: { message?: string }, result?: unknown } | null} */
        let payload = null;
        try { payload = JSON.parse(String(/** @type {{ data: unknown }} */ (event).data)); } catch { return; }
        if (!payload?.id || !pending.has(payload.id)) return;
        const entry = /** @type {{ resolve: (value: any) => void, reject: (reason?: unknown) => void }} */ (pending.get(payload.id));
        const { resolve, reject } = entry;
        pending.delete(payload.id);
        if (payload.error) reject(new Error(payload.error.message || JSON.stringify(payload.error)));
        else resolve(payload.result || {});
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.close(); reject(new Error('CDP browser connection timed out')); }, 5_000);
        ws.addEventListener('open', () => { clearTimeout(timer); resolve(undefined); }, { once: true });
        ws.addEventListener('error', err => { clearTimeout(timer); reject(err); }, { once: true });
    });
    return {
        async send(method, params = {}) {
            const id = nextId++;
            const promise = new Promise((resolve, reject) => {
                const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 5_000);
                pending.set(id, {
                    resolve: value => { clearTimeout(timer); resolve(value); },
                    reject: reason => { clearTimeout(timer); reject(reason); },
                });
            });
            ws.send(JSON.stringify({ id, method, params }));
            return promise;
        },
        async detach() {
            for (const { reject } of pending.values()) reject(new Error('CDP session detached'));
            pending.clear();
            if (ws.readyState === 1 || ws.readyState === 0) ws.close();
        }
    };
}

/**
 * @param {number} port
 * @returns {Promise<RawTab[]>}
 */
async function listTabs(port) {
    const resp = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) });
    const all = /** @type {RawTab[]} */ (await resp.json());
    return all.filter(t => t.type === 'page');
}

/**
 * @param {RawTab} tab
 * @param {RawTab[]} [allTabs]
 */
function isReusableBlankTab(tab, allTabs = []) {
    const url = String(tab?.url || '').toLowerCase();
    if (!tab?.id || !(url === 'about:blank' || url === '')) return false;
    // Safe automatic reuse: only the single startup blank is implicitly ours.
    return allTabs.length === 1;
}

// ─── Tab operations ──────────────────────────────────────

/**
 * Create a new browser tab and optionally navigate to URL
 * @param {number} port - CDP port
 * @param {string} [url] - Initial URL
 * @param {TabOpts} [opts] - Options
 * @returns {Promise<CreateTabResult>}
 */
export async function createTab(port, url = 'about:blank', opts = {}) {
    const cdp = await getCdpSession(port);
    if (!cdp) throw new Error('No CDP session available for tab creation');

    try {
        if (url !== 'about:blank' && opts.reuseBlank !== false) {
            const tabs = await listTabs(port);
            const blank = tabs.find(tab => isReusableBlankTab(tab, tabs));
            if (blank?.id) {
                const page = await waitForPageByTargetId(port, blank.id);
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                if (opts.activate !== false) {
                    await cdp.send('Target.activateTarget', { targetId: blank.id });
                }
                const now = markTabActive(blank.id);
                return {
                    targetId: blank.id,
                    url: page.url(),
                    title: await page.title().catch(() => 'New Tab'),
                    activated: opts.activate !== false,
                    lastActiveAt: now,
                    reusedBlank: true
                };
            }
        }

        const created = /** @type {{ targetId: string }} */ (await createTargetWithWindowFallback(cdp, url, opts));
        const { targetId } = created;

        // Let callers publish cross-process ownership before this fresh target
        // is observable as an otherwise-untracked tab. Cleanup running in a
        // different agent must not be able to close it during page attachment.
        await opts.onCreated?.(targetId);

        await new Promise(r => setTimeout(r, 100));

        const tabs = await listTabs(port);
        const tab = tabs.find(t => t.id === targetId);
        const now = markTabActive(targetId);

        return {
            targetId,
            url: tab?.url || url,
            title: tab?.title || 'New Tab',
            activated: opts.activate !== false,
            lastActiveAt: now
        };
    } finally {
        await cdp.detach().catch(() => { });
    }
}

/**
 * @param {CDPSession|CdpSessionLike} cdp
 * @param {string} url
 * @param {TabOpts} [opts]
 * @returns {Promise<{ targetId: string }>}
 */
async function createTargetWithWindowFallback(cdp, url, opts = {}) {
    try {
        return await cdp.send('Target.createTarget', {
            url,
            newWindow: false,
            background: !opts.activate
        });
    } catch (error) {
        const msg = String(/** @type {{ message?: string }} */ (error)?.message || '');
        if (!msg.includes('no browser is open')) throw error;
        return cdp.send('Target.createTarget', {
            url,
            newWindow: true,
            background: false
        });
    }
}

/**
 * Close a tab by targetId
 * @param {number} port - CDP port
 * @param {string} targetId - CDP target ID
 * @returns {Promise<CloseTabResult>}
 */
export async function closeTab(port, targetId) {
    const cdp = await getCdpSession(port);
    if (!cdp) throw new Error('No CDP session available for tab close');

    try {
        await cdp.send('Target.closeTarget', { targetId });
        forgetTabActivity(targetId);
        return { closed: true, targetId };
    } catch (error) {
        const msg = /** @type {{ message?: string }} */ (error)?.message;
        if (msg?.includes('No target')) {
            forgetTabActivity(targetId);
            return { closed: true, targetId, alreadyClosed: true };
        }
        throw error;
    } finally {
        await cdp.detach().catch(() => { });
    }
}

/**
 * Switch active tab to targetId
 * @param {number} port - CDP port
 * @param {string} targetId - CDP target ID
 * @returns {Promise<SwitchTabResult>}
 */
export async function switchToTab(port, targetId) {
    const cdp = await getCdpSession(port);
    if (!cdp) throw new Error('No CDP session available for tab switch');

    try {
        const info = /** @type {{ targetInfo?: { targetId?: string } }} */ (await cdp.send('Target.getTargetInfo'));
        const previousTargetId = info?.targetInfo?.targetId;

        await cdp.send('Target.activateTarget', { targetId });
        const now = markTabActive(targetId);

        return {
            active: true,
            previousTargetId,
            currentTargetId: targetId,
            lastActiveAt: now
        };
    } finally {
        await cdp.detach().catch(() => { });
    }
}

/**
 * List all managed tabs with metadata
 * @param {number} port - CDP port
 * @returns {Promise<ManagedTabRow[]>}
 */
export async function listManagedTabs(port) {
    const tabs = await listTabs(port);
    return tabs.map(t => ({
        targetId: /** @type {string} */ (t.id),
        url: /** @type {string} */ (t.url),
        title: /** @type {string} */ (t.title),
        type: /** @type {string} */ (t.type),
        attached: t.attached,
        lastActiveAt: getTabActivity(/** @type {string} */ (t.id))
    }));
}

/**
 * Get info for a specific tab
 * @param {number} port - CDP port
 * @param {string} targetId - Tab target ID
 * @returns {Promise<TabInfo>}
 */
export async function getTabInfo(port, targetId) {
    const tabs = await listTabs(port);
    const tab = tabs.find(t => t.id === targetId);
    if (!tab) throw new Error(`Tab not found: ${targetId}`);

    return {
        targetId: /** @type {string} */ (tab.id),
        url: /** @type {string} */ (tab.url),
        title: /** @type {string} */ (tab.title),
        type: /** @type {string} */ (tab.type)
    };
}

/**
 * Probe whether a tab is still alive.
 *
 * Reports `'unknown'` when the tab list could not be read at all — that is a
 * FAILED OBSERVATION, not evidence the tab is gone. `listTabs` is a single
 * `fetch` to the CDP port, so one transient failure would otherwise mark every
 * tab dead at once and callers would act destructively on all of them.
 *
 * There is no exception for connection errors. A refused connection says the
 * endpoint was not listening at that instant, which is not the same fact as
 * "this target no longer exists" — and acting on it destructively is exactly
 * the failure this probe exists to prevent. Only a SUCCESSFUL list that omits
 * the target proves it is gone. Reclaiming leases after a real browser exit
 * needs browser-lifecycle evidence, not a single failed fetch.
 *
 * @param {number} port - CDP port
 * @param {string} targetId - Tab target ID
 * @returns {Promise<'alive'|'gone'|'unknown'>}
 */
export async function probeTabAlive(port, targetId) {
    let tabs;
    try {
        tabs = await listTabs(port);
    } catch {
        return 'unknown';
    }
    return tabs.some(t => t.id === targetId) ? 'alive' : 'gone';
}

/**
 * Boolean view of {@link probeTabAlive}, kept for callers that genuinely only
 * need "can I use this tab right now". `'unknown'` reads as false here, so any
 * caller that takes a DESTRUCTIVE action on false must use `probeTabAlive`
 * directly and handle the third state.
 *
 * @param {number} port - CDP port
 * @param {string} targetId - Tab target ID
 * @returns {Promise<boolean>}
 */
export async function isTabAlive(port, targetId) {
    return (await probeTabAlive(port, targetId)) === 'alive';
}

/**
 * Wait for a page to be attached for a given targetId
 * @param {number} port - CDP port
 * @param {string} targetId - Tab target ID
 * @param {number} [timeoutMs] - Max wait time
 * @returns {Promise<Page>}
 */
export async function waitForPageByTargetId(port, targetId, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const page = await getPageByTargetId(port, targetId);
        if (page && !page.isClosed?.()) return page;
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`new tab page not found for targetId ${targetId}`);
}

/**
 * Get Playwright page by targetId via CDP (uses cached browser connection)
 * @param {number} port - CDP port
 * @param {string} targetId - Tab target ID
 * @returns {Promise<Page|null>}
 */
export async function getPageByTargetId(port, targetId) {
    if (!targetId) return null;
    const key = `${port}:${targetId}`;
    const existing = targetConnections.get(key);
    if (existing) return existing;
    const forget = () => {
        if (targetConnections.get(key) === connecting) targetConnections.delete(key);
    };
    const connecting = connectExactTarget(port, targetId, forget).catch(error => {
        if (targetConnections.get(key) === connecting) targetConnections.delete(key);
        throw error;
    });
    targetConnections.set(key, connecting);
    return connecting;
}

/**
 * Playwright 1.59.1's in-process transport seam is deliberately version-pinned
 * in package.json. No proxy, server, monkey patch or second Chrome is involved.
 * Replace ONLY browser-wide auto-attach with CDP's exact-target attach scope.
 * Child-frame attachment remains Playwright's job on that page's CDP session.
 * @param {number} port
 * @param {string} targetId
 * @param {() => void} forget
 * @returns {Promise<Page>}
 */
async function connectExactTarget(port, targetId, forget) {
    const { chromium } = await loadPlaywright();
    const connect = /** @type {any} */ (chromium)._connectOverCDPTransport;
    if (typeof connect !== 'function') throw new Error('Pinned Playwright target transport unavailable; reinstall agbrowse dependencies');
    const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5_000) }).then(r => r.json());
    const WebSocketImpl = globalThis.WebSocket || (await import('playwright-core/lib/utilsBundle')).ws;
    const ws = new WebSocketImpl(version.webSocketDebuggerUrl);
    let timer;
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        forget();
        ws.close();
    };
    /** @type {any} */
    const transport = {
        send(message) {
            if (!message.sessionId && message.method === 'Target.setAutoAttach' && message.params?.autoAttach) {
                message = { ...message, method: 'Target.autoAttachRelated', params: { targetId, waitForDebuggerOnStart: false } };
            }
            // Connecting an observer must not change profile-wide download policy.
            if (!message.sessionId && message.method === 'Browser.setDownloadBehavior') {
                queueMicrotask(() => transport.onmessage?.({ id: message.id, sessionId: message.sessionId, result: {} }));
                return;
            }
            ws.send(JSON.stringify(message));
        },
        close,
    };
    ws.addEventListener('message', event => {
        if (closed) return;
        try { transport.onmessage?.(JSON.parse(String(event.data))); }
        catch { close(); }
    });
    ws.addEventListener('close', () => { closed = true; forget(); transport.onclose?.(); });
    ws.addEventListener('error', close);
    try {
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => { close(); reject(new Error(`CDP target ${targetId} attachment timed out`)); }, 10_000);
        });
        const connected = (async () => {
            await new Promise((resolve, reject) => {
                ws.addEventListener('open', resolve, { once: true });
                ws.addEventListener('error', reject, { once: true });
                ws.addEventListener('close', () => reject(new Error(`CDP target ${targetId} connection closed`)), { once: true });
            });
            const browser = await connect.call(chromium, transport);
            if (closed) { await browser.close(); throw new Error(`CDP target ${targetId} connection expired`); }
            const pages = browser.contexts().flatMap(context => context.pages());
            if (pages.length !== 1) throw new Error(`CDP exact-target attach returned ${pages.length} pages for ${targetId}`);
            const page = pages[0];
            const cdp = await page.context().newCDPSession(page);
            try {
                const { targetInfo } = await cdp.send('Target.getTargetInfo');
                if (targetInfo?.targetId !== targetId) throw new Error('CDP exact-target identity mismatch');
            } finally { await cdp.detach(); }
            if (closed) throw new Error(`CDP target ${targetId} attachment expired`);
            page.once('close', close);
            markTabActive(targetId);
            return page;
        })();
        return await Promise.race([connected, timeout]);
    } catch (error) { close(); throw error; }
    finally { clearTimeout(timer); }
}

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(args, env = {}, outputFile = null) {
    return new Promise((resolveResult, reject) => {
        const fd = outputFile ? openSync(outputFile, 'w') : null;
        const child = spawn(process.execPath, args, {
            env: { ...process.env, AGBROWSE_WEB_AI_AUTO_START: '0', AGBROWSE_UPDATE_CHECK: '0', ...env },
            stdio: ['ignore', fd ?? 'pipe', 'pipe'],
        });
        if (fd !== null) closeSync(fd);
        const out = [], err = [];
        const timer = setTimeout(() => { child.kill(); reject(new Error('CLI did not exit')); }, 15_000);
        child.stdout?.pause();
        child.stderr.pause();
        setTimeout(() => { child.stdout?.resume(); child.stderr.resume(); }, 300);
        child.stdout?.on('data', chunk => out.push(chunk));
        child.stderr.on('data', chunk => err.push(chunk));
        child.on('error', reject);
        child.on('close', code => {
            clearTimeout(timer);
            resolveResult({ code, out: outputFile ? readFileSync(outputFile, 'utf8') : Buffer.concat(out).toString(), err: Buffer.concat(err).toString() });
        });
    });
}

describe('CLI pipe output is complete before exit', () => {
    it.each([0, 1])('flushes large stdout and stderr even with exit %s and a live socket-like handle', async code => {
        const helper = new URL('../../skills/browser/cli-exit.mjs', import.meta.url).href;
        const result = await run(['--input-type=module', '-e', `
            import { exitAfterFlush } from ${JSON.stringify(helper)};
            setInterval(() => {}, 1000);
            console.log(JSON.stringify({ text: '한글🌐'.repeat(250000) }));
            console.error('stderr'.repeat(250000));
            await exitAfterFlush(${code});
        `]);
        expect(result.code).toBe(code);
        expect(JSON.parse(result.out).text).toBe('한글🌐'.repeat(250000));
        expect(result.err).toBe('stderr'.repeat(250000) + '\n');
    });

    it.each(['pipe', 'file'])('returns every session and answer through a %s', async destination => {
        const home = mkdtempSync(join(tmpdir(), 'agbrowse-drain-')); dirs.push(home);
        const sessions = Array.from({ length: 30 }, (_, i) => ({
            sessionId: `drain-${i}`, vendor: 'chatgpt', status: 'complete',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            answer: `session ${i}: ` + '완료된 응답🌐'.repeat(4000), generation: 1,
        }));
        writeFileSync(join(home, 'web-ai-sessions.json'), JSON.stringify({ version: 1, sessions }));
        const result = await run([resolve('bin/agbrowse.mjs'), 'web-ai', 'sessions', 'list', '--vendor', 'chatgpt', '--limit', '30', '--json'],
            { BROWSER_AGENT_HOME: home }, destination === 'file' ? join(home, 'output.json') : null);
        expect(result.code).toBe(0);
        const parsed = JSON.parse(result.out);
        expect(parsed.sessions).toHaveLength(30);
        expect(Object.fromEntries(parsed.sessions.map(row => [row.sessionId, row.answer])))
            .toEqual(Object.fromEntries(sessions.map(row => [row.sessionId, row.answer])));
    });
});

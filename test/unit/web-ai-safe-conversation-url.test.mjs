import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeChatGptConversationUrl } from '../../web-ai/tab-recovery.mjs';

describe('isSafeChatGptConversationUrl (32.3 session guard)', () => {
    it('accepts a concrete ChatGPT conversation URL', () => {
        expect(isSafeChatGptConversationUrl('https://chatgpt.com/c/abc123-def')).toBe(true);
        expect(isSafeChatGptConversationUrl('https://chat.openai.com/c/0e0bf89b')).toBe(true);
    });

    it('accepts a conversation under a GPT prefix', () => {
        expect(isSafeChatGptConversationUrl('https://chatgpt.com/g/g-XYZ/c/abc123')).toBe(true);
    });

    it('accepts a conversation URL with a query string', () => {
        expect(isSafeChatGptConversationUrl('https://chatgpt.com/c/abc123?model=gpt-5')).toBe(true);
    });

    it('rejects the provider root (no concrete conversation)', () => {
        expect(isSafeChatGptConversationUrl('https://chatgpt.com/')).toBe(false);
        expect(isSafeChatGptConversationUrl('https://chatgpt.com')).toBe(false);
        expect(isSafeChatGptConversationUrl('https://chatgpt.com/gpts')).toBe(false);
    });

    it('rejects foreign hosts', () => {
        expect(isSafeChatGptConversationUrl('https://evil.com/c/abc')).toBe(false);
        expect(isSafeChatGptConversationUrl('https://chatgpt.com.evil.com/c/abc')).toBe(false);
        expect(isSafeChatGptConversationUrl('https://gemini.google.com/c/abc')).toBe(false);
    });

    it('rejects non-HTTPS', () => {
        expect(isSafeChatGptConversationUrl('http://chatgpt.com/c/abc')).toBe(false);
    });

    it('rejects traversal / smuggling strings', () => {
        expect(isSafeChatGptConversationUrl('https://chatgpt.com/c/../../etc')).toBe(false);
        expect(isSafeChatGptConversationUrl('https://chatgpt.com/c/a\\b')).toBe(false);
        expect(isSafeChatGptConversationUrl('https://chatgpt.com/c/a\0b')).toBe(false);
    });

    it('rejects empty / non-string input', () => {
        expect(isSafeChatGptConversationUrl('')).toBe(false);
        // @ts-expect-error intentional wrong type
        expect(isSafeChatGptConversationUrl(null)).toBe(false);
        // @ts-expect-error intentional wrong type
        expect(isSafeChatGptConversationUrl(undefined)).toBe(false);
    });
});

describe('resolveSessionPage wiring (source-string contract)', () => {
    const src = readFileSync(join(process.cwd(), 'web-ai/tab-recovery.mjs'), 'utf8');

    it('fails closed on an unsafe ChatGPT navigate target', () => {
        expect(src).toContain("session.vendor === 'chatgpt' && !isDurableConversationUrl(targetUrl)");
        expect(src).toContain("reason: 'unsafe-conversation-url'");
    });
});

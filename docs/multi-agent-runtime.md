# Shared-browser session runtime

## Model selection across releases

`--model pro` and `--model thinking --effort xhigh` specify the requested tier.
`--family` accepts an exact family label or its normalized identifier and resolves
it against the account's currently available, composer-owned Model menu. It is
not a release allowlist. Unavailable families report the observed alternatives.

`--family latest` selects the UI's Latest entry, including its localized label.
Evidence retains that actual label; Latest is never relabelled as a guessed model
version. Omitting the family preserves and, when available, rechecks the current
family. Requested settings must be verified before a prompt can be submitted.

Slider values are positions, not model identities. Selection follows the displayed
tier and effort labels; inserting or reordering stops does not change their meaning.

## Target isolation and observation

A session resolves its exact saved target, without sequentially attaching to every
page in the browser. The target transport uses CDP `Target.autoAttachRelated` for
that page and its related frames/workers. It does not change the browser's global
download policy. A stalled unrelated renderer is not part of this connection.

The in-process transport integration uses Playwright's private transport seam,
with `playwright-core` pinned to 1.59.1. There is no proxy process or separate
browser. Dependency upgrades must pass the transport integration test; a missing
seam is an explicit error, never a fallback to browser-wide attachment.

Connection discovery, target attachment and snapshot acquisition have bounded
waits. An unreadable target is not proof that it is gone. A live conversation
mismatch fails without navigation, replacement, or borrowing another tab.

Stable message IDs take precedence over presentation-only `conversation-turn-N`
indexes. Response collection ends before the next user request. An already learned
response message ID can still identify the answer after the user turn is virtualized.
Stopped/failed response markers terminate observation rather than being returned
as answers or treated as indefinite generation.

Default active-session count limits are disabled. Explicitly configured legacy
limits remain opt-in; no global agent queue or capacity controller was introduced.

## Regression coverage

`test/integration/web-ai-target-and-model-evolution.test.mjs` exercises a paused
unrelated renderer, a previously unknown family, reordered/non-unit slider values,
Latest identity, turn renumbering, and response ownership after virtualization.
The existing session-generation and conversation-binding tests cover stale writes
and live target mismatches. A provider UI that removes the required semantic
evidence must fail verification; it must not silently claim the requested tier.

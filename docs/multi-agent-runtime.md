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

## Submission and answer evidence

Chat submission records progress through `preparing` and `submitting`. `sent`
is written only after the committed user message and durable conversation are
bound to that generation. Upload paths are validated before creating a session
or filling the composer. A failure before submit is an error; a lost submit
acknowledgement is `submission-unknown`, not proof of failure or permission to
send the same prompt again.

Poll, watch and resume reject unfinished submissions with
`session.submission-unverified` instead of reporting normal generation activity.
This also rejects old orphan records marked `sent` on the provider home page.
Durable legacy conversations remain readable. An uncertain submission can be
inspected through the existing exact-session snapshot/status commands without
implicitly resending or editing the session store.

Response text comes from the identified message body, including multiple content
blocks, rather than the turn's tool log or speaker heading. Completion controls
are resolved in the same enclosing turn regardless of its HTML tag. Message IDs
take precedence over renumbered turn indexes in both acquisition and completion.
A speaker-only accessibility shell cannot displace a real answer.

Sequential initial `send` calls can be followed by parallel `poll`/`watch` calls
for different returned session IDs. No global queue or agent ownership registry
is required or added by this change.

## Regression coverage

### Background response recovery and wait budgets (v6)

For ChatGPT Chat with a committed user-message ID, poll reconciles the current
conversation branch using the logged-in browser context's request client. It
does not activate, reload, or borrow tabs. The final must follow that exact user
message, contain no later user request in between, and be an assistant `final`
message with successful terminal evidence. Private reasoning and tool messages
are not returned as answers. Wrong branches, changed targets, and superseded
generations cannot commit a recovered answer.

The server text fallback deliberately does not collect files from a stale DOM.
It reports `file-artifacts-not-probed-server-recovery`. Explicit image output and
required-file policies continue through their existing capture contracts; text
alone never satisfies them. Network requests are bounded, redirects are not
followed with authorization, and authentication values are not logged or stored.

A stored deadline is not evidence of provider failure. Exact Chat requests may
be reconciled after expiry without changing their identity or resubmitting.
Individual poll calls retain bounded execution. Query and watch continue beyond
the generation wait when observed response/structural progress justifies it.
An unchanged stop/in-progress indicator is not progress; evidence without
change for five minutes becomes unverified, not a forced provider cancellation.

`awaiting-response` with `errorCode: poll.wait-expired`, `terminal: false`, `waitExpired: true`, and
`retryHint: poll-or-resume` ends a wait whose completion/progress is unverified.
It must not be translated into “GPT has no answer.” A watcher before its stored
deadline can keep observing; after expiry it exits with `watch.awaiting-response`
unless progress is verified. `status --session` exposes `providerState` and
`responseAvailable`; `sessions show` remains a read-only persisted snapshot.
Only an actual visible rate-limit dialog is a recoverable provider block.
HTTP 429 from the optional auth/conversation GET is `server-probe-rate-limited`,
not proof of a stopped generation. Poll continues exact-turn DOM capture while
the probe honors `Retry-After` (at least 60 seconds). A separate control file,
`web-ai-server-probe-backoff.json`, shares the cooldown and an in-flight probe
reservation across processes in the same `BROWSER_AGENT_HOME`; it stores no
credentials, conversation IDs, or answer content. Session records are unchanged
by the throttle. `status --session` reports `responseAvailable: null` for an
unverified probe and exposes `serverProbeRetryAt`. Wait results may include
`serverProbe.retryAt`; callers retain the same session and must not resend.
If that exact request already has fresh verified server progress and the current
DOM still reports strong generation activity, the throttled probe does not end
the wait. The DOM observation preserves—but never refreshes—the server progress
timestamp, so a stale stop control still becomes unverified after five minutes.

Target ownership is acquired before page binding/recovery and explicit poll/resume/watch
deadline updates. Async-local lease context separates concurrent callers from
truly nested operations. A rejected duplicate cannot shorten another command's
deadline or change its session. CLI exits flush stdout and stderr before
closing the CDP-owned event loop, including large JSON and error results.

Callers keep their own send receipt (session ID, conversation, generation and
role). Director and expert IDs are separate. Global lists, titles and the
currently visible tab are never ownership evidence or substitutes for a lost ID.

New coverage: `cli-output-drain.test.mjs`, `web-ai-server-response.test.mjs`,
`web-ai-server-recovery-poll.test.mjs`, `web-ai-server-probe-rate-limit.test.mjs`,
plus shared-target and watcher tests cover
large slow pipes, stalled renderers, late completion, branch/identity rejection,
generation races, unchanged progress, strict-file policy, and write-free rejection.

### Existing browser and submission coverage

`test/integration/web-ai-submission-and-body.test.mjs` runs real Chromium DOM
operations against local fixtures: pre-submit attachment failure, preparing and
uncertain submission rejection, state at the actual send click, lost acknowledgement
without duplicate submission, and full response capture with sibling completion
controls and a later speaker-only shell.

`test/integration/web-ai-target-and-model-evolution.test.mjs` exercises a paused
unrelated renderer, a previously unknown family, reordered/non-unit slider values,
Latest identity, turn renumbering, and response ownership after virtualization.
The existing session-generation and conversation-binding tests cover stale writes
and live target mismatches. A provider UI that removes the required semantic
evidence must fail verification; it must not silently claim the requested tier.

# Three decisions

Each of these exists because the simpler version broke.

## 1. A raw tool definition instead of `defineTool`

`defineTool` lives inside the dsh installation. A bundle resolves its imports
from its own directory, and the install sits inside an archive that only the
app's runtime can open, so the first attempt failed at activation. The tool is
declared as the raw definition the registry accepts — `name`, `parameters` as
JSON Schema, `output.render`, `execute` — and argument validation moved into
`normalizeArguments()`, where it is covered by tests.

## 2. Retry only what is not a decision

`error` and `max-tokens` are retried; `refusal` and `aborted` are not. A refusal
is the model's decision and an abort is the caller's intent — retrying either
spends money against the user. Attempts are bounded by `limits.retries`, and a
retry can be cut short by the batch deadline.

One honest caveat: a retry resends the same brief, so a `max-tokens` failure can
hit the same ceiling again. It is retryable but low-yield unless the task
changes.

## 3. Permits transfer directly to waiters

The concurrency gate hands a released permit to the next waiting task instead of
decrementing a counter and letting waiters re-check. With decrement-then-
reacquire there is a window where two tasks observe the same free slot and
`maxConcurrency + 1` is admitted. A test asserts the in-use count never exceeds
capacity.

## Consequence: children use caller delivery

Workers start with `delivery: 'caller'`, so their results return to the tool
rather than arriving as separate notices in the conversation. They remain
members of the subagent tree, so `list_agents` and `send_message` still see them
while they run.
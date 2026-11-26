# dsh-swarm

A DeepSeek Harness plugin that adds one model-facing tool, `swarm`: it runs a
plan of independent worker agents in parallel and returns a single report with
per-task outcomes, retry counts, and schema-validated results.

Built for agent-infrastructure engineers who want bounded fan-out — a
concurrency ceiling, a retry budget, one deadline — instead of N separate
delegations.

## Install

Requires DeepSeek Harness with the `spawn` subagent provider (present in the Web
and Desktop presets).

1. Clone this repository to a directory you keep.
2. In DSH: **Plugins → Add plugin → local directory**, and select that folder.
3. Open a new Session. The `swarm` tool appears in the tool list.

The bundle imports nothing from the dsh installation, so upgrading DSH cannot
break its module resolution — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Usage

```json
{
  "tasks": [
    { "id": "auth", "prompt": "Audit src/auth for missing authorization checks. Report each finding with file:line and severity.", "schema": { "type": "object", "additionalProperties": false, "properties": { "findings": { "type": "array", "items": { "type": "string" } } }, "required": ["findings"] } },
    { "id": "fs", "prompt": "Audit src/fs for paths that escape the workspace. Report each finding with file:line and severity." },
    { "id": "net", "prompt": "Audit src/net for unvalidated URLs. Report each finding with file:line and severity." }
  ],
  "limits": { "maxConcurrency": 3, "retries": 1, "timeoutMs": 600000 }
}
```

Each task's `prompt` must be a complete brief: a worker does not see the
conversation that planned the swarm. A task may also carry:

- `label` — a short name for the report row; defaults to the `id`.
- `cwd` — working directory for that worker.
- `schema` — an object-rooted JSON Schema. A worker that satisfies it returns a
  validated value, which the merge exposes as JSON.
- `model` — `{ "provider", "model", "reasoningEffort"? }` to route one worker to
  another model, for example a cheaper one for a mechanical scan.

## What the report contains

1. A status line: `swarm OK in 12.4s` or `swarm PARTIAL in 40.1s`.
2. A compact summary, one line per task: `- auth [ok] 1420 chars in 1 attempt`.
3. The merged answers in task order, with structured values as JSON.

Failed tasks keep their outcome — `error`, `timeout`, or `cancelled` — with the
reason. Nothing is dropped silently; a partial run is reported as partial.

## Why not just call `subagent` N times

`subagent` is right for one or two delegations. It is the wrong shape for
thirty.

| | Separate `subagent` calls | `swarm` |
|---|---|---|
| Planning | one delegation per call, decided as you go | the whole task list in one call, validated first |
| Concurrency | the deployment's shared child capacity | a ceiling you set per run (1–8), inside that capacity |
| Failures | one notice per worker | one row per task, with the reason |
| Retries | manual: read it, start again | automatic, per-task attempt budget |
| Deadline | scattered across turns | one whole-batch deadline |
| Merge | you read N answers | a summary, ordered rows, validated values |

## What this is not

- **Not a replacement for `subagent`.** The swarm pays off only when the work
  splits into independent pieces.
- **Not a hosted service.** It runs inside the Harness process. No server, no
  queue, no dashboard.
- **Not durable.** One tool call. Stop it mid-run and you get a partial report;
  there is no resume-from-checkpoint.
- **Not a scheduler.** Nothing continues after the turn ends.

## Limits and guarantees

- **Concurrency** is a ceiling, not a target: at most `maxConcurrency` workers
  run at once, admitted in task order.
- **Retries**: a failed task gets up to `retries` extra attempts. Refusals and
  cancellations are not retried, because the same brief would fail the same way.
- **Timeout**: `timeoutMs` (default 15 minutes) cancels the whole batch. Work
  finished before the deadline still counts.
- **Cancellation**: stopping the swarm cancels pending workers and reports them
  as `cancelled`.
- **Isolation**: workers are ordinary subagents. They appear in `list_agents`
  while they run, and one failure never fails the batch.

## Tests

```bash
node --test test/*.test.js
```

19 tests, no network, no live model calls. They cover fan-out, the concurrency
ceiling and admission order, the retry budget, non-retryable outcomes, batch
timeout, caller cancellation, structured merge, plan validation, and
structured-only rendering.

**Known limits:** retry, timeout, and cancellation are covered by tests only.
No real worker failure, real deadline, or mid-run user stop has been exercised
against live subagents, and concurrency above 2 has run only in tests.

## License

MIT — see [LICENSE](LICENSE).
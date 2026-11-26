/**
 * Host-neutral swarm engine.
 *
 * The engine knows nothing about DeepSeek Harness. It takes a *plan* (a list of
 * independent tasks plus limits) and a *runner* (an async function that runs one
 * task) and produces a *report*: every task's outcome, attempts, timing, and an
 * optional merged value. The DSH adapter in `index.js` supplies a runner that
 * starts real subagents; tests supply mock runners.
 *
 * Invariants this module owns:
 *
 * - At most `limits.maxConcurrency` workers run at once; the rest wait in a
 *   stable FIFO order, so task index i is admitted before task index j > i.
 * - Each task gets at most `1 + limits.retries` attempts. A retry only happens
 *   when the task has retries left and the batch has not been cancelled.
 * - `limits.maxTasks`, `limits.timeoutMs`, and the caller's `signal` all cancel
 *   the whole batch; cancelled tasks are reported, never thrown away.
 * - A task's result is one of `ok`, `error`, `timeout`, `cancelled`. A failure
 *   in one task never rejects the batch.
 * - Every task settlement is reported through `onEvent` as soon as it happens,
 *   so a caller can show progress rather than wait for the slowest worker.
 */

/** The kinds of terminal outcome a single task can have. @typedef {'ok'|'error'|'timeout'|'cancelled'} TaskStatus */

/**
 * One task in a swarm.
 * @typedef {object} SwarmTask
 * @property {string} id - Stable, unique identifier used in the report.
 * @property {string} prompt - Complete, self-contained instructions for the worker.
 * @property {string} [label] - Short human label; defaults to the id.
 * @property {string} [cwd] - Working directory for this worker.
 * @property {Record<string, unknown>} [schema] - Object-rooted JSON Schema the worker must satisfy.
 * @property {{provider?: string, model?: string, reasoningEffort?: string}} [route] - Optional model override.
 */

/**
 * Batch-wide limits.
 * @typedef {object} SwarmLimits
 * @property {number} maxConcurrency - Simultaneously running workers, at least 1.
 * @property {number} retries - Extra attempts allowed per failed task.
 * @property {number} maxTasks - Hard cap on planned tasks.
 * @property {number} timeoutMs - Whole-batch deadline.
 */

/**
 * The outcome of one task.
 * @typedef {object} SwarmTaskReport
 * @property {string} id
 * @property {string} label
 * @property {TaskStatus} status
 * @property {number} attempts
 * @property {number} durationMs
 * @property {string} text - Final assistant text (partial when not `ok`).
 * @property {unknown} [structured] - Value satisfying the task schema, when `ok`.
 * @property {string} [diagnostic] - Why the task did not finish cleanly.
 * @property {string} [stopReason] - Raw stop reason from the runner, for diagnosis.
 */

/**
 * The merged product of one swarm run.
 * @typedef {object} SwarmReport
 * @property {boolean} ok - True only when every task is `ok`.
 * @property {string} status - `ok`, `partial`, or `failed`.
 * @property {number} durationMs
 * @property {SwarmTaskReport[]} tasks
 * @property {{total: number, ok: number, error: number, timeout: number, cancelled: number}} counts
 * @property {unknown[]} [items] - One entry per task, alongside `tasks`, for merge ergonomics.
 * @property {string} [text] - Every successful task's text, in task order.
 * @property {string} summary - One bounded line per task.
 */

/** A runner result; a runner never rejects for a model or transport failure. @typedef {object} RunnerResult */
/**
 * @property {import('../index.js').ContentBlockLike[]} [output]
 * @property {unknown} [structured]
 * @property {string} [diagnostic]
 * @property {string} [stopReason]
 */

/** @typedef {(task: SwarmTask, context: {signal: AbortSignal, attempt: number}) => Promise<RunnerResult>} SwarmRunner */

/** Default limits; callers may override any of them. */
export const DEFAULT_LIMITS = Object.freeze({
  maxConcurrency: 4,
  retries: 1,
  maxTasks: 32,
  timeoutMs: 15 * 60 * 1000,
})

/** Stop reasons the runner may produce that mean "try again", not "give up". */
const RETRYABLE_STOP_REASONS = new Set(['error', 'max-tokens', 'aborted'])

/** Thrown when the plan itself is unusable, before any worker starts. */
export class SwarmPlanError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'SwarmPlanError'
  }
}

/**
 * Validate and normalize a plan. Throws {@link SwarmPlanError} for anything the
 * engine cannot run, so the model hears about a bad plan before spending work.
 * @param {SwarmTask[]} tasks - Proposed tasks, in priority order.
 * @param {Partial<SwarmLimits>} [limits] - Overrides for {@link DEFAULT_LIMITS}.
 * @returns {{tasks: SwarmTask[], limits: SwarmLimits}}
 */
export function normalizePlan(tasks, limits = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new SwarmPlanError('a swarm needs at least one task')
  }
  const merged = { ...DEFAULT_LIMITS, ...pruneUndefined(limits) }
  for (const key of ['maxConcurrency', 'maxTasks', 'retries', 'timeoutMs']) {
    const value = merged[key]
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SwarmPlanError(`limits.${key} must be a non-negative safe integer`)
    }
  }
  if (merged.maxConcurrency < 1) throw new SwarmPlanError('limits.maxConcurrency must be at least 1')
  if (merged.maxTasks < 1) throw new SwarmPlanError('limits.maxTasks must be at least 1')
  if (merged.timeoutMs < 1) throw new SwarmPlanError('limits.timeoutMs must be at least 1')
  if (tasks.length > merged.maxTasks) {
    throw new SwarmPlanError(`planned ${tasks.length} tasks, above limits.maxTasks (${merged.maxTasks}); merge tasks or raise the limit`)
  }

  const seen = new Set()
  const normalized = tasks.map((task, index) => {
    if (typeof task !== 'object' || task === null) throw new SwarmPlanError(`task ${index} is not an object`)
    if (typeof task.id !== 'string' || task.id.trim() === '') {
      throw new SwarmPlanError(`task ${index} needs a non-empty string id`)
    }
    const id = task.id.trim()
    if (seen.has(id)) throw new SwarmPlanError(`duplicate task id "${id}"; ids must be unique because the report and merge are keyed by id`)
    seen.add(id)
    if (typeof task.prompt !== 'string' || task.prompt.trim() === '') {
      throw new SwarmPlanError(`task "${id}" needs a non-empty prompt`)
    }
    if (task.schema !== undefined && !isObjectSchema(task.schema)) {
      throw new SwarmPlanError(`task "${id}" schema must be an object-rooted JSON Schema`)
    }
    if (task.route !== undefined && (typeof task.route !== 'object' || task.route === null)) {
      throw new SwarmPlanError(`task "${id}" route must be an object`)
    }
    return {
      ...task,
      id,
      label: typeof task.label === 'string' && task.label.trim() !== '' ? task.label.trim() : id,
      prompt: task.prompt,
    }
  })
  return { tasks: normalized, limits: merged }
}

/**
 * Promise-based counter gate: the first `n` claims resolve immediately, later
 * claims wait until a running worker releases. Claims are served in FIFO order.
 * @param {number} permits - Initial capacity; must be at least 1.
 * @returns {{acquire: () => Promise<void>, release: () => void, snapshot: () => number}}
 */
export function createGate(permits) {
  let used = 0
  /** @type {Array<() => void>} */
  const waiting = []
  return {
    async acquire() {
      if (used < permits) {
        used += 1
        return
      }
      await new Promise((resolve) => waiting.push(() => {
        used += 1
        resolve(undefined)
      }))
    },
    release() {
      const next = waiting.shift()
      if (next !== undefined) {
        next()
        return
      }
      used = Math.max(0, used - 1)
    },
    snapshot: () => used,
  }
}

/**
 * Run a plan to completion.
 *
 * @param {object} options
 * @param {SwarmTask[]} options.tasks - Proposed tasks.
 * @param {Partial<SwarmLimits>} [options.limits] - Limit overrides.
 * @param {SwarmRunner} options.run SwarmRunner - Runs exactly one attempt of one task.
 * @param {AbortSignal} [options.signal] - Caller cancellation for the whole batch.
 * @param {(event: {type: 'task-start'|'task-retry'|'task-end', task: SwarmTask, attempt: number, report?: SwarmTaskReport}) => void} [options.onEvent] - Progress hook; never awaited, never able to fail the batch.
 * @returns {Promise<SwarmReport>}
 */
export async function runSwarm({ tasks, limits, run, signal, onEvent = () => {} }) {
  const plan = normalizePlan(tasks, limits)
  const { maxConcurrency, retries, timeoutMs } = plan.limits
  const startedAt = Date.now()

  const controller = new AbortController()
  /** @type {string | undefined} Why the batch stopped early, when it did. */
  let stopCause
  const stop = (cause) => {
    if (controller.signal.aborted) return
    stopCause = cause
    controller.abort(cause)
  }
  const timer = setTimeout(() => stop(`swarm timeout after ${timeoutMs} ms`), timeoutMs)
  const onCallerAbort = () => stop(abortReason(signal))
  if (signal !== undefined) {
    if (signal.aborted) onCallerAbort()
    else signal.addEventListener('abort', onCallerAbort, { once: true })
  }

  const gate = createGate(maxConcurrency)
  const emit = (typeof onEvent === 'function') ? onEvent : () => {}

  try {
    const reports = await Promise.all(plan.tasks.map((task, index) => runOne(task, index)))
    const counts = { total: reports.length, ok: 0, error: 0, timeout: 0, cancelled: 0 }
    for (const report of reports) counts[report.status] += 1
    const ok = counts.ok === reports.length
    const status = ok ? 'ok' : (counts.ok > 0 ? 'partial' : 'failed')
    return {
      ok,
      status,
      durationMs: Date.now() - startedAt,
      tasks: reports,
      counts,
      items: reports.map((report) => (report.status === 'ok' && report.structured !== undefined ? report.structured : { id: report.id, status: report.status, text: report.text })),
      text: reports.filter((report) => report.status === 'ok').map(renderTaskText).join('\n\n'),
      summary: summarize(reports, stopCause),
    }

    /**
     * Run one task through its allocation of attempts.
     * @param {SwarmTask} task
     * @param {number} index
     * @returns {Promise<SwarmTaskReport>}
     */
    async function runOne(task, index) {
      const taskStartedAt = Date.now()
      const maxAttempts = 1 + retries
      let attempts = 0
      /** @type {SwarmTaskReport} */
      let report = {
        id: task.id,
        label: task.label ?? task.id,
        status: 'cancelled',
        attempts: 0,
        durationMs: 0,
        text: '',
        diagnostic: 'the batch was cancelled before this task started',
      }

      if (controller.signal.aborted) {
        report = { ...report, diagnostic: `not started: ${stopCause ?? 'batch cancelled'}` }
        emit({ type: 'task-end', task, attempt: 0, report })
        return report
      }

      await gate.acquire()
      try {
        while (attempts < maxAttempts) {
          if (controller.signal.aborted) {
            report = {
              ...report,
              status: 'cancelled',
              diagnostic: attempts === 0 ? `not started: ${stopCause ?? 'batch cancelled'}` : `cancelled after attempt ${attempts}: ${stopCause ?? 'batch cancelled'}`,
            }
            break
          }
          attempts += 1
          emit({ type: 'task-start', task, attempt: attempts })
          // Each attempt owns its own controller so one attempt's abort never
          // leaks into the next, while the batch signal still reaches the runner.
          const attemptController = new AbortController()
          const forwardAbort = () => attemptController.abort(controller.signal.reason)
          if (controller.signal.aborted) forwardAbort()
          else controller.signal.addEventListener('abort', forwardAbort, { once: true })

          let outcome
          try {
            const value = await run(task, { signal: attemptController.signal, attempt: attempts })
            outcome = classify(value)
          } catch (error) {
            // A throwing runner is an infrastructure fault, not a modelled
            // failure; it still only costs this task its attempt.
            outcome = {
              status: controller.signal.aborted ? 'cancelled' : 'error',
              diagnostic: `runner threw: ${describeError(error)}`,
              stopReason: 'error',
              output: [],
            }
          } finally {
            controller.signal.removeEventListener('abort', forwardAbort)
          }

          if (controller.signal.aborted && outcome.status === 'ok') {
            // Work that finished during cancellation still counts: it is real.
            outcome = { ...outcome, status: 'ok' }
          }

          report = {
            id: task.id,
            label: task.label ?? task.id,
            status: outcome.status,
            attempts,
            durationMs: Date.now() - taskStartedAt,
            text: textOf(outcome.output),
            ...outcome.structured === undefined ? {} : { structured: outcome.structured },
            ...outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic },
            ...outcome.stopReason === undefined ? {} : { stopReason: outcome.stopReason },
          }

          const retryable = outcome.status !== 'ok' && outcome.status !== 'timeout' && controller.signal.aborted === false && attempts < maxAttempts && isRetryable(outcome)
          if (!retryable) break
          emit({ type: 'task-retry', task, attempt: attempts + 1, report })
        }
      } finally {
        report = { ...report, durationMs: Date.now() - taskStartedAt }
        gate.release()
      }
      emit({ type: 'task-end', task, attempt: attempts, report })
      return report
    }
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', onCallerAbort)
  }
}

/**
 * Decide whether a failed outcome is worth another attempt. Cancelled work is
 * not retried (the batch is shutting down); a refusal or a policy error is not
 * retried either (the same prompt would fail the same way).
 * @param {{status: TaskStatus, stopReason?: string}} outcome
 * @returns {boolean}
 */
export function isRetryable(outcome) {
  if (outcome.status === 'cancelled' || outcome.status === 'timeout') return false
  if (outcome.stopReason === 'refusal') return false
  return outcome.stopReason === undefined || RETRYABLE_STOP_REASONS.has(outcome.stopReason)
}

/**
 * Map one runner result onto a task status.
 * @param {RunnerResult} value
 * @returns {{status: TaskStatus, output: import('../index.js').ContentBlockLike[], structured?: unknown, diagnostic?: string, stopReason?: string}}
 */
function classify(value) {
  const result = (typeof value === 'object' && value !== null) ? value : {}
  const output = Array.isArray(result.output) ? result.output : []
  const stopReason = typeof result.stopReason === 'string' ? result.stopReason : undefined
  if (stopReason === undefined || stopReason === 'completed') {
    return {
      status: 'ok',
      output,
      ...result.structured === undefined ? {} : { structured: result.structured },
      ...typeof result.diagnostic === 'string' && result.diagnostic !== '' ? { diagnostic: result.diagnostic } : {},
      ...stopReason === undefined ? {} : { stopReason },
    }
  }
  return {
    status: stopReason === 'aborted' ? 'cancelled' : 'error',
    output,
    ...typeof result.diagnostic === 'string' && result.diagnostic !== '' ? { diagnostic: result.diagnostic } : { diagnostic: `worker stopped with reason "${stopReason}"` },
    stopReason,
  }
}

/**
 * Flatten content blocks to plain text; non-text blocks are dropped.
 * @param {unknown} blocks
 * @returns {string}
 */
export function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  /** @type {string[]} */
  const parts = []
  for (const block of blocks) {
    if (typeof block === 'string') parts.push(block)
    else if (typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('').trim()
}

/**
 * Render one successful task. A structured-only answer has no prose, so it must
 * not leave a blank line above its JSON block.
 * @param {SwarmTaskReport} report
 * @returns {string}
 */
function renderTaskText(report) {
  const heading = `### ${report.label}`
  if (report.structured === undefined) return `${heading}\n${report.text}`
  const json = `\`\`\`json\n${JSON.stringify(report.structured, null, 2)}\n\`\`\``
  return report.text === '' ? `${heading}\n${json}` : `${heading}\n${report.text}\n\n${json}`
}

/**
 * Build the compact one-line-per-task summary the model reads first.
 * @param {SwarmTaskReport[]} reports
 * @param {string | undefined} stopCause
 * @returns {string}
 */
export function summarize(reports, stopCause) {
  const counts = { ok: 0, error: 0, timeout: 0, cancelled: 0 }
  for (const report of reports) counts[report.status] += 1
  const head = `${counts.ok}/${reports.length} tasks ok` +
    (counts.error > 0 ? `, ${counts.error} failed` : '') +
    (counts.timeout > 0 ? `, ${counts.timeout} timed out` : '') +
    (counts.cancelled > 0 ? `, ${counts.cancelled} cancelled` : '') +
    (stopCause === undefined ? '' : ` (${stopCause})`)
  const lines = reports.map((report) => {
    const detail = report.status === 'ok'
      ? `${report.structured === undefined ? `${report.text.length} chars` : 'structured result'} in ${report.attempts} attempt${report.attempts === 1 ? '' : 's'}`
      : bounded(report.diagnostic ?? report.status, 240)
    return `- ${report.id} [${report.status}] ${detail}`
  })
  return [head, ...lines].join('\n')
}

/**
 * Whether a value is an object-rooted JSON Schema the subagent seam accepts.
 * @param {unknown} schema
 * @returns {boolean}
 */
export function isObjectSchema(schema) {
  return typeof schema === 'object' && schema !== null && !Array.isArray(schema) && schema.type === 'object'
}

/**
 * @param {string} text
 * @param {number} limit
 */
function bounded(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/**
 * @param {AbortSignal | undefined} signal
 * @returns {string}
 */
function abortReason(signal) {
  const reason = signal?.reason
  if (typeof reason === 'string' && reason !== '') return reason
  if (reason instanceof Error && reason.message !== '') return reason.message
  return 'the caller cancelled the swarm'
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error instanceof Error) return error.message || error.name
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * @template T
 * @param {Record<string, T | undefined>} object
 * @returns {Record<string, T>}
 */
function pruneUndefined(object) {
  /** @type {Record<string, T>} */
  const out = {}
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = /** @type {T} */ (value)
  return out
}

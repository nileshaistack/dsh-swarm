/**
 * Host half of the swarm bundle.
 *
 * The bundle adds one model-facing tool, `swarm`, over the existing subagent
 * seam. That seam already knows how to start a child agent, cancel it, and
 * collect its structured result; nothing here replaces it. What the swarm adds
 * is everything *around* a fan-out that a pile of parallel `subagent` calls do
 * not give you:
 *
 * 1. **Plan first.** The coordinator submits the complete task list in one
 *    call, so the plan is visible, capped, and validated before any tokens are
 *    spent on workers instead of dribbling out one delegation at a time.
 * 2. **Bounded fan-out.** A concurrency ceiling, a retry budget, and a
 *    whole-batch deadline live in one place instead of in every caller's head.
 * 3. **One report.** Tasks come back as structured rows plus a compact summary,
 *    so the coordinator reads the state of the swarm in one turn instead of
 *    waiting for N completion notices.
 *
 * Children are started with `delivery: 'caller'`: their results come back to
 * this tool, not as separate notices in the conversation. They are still
 * ordinary members of the subagent tree, so `list_agents` and `send_message`
 * see them while they run.
 *
 * The tool is declared as a raw definition rather than through `defineTool`, so
 * the bundle imports nothing from the dsh installation: a bundle row resolves
 * its own module path, and a package it cannot resolve must not be a load-time
 * failure for the whole row. Argument validation therefore lives in
 * `normalizeArguments`, which rejects anything the engine cannot run before a
 * single worker starts.
 *
 * The engine itself is host-neutral (`engine/swarm.js`) and unit tested with
 * mock runners; this file only adapts it to DeepSeek Harness services.
 */

import { runSwarm } from './engine/swarm.js'

/** Registered plugin name; also the name its log lines carry. */
export const name = 'swarm'

/** Services this plugin needs before it can mount. */
export const inject = ['tools', 'subagents']

/** Ceiling for simultaneous workers. */
const MAX_CONCURRENCY = 8

/** Default concurrency when the caller sends no limit. */
const DEFAULT_MAX_CONCURRENCY = 4

/** Ceiling for planned tasks in one swarm. */
const MAX_TASKS = 32

/** Smallest accepted whole-batch deadline. */
const MIN_TIMEOUT_MS = 1000

/** The model-facing tool name; also the name this row registers. */
const TOOL_NAME = 'swarm'

/**
 * Register the swarm tool for the lifetime of this plugin row.
 * @param {HostContext} ctx - Context that owns the registration.
 * @param {Record<string, unknown>} [config] - Row configuration; this bundle defines none.
 * @returns {void}
 */
export function apply(ctx, config) {
  void config
  ctx.tools.register({
    name: TOOL_NAME,
    description: [
      'Run a swarm: fan one plan out across many independent worker agents in parallel, then merge their results into one report.',
      'Workers are real subagents with their own context and tools; each returns its final answer and, when it has a schema, a validated structured value.',
      'Use it for work that splits into independent pieces — an audit over many files, multi-angle research, adversarial verification, parallel implementation. For one or two delegations, call subagent instead.',
      'Write every task prompt as a complete, self-contained brief: a worker does not see this conversation.',
      'A failed worker is retried up to limits.retries times; refusals and cancellations are not retried.',
      'Give each task a distinct id; ids key the report and the merge. Prefer a schema for anything you will merge or count, because it turns prose into a value that can be aggregated safely.',
    ].join(' '),
    parameters: PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs, exec) {
      if (exec.agent === undefined) throw new Error('the swarm tool requires a calling agent')
      const { tasks, limits } = normalizeArguments(rawArgs)
      const runner = createActivationRunner(ctx, exec.agent)
      const report = await runSwarm({ tasks, limits, run: runner, signal: exec.signal })
      ctx.logger.info(`swarm: ${report.summary.split('\n')[0]}`)
      return renderReport(report)
    },
  })
}

/**
 * The model-facing parameter schema. Raw JSON Schema in the enforced subset:
 * every object node states `additionalProperties`, and required properties are
 * named in a `required` array rather than inline.
 * @type {Record<string, unknown>}
 */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      description: `Independent tasks to run in parallel, in priority order (at most ${MAX_TASKS}). Each task is an object with id (unique short string), prompt (a complete brief), and optional label, cwd, schema, and model. A task schema is an object-rooted JSON Schema (type "object") using only type, properties, required, additionalProperties, items, enum, const, and oneOf.`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'prompt'],
        properties: {
          id: {
            type: 'string',
            description: 'Unique short identifier for this task; it keys the report and the merge.',
          },
          prompt: {
            type: 'string',
            description: 'Complete, self-contained brief for the worker, which does not see this conversation.',
          },
          label: {
            type: 'string',
            description: 'Short human label for this task in the report; defaults to its id.',
          },
          cwd: {
            type: 'string',
            description: 'Working directory for this worker; a relative path resolves against the current directory.',
          },
          schema: {
            type: 'object',
            additionalProperties: true,
            description: 'Object-rooted JSON Schema (type "object") the worker must satisfy; its validated value joins the merge as JSON.',
          },
          model: {
            type: 'object',
            additionalProperties: false,
            required: ['provider', 'model'],
            description: 'Optional model route for this worker; omitted workers inherit the parent route.',
            properties: {
              provider: { type: 'string', description: 'LLM provider id.' },
              model: { type: 'string', description: 'Model id within that provider.' },
              reasoningEffort: { type: 'string', description: 'Reasoning effort id for that model.' },
            },
          },
        },
      },
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      description: 'Optional batch limits; omitted fields use defaults.',
      properties: {
        maxConcurrency: {
          type: 'integer',
          description: `Workers running at the same time, 1-${MAX_CONCURRENCY}; default ${DEFAULT_MAX_CONCURRENCY}.`,
        },
        retries: { type: 'integer', description: 'Extra attempts allowed per failed task; default 1.' },
        maxTasks: { type: 'integer', description: `Hard cap on planned tasks, 1-${MAX_TASKS}.` },
        timeoutMs: {
          type: 'integer',
          description: `Whole-batch deadline in milliseconds, at least ${MIN_TIMEOUT_MS}; default 15 minutes.`,
        },
      },
    },
  },
}

/**
 * Adapt one task to a managed subagent activation and settle its result.
 * @param {HostContext} ctx - Context owning the subagent runtime.
 * @param {AgentLike} parent - Calling agent; the workers are its children.
 * @returns {import('./engine/swarm.js').SwarmRunner}
 */
function createActivationRunner(ctx, parent) {
  return async (task, { signal }) => {
    const agentOptions = routeOf(task.route)
    const activation = await ctx.subagents.startActivation({
      provider: 'spawn',
      label: task.label,
      delivery: 'caller',
      prompt: [{ type: 'text', text: task.prompt }],
      parent,
      signal,
      ...task.cwd === undefined ? {} : { cwd: task.cwd },
      ...agentOptions === undefined ? {} : { agentOptions },
      ...task.schema === undefined ? {} : { outputSchema: task.schema },
    })
    try {
      const result = await activation.result
      return {
        output: Array.isArray(result?.output) ? result.output : [],
        ...result?.structured === undefined ? {} : { structured: result.structured },
        ...typeof result?.diagnostic === 'string' ? { diagnostic: result.diagnostic } : {},
        ...typeof result?.stopReason === 'string' ? { stopReason: result.stopReason } : {},
      }
    } finally {
      // Release the activation as soon as its result is captured; a teardown
      // failure must not replace an outcome the report already holds.
      await activation.dispose().catch(() => {})
    }
  }
}

/**
 * Reject arguments the engine cannot run, before any worker starts.
 * @param {unknown} raw - Model-supplied arguments.
 * @returns {{tasks: import('./engine/swarm.js').SwarmTask[], limits: Record<string, number>}}
 */
function normalizeArguments(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('swarm: arguments must be an object')
  }
  const args = /** @type {Record<string, unknown>} */ (raw)
  if (!Array.isArray(args.tasks)) throw new Error('swarm: `tasks` must be an array')
  if (args.tasks.length > MAX_TASKS) {
    throw new Error(`swarm: ${args.tasks.length} tasks exceed the ${MAX_TASKS}-task ceiling; merge related tasks`)
  }
  const rawLimits = args.limits
  if (rawLimits !== undefined && (typeof rawLimits !== 'object' || rawLimits === null || Array.isArray(rawLimits))) {
    throw new Error('swarm: `limits` must be an object')
  }
  return {
    tasks: args.tasks.map(normalizeTask),
    limits: normalizeLimits(/** @type {Record<string, unknown>} */ (rawLimits ?? {})),
  }
}

/**
 * @param {unknown} raw - One model-supplied task.
 * @returns {import('./engine/swarm.js').SwarmTask}
 */
function normalizeTask(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('swarm: every task must be an object')
  }
  const task = /** @type {Record<string, unknown>} */ (raw)
  const route = task.model
  if (route !== undefined && (typeof route !== 'object' || route === null || Array.isArray(route))) {
    throw new Error('swarm: a task `model` must be an object with provider, model, and optional reasoningEffort')
  }
  return {
    id: /** @type {string} */ (task.id),
    prompt: /** @type {string} */ (task.prompt),
    label: typeof task.label === 'string' ? task.label : undefined,
    cwd: typeof task.cwd === 'string' ? task.cwd : undefined,
    schema: task.schema,
    route: route === undefined ? undefined : /** @type {Record<string, string>} */ (route),
  }
}

/**
 * Validate and clamp batch limits.
 * @param {Record<string, unknown>} raw - Model-supplied limits.
 * @returns {Record<string, number>}
 */
function normalizeLimits(raw) {
  /** @type {Record<string, number>} */
  const limits = { maxConcurrency: DEFAULT_MAX_CONCURRENCY }
  if (raw.maxConcurrency !== undefined) {
    const value = raw.maxConcurrency
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
      throw new Error(`swarm: limits.maxConcurrency must be an integer from 1 to ${MAX_CONCURRENCY}`)
    }
    limits.maxConcurrency = /** @type {number} */ (value)
  }
  if (raw.retries !== undefined) {
    const value = raw.retries
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('swarm: limits.retries must be a non-negative integer')
    limits.retries = /** @type {number} */ (value)
  }
  if (raw.maxTasks !== undefined) {
    const value = raw.maxTasks
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TASKS) {
      throw new Error(`swarm: limits.maxTasks must be an integer from 1 to ${MAX_TASKS}`)
    }
    limits.maxTasks = /** @type {number} */ (value)
  }
  if (raw.timeoutMs !== undefined) {
    const value = raw.timeoutMs
    if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS) {
      throw new Error(`swarm: limits.timeoutMs must be an integer of at least ${MIN_TIMEOUT_MS}`)
    }
    limits.timeoutMs = /** @type {number} */ (value)
  }
  return limits
}

/**
 * Turn a task's model hint into the agent options the subagent seam accepts.
 * A route missing a provider or model is dropped rather than half-applied.
 * @param {Record<string, string> | undefined} route - Task route hint.
 * @returns {Record<string, unknown> | undefined}
 */
function routeOf(route) {
  if (route === undefined) return undefined
  const { provider, model, reasoningEffort } = route
  if (typeof provider !== 'string' || typeof model !== 'string' || provider === '' || model === '') return undefined
  return {
    provider,
    model,
    ...typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {},
  }
}

/**
 * Render the report the coordinator reads. The status and summary come first so
 * a partial run is legible without scrolling, then the merged text.
 * @param {import('./engine/swarm.js').SwarmReport} report - Settled swarm report.
 * @returns {string}
 */
function renderReport(report) {
  const parts = [`swarm ${report.status.toUpperCase()} in ${(report.durationMs / 1000).toFixed(1)}s`, report.summary]
  if (report.text !== '') parts.push('', report.text)
  const failures = report.tasks.filter((task) => task.status !== 'ok' && task.diagnostic !== undefined)
  if (failures.length > 0) {
    parts.push('', 'Failures:')
    for (const task of failures) parts.push(`- ${task.id}: ${task.diagnostic}`)
  }
  return parts.join('\n')
}

/**
 * @typedef {object} HostContext
 * @property {{register: (definition: object) => () => void}} tools - Scoped tool registry.
 * @property {{startActivation: (spec: object) => Promise<{result: Promise<object>, dispose: () => Promise<void>}>}} subagents - Managed subagent runtime.
 * @property {{info: (message: string) => void, warn: (message: string) => void}} logger - Plugin logger.
 */

/**
 * @typedef {object} AgentLike
 * @property {unknown} id - Session id of the calling agent.
 */


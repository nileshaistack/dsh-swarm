/**
 * Adapter tests: the Host plugin wired to a fake Context whose subagent
 * runtime returns scripted activations. These exercise the real `defineTool`
 * from the installed dsh, so the tool's schema and execution contract are
 * checked against the runtime that will run it.
 *
 * Run with: node --test dsh-swarm/test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/**
 * Build a fake Context whose activations answer from a script.
 * @param {(request: Record<string, unknown>) => {stopReason?: string, output?: unknown[], structured?: unknown, diagnostic?: string}} handler
 */
function fakeContext(handler) {
  /** @type {object[]} */
  const activations = []
  /** @type {object[]} */
  const registered = []
  /** @type {string[]} */
  const logs = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    subagents: {
      async startActivation(request) {
        const activation = {
          name: `child-${activations.length + 1}`,
          request,
          disposed: false,
          result: (async () => {
            // Give each activation a tick so overlap is observable.
            await new Promise((resolve) => setTimeout(resolve, 2))
            return handler(request)
          })(),
          async dispose() {
            activation.disposed = true
          },
        }
        activations.push(activation)
        return activation
      },
    },
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
  }
  return { ctx, activations, registered, logs }
}

/** The single registered tool, after apply resolves. */
async function toolOf(ctx) {
  /** @type {object[]} */
  const registered = []
  const original = ctx.tools.register
  ctx.tools.register = (definition) => {
    registered.push(definition)
    return original(definition)
  }
  await apply(ctx)
  assert.equal(registered.length, 1)
  return registered[0]
}

test('registers one swarm tool with a model-facing parameter schema', async () => {
  const { ctx } = fakeContext(() => ({ output: [], stopReason: 'completed' }))
  const tool = await toolOf(ctx)
  assert.equal(tool.name, 'swarm')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['tasks'])
  assert.equal(tool.parameters.additionalProperties, false)
  const tasks = tool.parameters.properties.tasks
  assert.equal(tasks.type, 'array')
  assert.deepEqual(tasks.items.required, ['id', 'prompt'])
  assert.equal(tasks.items.additionalProperties, false)
  assert.equal(tasks.items.properties.schema.type, 'object')
  assert.equal(tool.parameters.properties.limits.properties.maxConcurrency.type, 'integer')
  assert.equal(typeof tool.output.render, 'function')
  assert.match(tool.description, /swarm/)
})

test('runs tasks through caller-delivery activations and disposes each', async () => {
  const { ctx, activations } = fakeContext((request) => ({
    output: [{ type: 'text', text: `answer for ${request.label}` }],
    stopReason: 'completed',
  }))
  const tool = await toolOf(ctx)
  const text = await tool.execute({
    tasks: [{ id: 'a', prompt: 'first' }, { id: 'b', prompt: 'second' }],
    limits: { maxConcurrency: 2, retries: 0 },
  }, { agent: { id: 'parent' }, signal: new AbortController().signal })

  assert.equal(activations.length, 2)
  for (const activation of activations) {
    assert.equal(activation.request.delivery, 'caller')
    assert.equal(activation.request.provider, 'spawn')
    assert.equal(activation.disposed, true)
  }
  assert.deepEqual(
    activations.map((activation) => activation.request.prompt[0].text),
    ['first', 'second'],
  )
  assert.match(text, /swarm OK/)
  assert.match(text, /2\/2 tasks ok/)
  assert.match(text, /answer for a/)
})

test('passes schema, route, and cwd through, and reports structured values', async () => {
  const { ctx, activations } = fakeContext((request) => ({
    output: [{ type: 'text', text: '{"n":1}' }],
    structured: { n: 1 },
    stopReason: 'completed',
  }))
  const tool = await toolOf(ctx)
  const text = await tool.execute({
    tasks: [{
      id: 'count',
      prompt: 'count',
      schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      model: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
      cwd: '/tmp',
    }],
    limits: { retries: 0 },
  }, { agent: { id: 'parent' }, signal: new AbortController().signal })

  const request = activations[0].request
  assert.deepEqual(request.outputSchema, { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] })
  assert.deepEqual(request.agentOptions, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' })
  assert.equal(request.cwd, '/tmp')
  assert.match(text, /```json/)
})

test('a failed activation fails only its task and is retried when allowed', async () => {
  const attempts = new Map()
  const { ctx } = fakeContext((request) => {
    const count = (attempts.get(request.label) ?? 0) + 1
    attempts.set(request.label, count)
    if (request.label === 'flaky' && count === 1) return { output: [], stopReason: 'error', diagnostic: 'boom' }
    return { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }
  })
  const tool = await toolOf(ctx)
  const text = await tool.execute({
    tasks: [{ id: 'flaky', prompt: 'p' }, { id: 'solid', prompt: 'p' }],
    limits: { retries: 1, maxConcurrency: 2 },
  }, { agent: { id: 'parent' }, signal: new AbortController().signal })
  assert.equal(attempts.get('flaky'), 2)
  assert.match(text, /swarm OK/)
})

test('rejects unusable arguments before starting any worker', async () => {
  const { ctx, activations } = fakeContext(() => ({ output: [], stopReason: 'completed' }))
  const tool = await toolOf(ctx)
  const exec = { agent: { id: 'parent' }, signal: new AbortController().signal }
  const cases = [
    [{ tasks: 'nope' }, /`tasks` must be an array/],
    [{ tasks: [] }, /at least one task/],
    [{ tasks: [{ id: 'a', prompt: 'p' }, { id: 'a', prompt: 'q' }] }, /duplicate task id/],
    [{ tasks: [{ id: 'a', prompt: 'p' }], limits: { maxConcurrency: 99 } }, /maxConcurrency/],
    [{ tasks: [{ id: 'a', prompt: 'p' }], limits: { timeoutMs: 5 } }, /timeoutMs/],
    [{ tasks: Array.from({ length: 33 }, (_, index) => ({ id: `t${index}`, prompt: 'p' })) }, /exceed the 32-task ceiling/],
    [{ tasks: [{ id: 'a', prompt: 'p', model: 'x' }] }, /`model` must be an object/],
  ]
  for (const [args, pattern] of cases) {
    await assert.rejects(tool.execute(args, exec), pattern)
  }
  assert.equal(activations.length, 0)
})

test('caller cancellation reports cancelled tasks instead of throwing', async () => {
  const { ctx } = fakeContext(() => ({ output: [], stopReason: 'completed' }))
  const tool = await toolOf(ctx)
  const controller = new AbortController()
  controller.abort('user pressed stop')
  const text = await tool.execute({
    tasks: [{ id: 'a', prompt: 'p' }],
    limits: { retries: 0 },
  }, { agent: { id: 'parent' }, signal: controller.signal })
  assert.match(text, /swarm FAILED/)
  assert.match(text, /1 cancelled/)
})

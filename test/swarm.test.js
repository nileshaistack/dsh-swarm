/**
 * Tests for the host-neutral swarm engine.
 *
 * Run with: node --test dsh-swarm/test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LIMITS,
  SwarmPlanError,
  createGate,
  isObjectSchema,
  normalizePlan,
  runSwarm,
  textOf,
} from '../engine/swarm.js'

/** A runner that resolves immediately with the given stop reason and text. */
function fixedRunner(stopReason = 'completed', text = 'done') {
  /** @type {string[]} */
  const seen = []
  return {
    seen,
    run: async (task) => {
      seen.push(task.id)
      return { output: [{ type: 'text', text: `${task.id}:${text}` }], stopReason }
    },
  }
}

/** A runner that never settles until its signal aborts. */
function hangingRunner() {
  return {
    run: (task, { signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ output: [], stopReason: 'aborted', diagnostic: 'aborted' }), { once: true })
      void task
    }),
  }
}

test('runs every task and reports each one', async () => {
  const runner = fixedRunner()
  const report = await runSwarm({
    tasks: [{ id: 'a', prompt: 'do a' }, { id: 'b', prompt: 'do b' }],
    run: runner.run,
    limits: { maxConcurrency: 1, retries: 0 },
  })
  assert.equal(report.ok, true)
  assert.equal(report.status, 'ok')
  assert.equal(report.counts.ok, 2)
  assert.equal(report.tasks[0].text, 'a:done')
  assert.equal(report.tasks[1].text, 'b:done')
  assert.deepEqual(runner.seen, ['a', 'b'])
  assert.match(report.summary, /2\/2 tasks ok/)
})

test('respects maxConcurrency and keeps admission order', async () => {
  let active = 0
  let peak = 0
  const order = []
  const report = await runSwarm({
    tasks: Array.from({ length: 7 }, (_, index) => ({ id: `t${index}`, prompt: 'p' })),
    limits: { maxConcurrency: 3, retries: 0 },
    run: async (task) => {
      order.push(task.id)
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }
    },
  })
  assert.equal(report.ok, true)
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded 3`)
  assert.deepEqual(order, ['t0', 't1', 't2', 't3', 't4', 't5', 't6'])
})

test('retries a failed task when retries are configured', async () => {
  let attempts = 0
  const report = await runSwarm({
    tasks: [{ id: 'flaky', prompt: 'p' }],
    limits: { retries: 1 },
    run: async () => {
      attempts += 1
      return attempts === 1
        ? { output: [], stopReason: 'error', diagnostic: 'transient' }
        : { output: [{ type: 'text', text: 'second time' }], stopReason: 'completed' }
    },
  })
  assert.equal(report.ok, true)
  assert.equal(report.tasks[0].attempts, 2)
  assert.equal(report.tasks[0].text, 'second time')
})

test('a refusal or cancellation is not retried', async () => {
  const attempts = []
  const events = []
  const report = await runSwarm({
    tasks: [{ id: 'x', prompt: 'p' }, { id: 'y', prompt: 'p' }],
    limits: { retries: 3 },
    run: async (task) => {
      attempts.push(task.id)
      return { output: [], stopReason: task.id === 'x' ? 'refusal' : 'aborted' }
    },
    onEvent: (event) => events.push(event.type),
  })
  assert.equal(report.ok, false)
  assert.equal(report.status, 'failed')
  assert.equal(report.tasks[0].attempts, 1)
  assert.equal(report.tasks[1].attempts, 1)
  assert.equal(attempts.length, 2)
  assert.equal(events.filter((type) => type === 'task-retry').length, 0)
})

test('a throwing runner costs only its own task', async () => {
  const report = await runSwarm({
    tasks: [{ id: 'boom', prompt: 'p' }, { id: 'fine', prompt: 'p' }],
    limits: { retries: 0 },
    run: async (task) => {
      if (task.id === 'boom') throw new Error('registry unavailable')
      return { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }
    },
  })
  assert.equal(report.status, 'partial')
  assert.equal(report.tasks[0].status, 'error')
  assert.match(report.tasks[0].diagnostic, /registry unavailable/)
  assert.equal(report.tasks[1].status, 'ok')
})

test('the batch timeout cancels pending tasks and reports them', async () => {
  const report = await runSwarm({
    tasks: [{ id: 'slow', prompt: 'p' }, { id: 'waiting', prompt: 'p' }],
    limits: { maxConcurrency: 1, retries: 0, timeoutMs: 30 },
    run: hangingRunner().run,
  })
  assert.equal(report.ok, false)
  assert.equal(report.counts.cancelled, 2)
  assert.match(report.summary, /timeout after 30 ms/)
})

test('caller cancellation stops the batch without retrying', async () => {
  const controller = new AbortController()
  const pending = runSwarm({
    tasks: [{ id: 'a', prompt: 'p' }, { id: 'b', prompt: 'p' }],
    limits: { maxConcurrency: 1, retries: 2 },
    run: hangingRunner().run,
    signal: controller.signal,
  })
  setTimeout(() => controller.abort('user stopped'), 10)
  const report = await pending
  assert.equal(report.ok, false)
  assert.equal(report.counts.cancelled, 2)
  assert.ok(report.tasks.every((task) => task.attempts <= 1))
})

test('structured output reaches both items and the task report', async () => {
  const report = await runSwarm({
    tasks: [
      { id: 'one', prompt: 'p', schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } },
      { id: 'two', prompt: 'p', schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } },
    ],
    limits: { retries: 0 },
    run: async (task) => ({ output: [{ type: 'text', text: '{}' }], structured: { n: task.id === 'one' ? 1 : 2 }, stopReason: 'completed' }),
  })
  assert.deepEqual(report.items, [{ n: 1 }, { n: 2 }])
  assert.deepEqual(report.tasks.map((task) => task.structured), [{ n: 1 }, { n: 2 }])
  assert.match(report.text, /```json/)
})

test('plan validation rejects unusable plans before any work starts', async () => {
  const cases = [
    [[], /at least one task/],
    [[{ id: '', prompt: 'p' }], /non-empty string id/],
    [[{ id: 'a', prompt: 'p' }, { id: 'a', prompt: 'q' }], /duplicate task id/],
    [[{ id: 'a', prompt: '  ' }], /non-empty prompt/],
    [[{ id: 'a', prompt: 'p', schema: { type: 'string' } }], /object-rooted/],
    [Array.from({ length: 3 }, (_, index) => ({ id: `t${index}`, prompt: 'p' })), /above limits.maxTasks/],
  ]
  for (const [tasks, pattern] of cases) {
    await assert.rejects(
      runSwarm({ tasks, limits: { maxTasks: 2 }, run: async () => ({ output: [], stopReason: 'completed' }) }),
      (error) => error instanceof SwarmPlanError && pattern.test(error.message),
    )
  }
  await assert.rejects(async () => normalizePlan([{ id: 'a', prompt: 'p' }], { maxConcurrency: 0 }), SwarmPlanError)
})

test('gate serves waiters in order and never over-admits', async () => {
  const gate = createGate(2)
  await gate.acquire()
  await gate.acquire()
  const order = []
  const third = gate.acquire().then(() => order.push('third'))
  const fourth = gate.acquire().then(() => order.push('fourth'))
  assert.equal(gate.snapshot(), 2)
  // Releasing a held permit hands it directly to the first waiter, so the
  // number of used permits never exceeds the gate's capacity.
  gate.release()
  await third
  assert.deepEqual(order, ['third'])
  gate.release()
  await fourth
  assert.deepEqual(order, ['third', 'fourth'])
})

test('helpers behave for edge inputs', () => {
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'image' }, 'b']), 'ab')
  assert.equal(textOf(undefined), '')
  assert.equal(isObjectSchema({ type: 'object' }), true)
  assert.equal(isObjectSchema({ type: 'object', properties: {} }), true)
  assert.equal(isObjectSchema({ type: 'string' }), false)
  assert.equal(isObjectSchema(null), false)
  assert.equal(DEFAULT_LIMITS.maxConcurrency >= 1, true)
})

test('progress events arrive before the batch resolves', async () => {
  const events = []
  await runSwarm({
    tasks: [{ id: 'a', prompt: 'p' }],
    limits: { retries: 0 },
    run: async () => ({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
    onEvent: (event) => events.push(`${event.type}:${event.task.id}:${event.attempt}`),
  })
  assert.deepEqual(events, ['task-start:a:1', 'task-end:a:1'])
})

test('a structured-only answer renders without a blank prose line', async () => {
  const report = await runSwarm({
    tasks: [
      { id: 'only-json', prompt: 'p', schema: { type: 'object', additionalProperties: false, properties: { n: { type: 'integer' } }, required: ['n'] } },
      { id: 'prose', prompt: 'p' },
    ],
    limits: { retries: 0 },
    run: async (task) => task.id === 'only-json'
      ? { output: [], structured: { n: 7 }, stopReason: 'completed' }
      : { output: [{ type: 'text', text: 'words' }], stopReason: 'completed' },
  })
  assert.equal(report.ok, true)
  assert.match(report.text, /### only-json\n```json/)
  assert.doesNotMatch(report.text, /### only-json\n\n/)
  assert.match(report.summary, /only-json \[ok\] structured result in 1 attempt/)
  assert.match(report.summary, /prose \[ok\] 5 chars in 1 attempt/)
})

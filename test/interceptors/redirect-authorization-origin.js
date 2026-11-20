'use strict'

// Origin-locked `authorization` handling across redirect hops, exercised
// entirely through the MockAgent so no real network address is contacted.
//
// Two credential sources are in scope:
//   1. the `authorization` header explicitly supplied on the initial request
//   2. the caller's per-origin `redirectAuthorization` trusted configuration
//
// The three-hop chain used below is:
//   entry origin -> target origin -> entry origin
// which makes both the cross-origin drop and the "return to entry" behavior
// observable.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { MockAgent, request, interceptors } = require('../..')

const ENTRY = 'http://entry.example'
const TARGET = 'http://target.example'
const TARGET_ALT_PORT = 'http://target.example:8080'

const ENTRY_TOKEN = 'entry-token'
const TARGET_TOKEN = 'target-token'

function headerValue (headers, name) {
  const wanted = name.toLowerCase()
  if (Array.isArray(headers)) {
    // Either a flat [name, value, ...] list or an array of [name, value] pairs.
    if (headers.length > 0 && Array.isArray(headers[0])) {
      for (const [key, value] of headers) {
        if (String(key).toLowerCase() === wanted) {
          return value
        }
      }
      return undefined
    }
    for (let i = 0; i < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === wanted) {
        return headers[i + 1]
      }
    }
    return undefined
  }
  if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted) {
        return value
      }
    }
  }
  return undefined
}

// Registers the three-hop chain entry -> target -> entry on the mock agent.
// `targetOrigin` allows switching the middle hop to a port-only variant.
function registerChain (mockAgent, targetOrigin = TARGET) {
  const entryPool = mockAgent.get(ENTRY)
  const targetPool = mockAgent.get(targetOrigin)

  entryPool
    .intercept({ path: '/start', method: 'GET' })
    .reply(307, '', { headers: { location: `${targetOrigin}/middle` } })
  targetPool
    .intercept({ path: '/middle', method: 'GET' })
    .reply(307, '', { headers: { location: `${ENTRY}/finish` } })
  entryPool
    .intercept({ path: '/finish', method: 'GET' })
    .reply(200, 'done')
}

function createDispatcher (mockAgent, redirectOpts = {}) {
  return mockAgent.compose(
    interceptors.redirect({ maxRedirections: 5, ...redirectOpts })
  )
}

test('explicit authorization is kept on the first hop, dropped cross-origin, and not restored when the chain returns to the entry origin', async () => {
  const mockAgent = new MockAgent({ enableCallHistory: true })
  mockAgent.disableNetConnect()
  test.after(() => mockAgent.close())

  registerChain(mockAgent)

  const dispatcher = createDispatcher(mockAgent)
  const { statusCode } = await request(`${ENTRY}/start`, {
    dispatcher,
    headers: {
      authorization: ENTRY_TOKEN,
      'x-ordinary': 'plain-header'
    }
  })
  assert.equal(statusCode, 200)

  const calls = mockAgent.getCallHistory().calls()
  assert.equal(calls.length, 3)

  const [first, second, third] = calls

  // First request keeps the explicitly supplied value verbatim.
  assert.equal(first.origin, ENTRY)
  assert.equal(headerValue(first.headers, 'authorization'), ENTRY_TOKEN)
  assert.equal(headerValue(first.headers, 'x-ordinary'), 'plain-header')

  // Cross-origin hop: the entry credential must not fill the target's header.
  assert.equal(second.origin, TARGET)
  assert.equal(headerValue(second.headers, 'authorization'), undefined)
  // Ordinary headers are still forwarded in the existing manner.
  assert.equal(headerValue(second.headers, 'x-ordinary'), 'plain-header')

  // Back at the entry origin after two redirects: the discarded explicit
  // credential must not be resurrected.
  assert.equal(third.origin, ENTRY)
  assert.equal(headerValue(third.headers, 'authorization'), undefined)
  assert.equal(headerValue(third.headers, 'x-ordinary'), 'plain-header')
})

test('trusted per-origin configuration supplies only the target origin its own authorization value', async () => {
  const mockAgent = new MockAgent({ enableCallHistory: true })
  mockAgent.disableNetConnect()
  test.after(() => mockAgent.close())

  registerChain(mockAgent)

  const trustedConfig = { [TARGET]: TARGET_TOKEN }
  const dispatcher = createDispatcher(mockAgent, {
    redirectAuthorization: trustedConfig
  })

  const { statusCode } = await request(`${ENTRY}/start`, {
    dispatcher,
    headers: { authorization: ENTRY_TOKEN }
  })
  assert.equal(statusCode, 200)

  const calls = mockAgent.getCallHistory().calls()
  assert.equal(calls.length, 3)

  const [first, second, third] = calls

  assert.equal(headerValue(first.headers, 'authorization'), ENTRY_TOKEN)
  assert.equal(headerValue(second.headers, 'authorization'), TARGET_TOKEN)
  // The target's value must never travel back to the entry origin.
  assert.equal(headerValue(third.headers, 'authorization'), undefined)

  // Reusing the client must not mutate the caller's configuration collection.
  assert.deepEqual(Object.keys(trustedConfig), [TARGET])
  assert.equal(trustedConfig[TARGET], TARGET_TOKEN)
})

test('neither the caller headers nor the trusted configuration collection is mutated by a request', async () => {
  const mockAgent = new MockAgent({ enableCallHistory: true })
  mockAgent.disableNetConnect()
  test.after(() => mockAgent.close())

  registerChain(mockAgent)

  const trustedConfig = { [TARGET]: TARGET_TOKEN }
  const dispatcher = createDispatcher(mockAgent, {
    redirectAuthorization: trustedConfig
  })

  const inputHeaders = { authorization: ENTRY_TOKEN, 'x-ordinary': 'plain-header' }
  const headersSnapshot = JSON.stringify(inputHeaders)
  const configSnapshot = JSON.stringify(trustedConfig)

  await request(`${ENTRY}/start`, { dispatcher, headers: inputHeaders })

  assert.equal(JSON.stringify(inputHeaders), headersSnapshot)
  assert.equal(JSON.stringify(trustedConfig), configSnapshot)
})

test('authorization header names match case-insensitively and the target trusted value fills the cross-origin blank', async () => {
  const mockAgent = new MockAgent({ enableCallHistory: true })
  mockAgent.disableNetConnect()
  test.after(() => mockAgent.close())

  registerChain(mockAgent)

  const dispatcher = createDispatcher(mockAgent, {
    redirectAuthorization: { [TARGET]: TARGET_TOKEN }
  })

  const { statusCode } = await request(`${ENTRY}/start`, {
    dispatcher,
    headers: [
      ['AuthORIZatiON', ENTRY_TOKEN],
      ['x-ordinary', 'plain-header']
    ]
  })
  assert.equal(statusCode, 200)

  const calls = mockAgent.getCallHistory().calls()
  const [first, second] = calls

  // The mixed-case field is the same field as `authorization`.
  assert.equal(headerValue(first.headers, 'AUTHORIZATION'), ENTRY_TOKEN)
  // The cross-origin strip removed the explicit value; the target's own
  // trusted entry fills the resulting blank.
  assert.equal(second.origin, TARGET)
  assert.equal(headerValue(second.headers, 'authorization'), TARGET_TOKEN)
  assert.equal(headerValue(second.headers, 'x-ordinary'), 'plain-header')
})

test('on a same-origin hop the explicit value is kept and the entry origin trusted entry is not substituted', async () => {
  const mockAgent = new MockAgent({ enableCallHistory: true })
  mockAgent.disableNetConnect()
  test.after(() => mockAgent.close())

  const entryPool = mockAgent.get(ENTRY)
  entryPool
    .intercept({ path: '/start', method: 'GET' })
    .reply(307, '', { headers: { location: `${ENTRY}/finish` } })
  entryPool
    .intercept({ path: '/finish', method: 'GET' })
    .reply(200, 'done')

  // Both credential sources resolve to the entry origin on the second hop.
  const dispatcher = createDispatcher(mockAgent, {
    redirectAuthorization: { [ENTRY]: 'entry-trusted' }
  })

  await request(`${ENTRY}/start`, {
    dispatcher,
    headers: { authorization: ENTRY_TOKEN }
  })

  const calls = mockAgent.getCallHistory().calls()
  assert.equal(calls.length, 2)
  // Same-origin compatibility behavior wins: no origin switch happened, so
  // the explicit value already in the headers is left untouched.
  assert.equal(headerValue(calls[0].headers, 'authorization'), ENTRY_TOKEN)
  assert.equal(headerValue(calls[1].headers, 'authorization'), ENTRY_TOKEN)
})

test('a target origin without trusted configuration sends no authorization header rather than reusing the previous hop', async () => {
  const mockAgent = new MockAgent({ enableCallHistory: true })
  mockAgent.disableNetConnect()
  test.after(() => mockAgent.close())

  registerChain(mockAgent)

  // Empty configuration: no origin has a trusted value.
  const dispatcher = createDispatcher(mockAgent, {
    redirectAuthorization: {}
  })

  const { statusCode } = await request(`${ENTRY}/start`, {
    dispatcher,
    headers: { authorization: ENTRY_TOKEN }
  })
  assert.equal(statusCode, 200)

  const calls = mockAgent.getCallHistory().calls()
  assert.equal(calls.length, 3)

  assert.equal(headerValue(calls[0].headers, 'authorization'), ENTRY_TOKEN)
  assert.equal(headerValue(calls[1].headers, 'authorization'), undefined)
  assert.equal(headerValue(calls[2].headers, 'authorization'), undefined)
})

test('a trusted value for one target origin does not travel onward to a third origin without its own entry', async () => {
  const OTHER = 'http://other.example'
  const mockAgent = new MockAgent({ enableCallHistory: true })
  mockAgent.disableNetConnect()
  test.after(() => mockAgent.close())

  mockAgent.get(ENTRY)
    .intercept({ path: '/start', method: 'GET' })
    .reply(307, '', { headers: { location: `${TARGET}/middle` } })
  mockAgent.get(TARGET)
    .intercept({ path: '/middle', method: 'GET' })
    .reply(307, '', { headers: { location: `${OTHER}/finish` } })
  mockAgent.get(OTHER)
    .intercept({ path: '/finish', method: 'GET' })
    .reply(200, 'done')

  const dispatcher = createDispatcher(mockAgent, {
    redirectAuthorization: { [TARGET]: TARGET_TOKEN }
  })

  await request(`${ENTRY}/start`, {
    dispatcher,
    headers: { authorization: ENTRY_TOKEN }
  })

  const calls = mockAgent.getCallHistory().calls()
  assert.equal(calls.length, 3)
  assert.equal(headerValue(calls[0].headers, 'authorization'), ENTRY_TOKEN)
  assert.equal(headerValue(calls[1].headers, 'authorization'), TARGET_TOKEN)
  // The target's credential must not be reused to fill another origin's hop.
  assert.equal(calls[2].origin, OTHER)
  assert.equal(headerValue(calls[2].headers, 'authorization'), undefined)
})

test('same-origin redirects preserve the explicit authorization through every hop', async () => {
  const mockAgent = new MockAgent({ enableCallHistory: true })
  mockAgent.disableNetConnect()
  test.after(() => mockAgent.close())

  const entryPool = mockAgent.get(ENTRY)
  entryPool
    .intercept({ path: '/start', method: 'GET' })
    .reply(307, '', { headers: { location: `${ENTRY}/middle` } })
  entryPool
    .intercept({ path: '/middle', method: 'GET' })
    .reply(307, '', { headers: { location: `${ENTRY}/finish` } })
  entryPool
    .intercept({ path: '/finish', method: 'GET' })
    .reply(200, 'done')

  const dispatcher = createDispatcher(mockAgent)

  const { statusCode } = await request(`${ENTRY}/start`, {
    dispatcher,
    headers: { authorization: ENTRY_TOKEN }
  })
  assert.equal(statusCode, 200)

  const calls = mockAgent.getCallHistory().calls()
  assert.equal(calls.length, 3)
  for (const call of calls) {
    assert.equal(call.origin, ENTRY)
    assert.equal(headerValue(call.headers, 'authorization'), ENTRY_TOKEN)
  }
})

test('origins differing only by port are distinct, and default-port spelling shares one configuration entry', async () => {
  const mockAgent = new MockAgent({ enableCallHistory: true })
  mockAgent.disableNetConnect()
  test.after(() => mockAgent.close())

  // Control chain: the middle hop changes only the port.
  registerChain(mockAgent, TARGET_ALT_PORT)

  // Configuration is keyed on the default-port spelling; the explicit-port
  // origin must not pick it up.
  const dispatcher = createDispatcher(mockAgent, {
    redirectAuthorization: { [TARGET]: TARGET_TOKEN }
  })

  const { statusCode } = await request(`${ENTRY}/start`, {
    dispatcher,
    headers: { authorization: ENTRY_TOKEN }
  })
  assert.equal(statusCode, 200)

  const calls = mockAgent.getCallHistory().calls()
  assert.equal(calls.length, 3)

  const [first, second, third] = calls
  assert.equal(first.origin, ENTRY)
  assert.equal(second.origin, TARGET_ALT_PORT)
  // Port-only difference means a different origin: no trusted value applies.
  assert.equal(headerValue(second.headers, 'authorization'), undefined)
  assert.equal(third.origin, ENTRY)
  assert.equal(headerValue(third.headers, 'authorization'), undefined)

  // Now verify default-port equivalence: a key spelled with the explicit
  // default port resolves to the same origin entry on a fresh request.
  mockAgent.clearCallHistory()
  const mockAgent2 = new MockAgent({ enableCallHistory: true })
  mockAgent2.disableNetConnect()
  test.after(() => mockAgent2.close())
  registerChain(mockAgent2)

  const dispatcher2 = mockAgent2.compose(
    interceptors.redirect({
      maxRedirections: 5,
      redirectAuthorization: { 'http://target.example:80': TARGET_TOKEN }
    })
  )

  await request(`${ENTRY}/start`, {
    dispatcher: dispatcher2,
    headers: { authorization: ENTRY_TOKEN }
  })

  const calls2 = mockAgent2.getCallHistory().calls()
  assert.equal(headerValue(calls2[1].headers, 'authorization'), TARGET_TOKEN)
})

test('each request on a reused client keeps its own authorization configuration without touching the input collection', async () => {
  const mockAgent = new MockAgent({ enableCallHistory: true })
  mockAgent.disableNetConnect()
  test.after(() => mockAgent.close())

  const trustedConfig = { [TARGET]: TARGET_TOKEN }
  const dispatcher = createDispatcher(mockAgent, {
    redirectAuthorization: trustedConfig
  })

  // First request: explicit entry value plus trusted target configuration.
  registerChain(mockAgent)
  await request(`${ENTRY}/start`, {
    dispatcher,
    headers: { authorization: ENTRY_TOKEN }
  })
  const firstCalls = mockAgent.getCallHistory().calls().slice(-3)
  assert.equal(headerValue(firstCalls[0].headers, 'authorization'), ENTRY_TOKEN)
  assert.equal(headerValue(firstCalls[1].headers, 'authorization'), TARGET_TOKEN)

  // Independent second request on the same client: different explicit value,
  // and no explicit header at all on this invocation.
  mockAgent.clearCallHistory()
  registerChain(mockAgent)
  await request(`${ENTRY}/start`, { dispatcher })
  const secondCalls = mockAgent.getCallHistory().calls()
  assert.equal(secondCalls.length, 3)
  assert.equal(headerValue(secondCalls[0].headers, 'authorization'), undefined)
  assert.equal(headerValue(secondCalls[1].headers, 'authorization'), TARGET_TOKEN)
  assert.equal(headerValue(secondCalls[2].headers, 'authorization'), undefined)

  // The caller's collection is untouched after both invocations.
  assert.deepEqual({ ...trustedConfig }, { [TARGET]: TARGET_TOKEN })
})

test('per-request redirectAuthorization overrides the interceptor default for that call only', async () => {
  const mockAgent = new MockAgent({ enableCallHistory: true })
  mockAgent.disableNetConnect()
  test.after(() => mockAgent.close())

  registerChain(mockAgent)

  // No interceptor-level trusted configuration.
  const dispatcher = createDispatcher(mockAgent)

  await request(`${ENTRY}/start`, {
    dispatcher,
    redirectAuthorization: { [TARGET]: TARGET_TOKEN },
    headers: { authorization: ENTRY_TOKEN }
  })

  const calls = mockAgent.getCallHistory().calls()
  assert.equal(headerValue(calls[0].headers, 'authorization'), ENTRY_TOKEN)
  assert.equal(headerValue(calls[1].headers, 'authorization'), TARGET_TOKEN)
  assert.equal(headerValue(calls[2].headers, 'authorization'), undefined)

  // A subsequent call without the per-request option gets no trusted value.
  mockAgent.clearCallHistory()
  registerChain(mockAgent)
  await request(`${ENTRY}/start`, {
    dispatcher,
    headers: { authorization: ENTRY_TOKEN }
  })
  const secondCalls = mockAgent.getCallHistory().calls()
  assert.equal(headerValue(secondCalls[0].headers, 'authorization'), ENTRY_TOKEN)
  assert.equal(headerValue(secondCalls[1].headers, 'authorization'), undefined)
  assert.equal(headerValue(secondCalls[2].headers, 'authorization'), undefined)
})

test('returning to the entry origin uses its own trusted configuration rather than the discarded explicit value', async () => {
  const mockAgent = new MockAgent({ enableCallHistory: true })
  mockAgent.disableNetConnect()
  test.after(() => mockAgent.close())

  registerChain(mockAgent)

  const dispatcher = createDispatcher(mockAgent, {
    redirectAuthorization: {
      [ENTRY]: 'entry-trusted',
      [TARGET]: 'target-trusted'
    }
  })

  const { statusCode } = await request(`${ENTRY}/start`, {
    dispatcher,
    headers: { authorization: ENTRY_TOKEN }
  })
  assert.equal(statusCode, 200)

  const calls = mockAgent.getCallHistory().calls()
  assert.equal(headerValue(calls[0].headers, 'authorization'), ENTRY_TOKEN)
  assert.equal(headerValue(calls[1].headers, 'authorization'), 'target-trusted')
  // The entry origin's own config entry supplies this hop — not the explicit
  // value that was discarded on the cross-origin transition.
  assert.equal(headerValue(calls[2].headers, 'authorization'), 'entry-trusted')
})

test('an empty-string trusted value is still an explicit per-origin credential', async () => {
  const mockAgent = new MockAgent({ enableCallHistory: true })
  mockAgent.disableNetConnect()
  test.after(() => mockAgent.close())

  registerChain(mockAgent)

  const dispatcher = createDispatcher(mockAgent, {
    redirectAuthorization: { [TARGET]: '' }
  })

  await request(`${ENTRY}/start`, {
    dispatcher,
    headers: { authorization: ENTRY_TOKEN }
  })

  const calls = mockAgent.getCallHistory().calls()
  assert.equal(headerValue(calls[1].headers, 'authorization'), '')
  // And it never leaks back to the entry origin.
  assert.equal(headerValue(calls[2].headers, 'authorization'), undefined)
})

test('invalid redirectAuthorization configuration is rejected when a request is dispatched', async () => {
  const mockAgent = new MockAgent()
  mockAgent.disableNetConnect()
  test.after(() => mockAgent.close())

  const stringDispatcher = mockAgent.compose(
    interceptors.redirect({ maxRedirections: 5, redirectAuthorization: 'not-an-object' })
  )
  await assert.rejects(
    request(`${ENTRY}/start`, { dispatcher: stringDispatcher }),
    /redirectAuthorization must be an object/
  )

  // Construction of the handler (on dispatch) validates entry values.
  const badDispatcher = mockAgent.compose(
    interceptors.redirect({
      maxRedirections: 5,
      redirectAuthorization: { [TARGET]: 123 }
    })
  )
  await assert.rejects(
    request(`${ENTRY}/start`, { dispatcher: badDispatcher }),
    /redirectAuthorization values must be strings/
  )
})

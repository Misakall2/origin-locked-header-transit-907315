'use strict'

const util = require('../core/util')
const assert = require('node:assert')
const { InvalidArgumentError, MaxRedirectsError } = require('../core/errors')
const { kRequestOrigin, kRedirectCacheControl } = require('../core/symbols')

const redirectableStatusCodes = [300, 301, 302, 303, 307, 308]

const noop = () => {}

const authorizationHeaderName = 'authorization'

class RedirectHandler {
  static buildDispatch (dispatcher, maxRedirections) {
    if (maxRedirections != null && (!Number.isInteger(maxRedirections) || maxRedirections < 0)) {
      throw new InvalidArgumentError('maxRedirections must be a positive number')
    }

    const dispatch = dispatcher.dispatch.bind(dispatcher)
    return (opts, originalHandler) => dispatch(opts, new RedirectHandler(dispatch, maxRedirections, opts, originalHandler))
  }

  constructor (dispatch, maxRedirections, opts, handler) {
    if (maxRedirections != null && (!Number.isInteger(maxRedirections) || maxRedirections < 0)) {
      throw new InvalidArgumentError('maxRedirections must be a positive number')
    }

    if (opts.throwOnMaxRedirect != null && typeof opts.throwOnMaxRedirect !== 'boolean') {
      throw new InvalidArgumentError('throwOnMaxRedirect must be a boolean')
    }

    this.dispatch = dispatch
    this.location = null
    const { maxRedirections: _, stripHeadersOnRedirect, stripHeadersOnCrossOriginRedirect, redirectAuthorization, ...cleanOpts } = opts
    this.opts = cleanOpts // opts must be a copy, exclude maxRedirections
    this.opts.body = util.wrapRequestBody(this.opts.body)
    this.stripHeadersOnRedirect = normalizeStripHeaders(stripHeadersOnRedirect, 'stripHeadersOnRedirect')
    this.stripHeadersOnCrossOriginRedirect = normalizeStripHeaders(stripHeadersOnCrossOriginRedirect, 'stripHeadersOnCrossOriginRedirect')
    // Per-origin `authorization` header values the caller explicitly trusts on
    // redirect hops. Normalized once into an origin-keyed map so each hop only
    // ever consults the target origin's own entry; credentials supplied for a
    // previous hop are never used to fill a header for another origin.
    this.redirectAuthorization = normalizeRedirectAuthorization(redirectAuthorization)
    // The `authorization` header carried by the initial request is only valid
    // for that entry origin. It is forwarded on same-origin hops (the existing
    // cross-origin stripping already removes it otherwise) and, once a
    // cross-origin hop drops it, it must not reappear if a later hop returns to
    // the entry origin.
    this.explicitAuthorization = findAuthorizationHeader(this.opts.headers)
    this.explicitAuthorizationDiscarded = false
    this.maxRedirections = maxRedirections
    this.handler = handler
    this.history = []
    // Per-hop metadata for each intermediate (suppressed) redirect hop: the
    // hop's status code and response headers. An outer cache uses it to honor a
    // hop's storage policy (e.g. `no-store`, `no-cache`, `Vary: *`) that would
    // otherwise be lost because the hop's response is not forwarded. It travels
    // as a non-enumerable property of the history array so it reaches the cache
    // without becoming part of the public request/response context.
    Object.defineProperty(this.history, kRedirectCacheControl, {
      value: [],
      enumerable: false
    })
  }

  onRequestStart (controller, context) {
    this.handler.onRequestStart?.(controller, { ...context, history: this.history })
  }

  onBodySent (chunk) {
    this.handler.onBodySent?.(chunk)
  }

  onRequestSent () {
    this.handler.onRequestSent?.()
  }

  onRequestUpgrade (controller, statusCode, headers, socket) {
    this.handler.onRequestUpgrade?.(controller, statusCode, headers, socket)
  }

  onResponseStart (controller, statusCode, headers, statusMessage) {
    if (statusCode < 200) {
      this.handler.onResponseStart?.(controller, statusCode, headers, statusMessage)
      return
    }

    let removeContentHeaders = statusCode === 303

    // https://tools.ietf.org/html/rfc7231#section-6.4.2
    // https://fetch.spec.whatwg.org/#http-redirect-fetch
    // In case of HTTP 301 or 302 with POST, change the method to GET
    // QUERY is safe (RFC 10008) and should not change method like GET.
    if ((statusCode === 301 || statusCode === 302) && this.opts.method === 'POST') {
      this.opts.method = 'GET'
      if (util.isStream(this.opts.body)) {
        util.destroy(this.opts.body.on('error', noop))
      }
      this.opts.body = null
      removeContentHeaders = true
    }

    // https://tools.ietf.org/html/rfc7231#section-6.4.4
    // In case of HTTP 303, always replace method to be either HEAD or GET
    if (statusCode === 303 && this.opts.method !== 'HEAD') {
      this.opts.method = 'GET'
      if (util.isStream(this.opts.body)) {
        util.destroy(this.opts.body.on('error', noop))
      }
      this.opts.body = null
    }

    this.location = util.isDisturbed(this.opts.body) || redirectableStatusCodes.indexOf(statusCode) === -1
      ? null
      : headers.location || null

    // Only a redirect that would otherwise be followed counts against the
    // limit. The final response after exactly maxRedirections redirects, or a
    // 3xx without a Location header, is delivered as usual.
    if (this.location && this.history.length >= this.maxRedirections) {
      if (this.opts.throwOnMaxRedirect) {
        throw new MaxRedirectsError()
      }
      this.location = null
    }

    const requestOrigin = this.opts[kRequestOrigin] === undefined
      ? this.opts.origin
      : this.opts[kRequestOrigin]

    if (requestOrigin) {
      this.history.push(new URL(this.opts.path, requestOrigin))
    }

    if (!this.location) {
      this.handler.onResponseStart?.(controller, statusCode, headers, statusMessage)
      return
    }

    // This hop's response is suppressed (only its Location is used). Record its
    // status and headers so an outer cache can honor a restrictive policy that
    // would otherwise be lost when the final response is stored.
    this.history[kRedirectCacheControl].push({
      statusCode,
      headers: { ...headers },
      receivedAt: Date.now()
    })

    const baseUrl = requestOrigin
      ? new URL(this.opts.path, requestOrigin)
      : undefined
    const { origin, pathname, search } = util.parseURL(new URL(this.location, baseUrl))
    const path = search ? `${pathname}${search}` : pathname

    // Check for redirect loops by seeing if we've already visited this URL in our history
    // This catches the case where Client/Pool try to handle cross-origin redirects but fail
    // and keep redirecting to the same URL in an infinite loop
    const redirectUrlString = `${origin}${path}`
    for (const historyUrl of this.history) {
      if (historyUrl.toString() === redirectUrlString) {
        throw new InvalidArgumentError(`Redirect loop detected. Cannot redirect to ${origin}. This typically happens when using a Client or Pool with cross-origin redirects. Use an Agent for cross-origin redirects.`)
      }
    }

    // Remove headers referring to the original URL.
    // By default it is Host only. A 303 or a 301/302 POST-to-GET redirect also removes all Content-* headers.
    // https://tools.ietf.org/html/rfc7231#section-6.4
    const crossOriginRedirect = requestOrigin !== origin
    this.opts.headers = cleanRequestHeaders(this.opts.headers, removeContentHeaders, crossOriginRedirect, this.stripHeadersOnRedirect, this.stripHeadersOnCrossOriginRedirect)

    // Rebuild the `authorization` header for the next request from the two
    // credential sources in scope. A value still on the request is the
    // explicit credential preserved by same-origin forwarding and is left
    // untouched. After a cross-origin strip, the blank is filled only from
    // the target origin's own trusted configuration; a previous hop's
    // credential is never carried over, and an origin without a configured
    // value sends the next request without `authorization`.
    this.opts.headers = this.#applyRedirectAuthorization(this.opts.headers, origin, crossOriginRedirect)

    this.opts.path = path
    this.opts.origin = origin
    this.opts[kRequestOrigin] = origin
    this.opts.query = null
  }

  #applyRedirectAuthorization (headers, targetOrigin, crossOriginRedirect) {
    if (crossOriginRedirect) {
      // The cross-origin stripping above removed any `authorization` value
      // inherited from the previous hop. The explicit entry-origin credential
      // is now out of scope, even if a later hop returns to that origin.
      this.explicitAuthorizationDiscarded = true
    }

    // A usable explicit credential is still on the request only on a
    // same-origin chain (cross-origin stripping always removes it). The
    // existing same-origin compatibility behavior is to forward that value
    // untouched, so the trusted configuration never substitutes it: its job
    // is to fill the blank left after a cross-origin strip, never to replace
    // a same-origin value.
    if (findAuthorizationHeader(headers) !== undefined) {
      return headers
    }

    const trustedAuthorization = this.redirectAuthorization?.get(targetOrigin)
    if (trustedAuthorization !== undefined) {
      // No explicit credential is in scope for this hop; if the caller trusts
      // the target origin with its own configured value, that value fills the
      // blank. A previous hop's credential is never carried over for this.
      return replaceAuthorizationHeader(headers, trustedAuthorization)
    }

    if (!this.explicitAuthorizationDiscarded && this.explicitAuthorization !== undefined) {
      // Same-origin chain whose explicit value was removed by an explicit
      // strip configuration rather than by the cross-origin rule: re-apply the
      // value the caller supplied on the initial request.
      return appendAuthorizationHeader(headers, this.explicitAuthorization)
    }

    // No credential source for this origin: the next request is sent without
    // an `authorization` header.
    return headers
  }

  onResponseData (controller, chunk) {
    if (this.location) {
      /*
        https://tools.ietf.org/html/rfc7231#section-6.4

        TLDR: undici always ignores 3xx response bodies.

        Redirection is used to serve the requested resource from another URL, so it assumes that
        no body is generated (and thus can be ignored). Even though generating a body is not prohibited.

        For status 301, 302, 303, 307 and 308 (the latter from RFC 7238), the specs mention that the body usually
        (which means it's optional and not mandated) contain just an hyperlink to the value of
        the Location response header, so the body can be ignored safely.

        For status 300, which is "Multiple Choices", the spec mentions both generating a Location
        response header AND a response body with the other possible location to follow.
        Since the spec explicitly chooses not to specify a format for such body and leave it to
        servers and browsers implementors, we ignore the body as there is no specified way to eventually parse it.
      */
    } else {
      this.handler.onResponseData?.(controller, chunk)
    }
  }

  onResponseEnd (controller, trailers) {
    if (this.location) {
      /*
        https://tools.ietf.org/html/rfc7231#section-6.4

        TLDR: undici always ignores 3xx response trailers as they are not expected in case of redirections
        and neither are useful if present.

        See comment on onData method above for more detailed information.
      */
      this.dispatch(this.opts, this)
    } else {
      this.handler.onResponseEnd(controller, trailers)
    }
  }

  onResponseError (controller, error) {
    this.handler.onResponseError?.(controller, error)
  }
}

// https://tools.ietf.org/html/rfc7231#section-6.4.4
function shouldRemoveHeader (header, removeContent, unknownOrigin, stripHeaders, stripHeadersOnCrossOrigin) {
  const name = util.headerNameToString(header)
  if (name === 'host') {
    return true
  }
  if (stripHeaders?.has(name) || (unknownOrigin && stripHeadersOnCrossOrigin?.has(name))) {
    return true
  }
  if (removeContent && name.startsWith('content-')) {
    return true
  }
  if (unknownOrigin) {
    return name === 'authorization' || name === 'cookie' || name === 'proxy-authorization'
  }
  return false
}

// https://tools.ietf.org/html/rfc7231#section-6.4
function normalizeStripHeaders (headers, optionName) {
  if (headers == null) {
    return null
  }

  if (!Array.isArray(headers)) {
    throw new InvalidArgumentError(`${optionName} must be an array`)
  }

  const normalized = new Set()
  for (const header of headers) {
    if (typeof header !== 'string') {
      throw new InvalidArgumentError(`${optionName} must contain header names`)
    }

    normalized.add(util.headerNameToString(header))
  }
  return normalized
}

// Normalizes the caller's trusted per-origin `authorization` configuration
// into an origin-keyed `Map`. Origins are compared by protocol, host and
// effective port, reusing the same URL parsing (with default-port handling) as
// redirect target resolution, so `http://example.com` and
// `http://example.com:80` map to the same entry. The input is copied: reusing
// a client across requests never mutates the caller's collection.
function normalizeRedirectAuthorization (redirectAuthorization) {
  if (redirectAuthorization == null) {
    return null
  }

  if (typeof redirectAuthorization !== 'object') {
    throw new InvalidArgumentError('redirectAuthorization must be an object mapping origins to authorization header values')
  }

  const normalized = new Map()
  const entries = util.hasSafeIterator(redirectAuthorization)
    ? redirectAuthorization
    : Object.entries(redirectAuthorization)

  for (const [origin, value] of entries) {
    if (typeof origin !== 'string') {
      throw new InvalidArgumentError('redirectAuthorization must contain origin keys')
    }
    if (typeof value !== 'string') {
      throw new InvalidArgumentError('redirectAuthorization values must be strings')
    }

    normalized.set(util.parseOrigin(origin).origin, value)
  }
  return normalized
}

// Returns the value of the first `authorization` field, regardless of the
// field name's casing, or `undefined` when the request carries none.
function findAuthorizationHeader (headers) {
  if (Array.isArray(headers)) {
    if (headers.length > 0 && Array.isArray(headers[0])) {
      for (const [key, value] of headers) {
        if (util.headerNameToString(key) === authorizationHeaderName) {
          return value
        }
      }
    } else {
      for (let i = 0; i < headers.length; i += 2) {
        if (util.headerNameToString(headers[i]) === authorizationHeaderName) {
          return headers[i + 1]
        }
      }
    }
  } else if (headers && typeof headers === 'object') {
    const entries = util.hasSafeIterator(headers) ? headers : Object.entries(headers)
    for (const [key, value] of entries) {
      if (util.headerNameToString(key) === authorizationHeaderName) {
        return value
      }
    }
  }
  return undefined
}

// Returns a flat header array with every `authorization` field (matched
// case-insensitively) replaced by a single entry carrying `value`. Other
// headers, including their order, are preserved.
function replaceAuthorizationHeader (headers, value) {
  const ret = []
  let replaced = false

  const keep = (key, headerValue) => {
    if (util.headerNameToString(key) === authorizationHeaderName) {
      if (!replaced) {
        ret.push(authorizationHeaderName, value)
        replaced = true
      }
    } else {
      ret.push(key, headerValue)
    }
  }

  if (Array.isArray(headers)) {
    if (headers.length > 0 && Array.isArray(headers[0])) {
      for (const [key, headerValue] of headers) {
        keep(key, headerValue)
      }
    } else {
      for (let i = 0; i < headers.length; i += 2) {
        keep(headers[i], headers[i + 1])
      }
    }
  } else if (headers && typeof headers === 'object') {
    const entries = util.hasSafeIterator(headers) ? headers : Object.entries(headers)
    for (const [key, headerValue] of entries) {
      keep(key, headerValue)
    }
  } else {
    assert(headers == null, 'headers must be an object or an array')
  }

  if (!replaced) {
    ret.push(authorizationHeaderName, value)
  }
  return ret
}

// Returns a flat header array with an `authorization` entry appended. Used to
// re-apply the explicit entry-origin value on same-origin hops where header
// stripping would otherwise have removed it.
function appendAuthorizationHeader (headers, value) {
  const ret = []
  if (Array.isArray(headers)) {
    for (const header of headers) {
      ret.push(header)
    }
  } else if (headers && typeof headers === 'object') {
    const entries = util.hasSafeIterator(headers) ? headers : Object.entries(headers)
    for (const [key, headerValue] of entries) {
      ret.push(key, headerValue)
    }
  } else {
    assert(headers == null, 'headers must be an object or an array')
  }
  ret.push(authorizationHeaderName, value)
  return ret
}

function cleanRequestHeaders (headers, removeContent, unknownOrigin, stripHeaders, stripHeadersOnCrossOrigin) {
  const ret = []
  if (Array.isArray(headers)) {
    // Headers may be either a flat alternating [name, value, name, value, ...]
    // list or an iterable of [name, value] pairs. A plain JavaScript array of
    // tuples (e.g. `Object.entries(headers)`) satisfies the iterable-of-pairs
    // public type, so we must distinguish the two representations before
    // iterating. Treating every Array as a flat list misreads each tuple as a
    // header name/value pair and defeats the cross-origin credential stripping.
    if (headers.length > 0 && Array.isArray(headers[0])) {
      // Array of [name, value] pairs.
      for (const [key, value] of headers) {
        if (!shouldRemoveHeader(key, removeContent, unknownOrigin, stripHeaders, stripHeadersOnCrossOrigin)) {
          ret.push(key, value)
        }
      }
    } else {
      // Flat alternating [name, value, name, value, ...] list.
      for (let i = 0; i < headers.length; i += 2) {
        if (!shouldRemoveHeader(headers[i], removeContent, unknownOrigin, stripHeaders, stripHeadersOnCrossOrigin)) {
          ret.push(headers[i], headers[i + 1])
        }
      }
    }
  } else if (headers && typeof headers === 'object') {
    const entries = util.hasSafeIterator(headers) ? headers : Object.entries(headers)

    for (const [key, value] of entries) {
      if (!shouldRemoveHeader(key, removeContent, unknownOrigin, stripHeaders, stripHeadersOnCrossOrigin)) {
        ret.push(key, value)
      }
    }
  } else {
    assert(headers == null, 'headers must be an object or an array')
  }
  return ret
}

module.exports = RedirectHandler

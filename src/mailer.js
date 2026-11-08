'use strict';

class SendError extends Error {
  constructor(msg, { permanent = false, status } = {}) {
    super(msg);
    this.name = 'SendError';
    this.permanent = permanent;
    this.status = status;
  }
}

/**
 * Send one email through the Resend-format API.
 * The Idempotency-Key makes retries safe: if a previous attempt was accepted but
 * we never saw the response (timeout, crash), the retry cannot deliver twice.
 */
async function sendEmail({ baseUrl, apiKey, timeoutMs = 10000, from, to, subject, html, text, idempotencyKey, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (e) {
    throw new SendError(`send failed (${e.name})`);
  }
  const body = await res.text().catch(() => '');
  if (res.ok) {
    let id = null;
    try {
      id = JSON.parse(body).id ?? null;
    } catch {
      /* some providers return an empty body */
    }
    return { id: typeof id === 'string' ? id.slice(0, 100) : null };
  }
  // 400/422: the message itself is unacceptable (e.g. invalid recipient). Retrying cannot help.
  // Everything else (401, 409 concurrent key, 429, 5xx) is retried with backoff.
  const permanent = res.status === 400 || res.status === 422;
  throw new SendError(`provider returned ${res.status}`, { permanent, status: res.status });
}

module.exports = { sendEmail, SendError };

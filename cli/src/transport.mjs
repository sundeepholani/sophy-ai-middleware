export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

const authMessages = {
  invalid_or_expired_code: 'The code is invalid or expired. Try again, or request a new code with sophy auth request --email <email>.',
  too_many_attempts: 'Too many sign-in attempts. Wait a few minutes, then request a new code.',
  invalid_email: 'Enter a valid email address.',
  invalid_request: 'Sophy rejected the sign-in request. Check your CLI version and try again.',
  unauthorized: 'Your CLI session is no longer valid. Sign in again with sophy login.',
};

export async function request(origin, path, { token, body, multipart = false } = {}) {
  let response;
  try {
    response = await fetch(new URL(path, origin), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...(multipart ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: multipart ? body : JSON.stringify(body ?? {}),
      // A management token or OTP must never follow a redirect to another origin.
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ApiError('Could not reach Sophy. Check the URL and connection; redirects are not accepted.', 'connection_failed');
  }
  let result;
  try { result = await response.json(); }
  catch { throw new ApiError('Sophy returned an unexpected response. Check that the URL is a Sophy server.', 'invalid_response', response.status); }
  if (!response.ok || result?.ok !== true) {
    const code = typeof result?.error?.code === 'string' ? result.error.code : typeof result?.error === 'string' ? result.error : 'request_failed';
    const message = typeof result?.error?.message === 'string' ? result.error.message : authMessages[code] ?? 'Sophy could not complete this request.';
    throw new ApiError(message, code, response.status);
  }
  return result;
}

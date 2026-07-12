/**
 * Generic promise-timeout guard (carried over from the secrets review, bd
 * note on meal-planner-7js.6): the `op` CLI calls inside `loadSecrets` have
 * no timeout of their own, so a hung `op` process could hang daemon boot
 * indefinitely. Wrap any boot-time promise (secret loading, in particular)
 * with `withTimeout` so it fails fast with a clear, secret-free error
 * instead.
 */

export interface WithTimeoutOptions {
  /** Milliseconds to wait before rejecting, if the wrapped promise has not settled. */
  timeoutMs: number;
  /** Error message used on timeout. Callers MUST NOT include secret values here. Defaults to a generic, secret-free message. */
  message?: string;
}

/**
 * Races `promise` against a timeout of `timeoutMs`. Resolves/rejects with
 * whatever `promise` settles with if it settles first; otherwise rejects
 * with an Error (never including any value from `promise`) once the timeout
 * elapses. Always clears its internal timer, so it never leaks a pending
 * timer regardless of which side wins.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  options: WithTimeoutOptions,
): Promise<T> {
  const { timeoutMs, message } = options;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message ?? `Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Errors that must NOT be retried: bad payload, missing row, unsupported input.
 *
 * Lives in its own module because both the worker loop and every handler need
 * it, and importing it from the loop would make the handler module a cycle.
 *
 * The distinction matters on paid endpoints. A transient fal 503 should retry;
 * a payload naming an image that does not exist will fail identically three
 * times, and on a generative render each of those attempts is billable.
 */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

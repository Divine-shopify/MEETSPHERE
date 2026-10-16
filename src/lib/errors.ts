export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code = "bad_request") => new HttpError(400, code, msg);
export const unauthorized = (msg = "Sign in required") => new HttpError(401, "unauthorized", msg);
export const forbidden = (msg = "You are not allowed to do that") => new HttpError(403, "forbidden", msg);
export const notFound = (msg = "Not found") => new HttpError(404, "not_found", msg);
export const conflict = (msg: string, code = "conflict") => new HttpError(409, code, msg);
export const tooManyRequests = (msg = "Too many attempts. Please wait and try again.") =>
  new HttpError(429, "rate_limited", msg);
export const unavailable = (msg: string, code = "unavailable") => new HttpError(503, code, msg);

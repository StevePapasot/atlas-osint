export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (what = 'Resource') => new ApiError(404, 'not_found', `${what} not found.`);
export const badRequest = (message: string, details?: unknown) => new ApiError(400, 'bad_request', message, details);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);
export const forbidden = (message = 'Forbidden.') => new ApiError(403, 'forbidden', message);
export const unauthorized = () => new ApiError(401, 'unauthorized', 'Authentication required.');

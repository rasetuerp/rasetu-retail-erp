export class HttpError extends Error {
  statusCode: number;
  code?: string;
  meta?: unknown;

  constructor(statusCode: number, message: string, options?: { code?: string; meta?: unknown }) {
    super(message);
    this.statusCode = statusCode;
    this.code = options?.code;
    this.meta = options?.meta;
  }
}

/**
 * Shared service-layer primitives.
 *
 * Every service function returns a `Result<T, ServiceError>` so the caller
 * never needs to wrap calls in `try/catch` to handle DB or validation issues.
 */

export const SERVICE_ERROR_CODES = [
  'UNKNOWN',
  'VALIDATION',
  'CONFLICT',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'DATABASE',
] as const;

export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

/**
 * Structured error returned by service functions.
 */
export type ServiceError = {
  /** Stable machine-readable code. */
  code: ServiceErrorCode;
  /** Human-readable message suitable for logging. */
  message: string;
  /** Optional underlying cause for debugging. */
  cause?: unknown;
};

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = ServiceError> = Ok<T> | Err<E>;

/**
 * Wrap a value as a successful Result.
 *
 * @param value - The successful payload.
 * @returns An Ok Result.
 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/**
 * Build an Err Result from a code and message.
 *
 * @param code - Machine-readable error code.
 * @param message - Human-readable error message.
 * @param cause - Optional underlying cause.
 * @returns An Err Result.
 */
export function err(
  code: ServiceErrorCode,
  message: string,
  cause?: unknown,
): Err<ServiceError> {
  return { ok: false, error: { code, message, cause } };
}

/**
 * Pagination options accepted by list-style service functions.
 */
export type PaginationOptions = {
  /** 1-based page number. Defaults to 1. */
  page?: number;
  /** Items per page. Defaults to 20. */
  pageSize?: number;
};

export type Page<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Normalize and validate pagination options.
 *
 * @param opts - Raw pagination input.
 * @returns Normalized values with page >= 1 and 1 <= pageSize <= MAX_PAGE_SIZE.
 */
export function normalizePagination(opts?: PaginationOptions): {
  page: number;
  pageSize: number;
} {
  const rawPage = opts?.page ?? 1;
  const rawSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Math.floor(rawPage));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(rawSize)));
  return { page, pageSize };
}

/**
 * Build a Page<T> from raw items + total count, applying offset.
 *
 * @param items - Items for the current page (already sliced).
 * @param total - Total row count across all pages.
 * @param page - Current page (1-based).
 * @param pageSize - Items per page.
 * @returns A populated Page.
 */
export function buildPage<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): Page<T> {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * Generate a URL-safe slug from a title. Falls back to 'post' on empty input.
 *
 * @param input - Source string to slugify.
 * @returns URL-safe slug.
 */
export function slugify(input: string): string {
  const ascii = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return ascii || 'post';
}

import type { AppError, AppErrorCode } from "../shared/schema.ts";

export class ConfuiError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "ConfuiError";
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof ConfuiError) {
    return { code: error.code, message: error.message, detail: error.detail };
  }
  if (error instanceof Error) {
    return { code: "UNKNOWN", message: error.message };
  }
  return { code: "UNKNOWN", message: "发生了未知错误" };
}

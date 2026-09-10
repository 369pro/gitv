export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

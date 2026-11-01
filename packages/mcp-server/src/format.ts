import { isZodError, toZod3Issues } from "@paperclipai/shared";
import { PaperclipApiError } from "./client.js";

type McpTextResponse = {
  content: Array<{ type: "text"; text: string }>;
};

export function formatTextResponse(value: unknown): McpTextResponse {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

/**
 * zod 3's `ZodError.message`: the issues as indented JSON (bigints as strings).
 * Tool input errors keep this text, built from the zod 3 form of the issues.
 */
function zod3ErrorMessage(issues: readonly unknown[]): string {
  return JSON.stringify(
    toZod3Issues(issues),
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

export function formatErrorResponse(error: unknown): McpTextResponse {
  if (isZodError(error)) {
    return formatTextResponse({ error: zod3ErrorMessage(error.issues) });
  }
  if (error instanceof PaperclipApiError) {
    return formatTextResponse({
      error: error.message,
      status: error.status,
      method: error.method,
      path: error.path,
      body: error.body,
    });
  }
  return formatTextResponse({
    error: error instanceof Error ? error.message : String(error),
  });
}

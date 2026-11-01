import type { Request, Response, NextFunction } from "express";
import type { z } from "zod";
import { zod3IssueParams } from "@paperclipai/shared";

/**
 * Parses `req.body` with `schema`. A failure throws the ZodError to the error
 * handler, which answers 400 with zod 3-compatible issues (`zod3IssueParams`
 * records them while parsing).
 */
export function validate(schema: z.ZodType) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = schema.parse(req.body, zod3IssueParams);
    next();
  };
}

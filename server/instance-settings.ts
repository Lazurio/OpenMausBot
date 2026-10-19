import { z } from "zod";

const displayName = z.string().trim().min(1).max(80).refine((value) => !/\p{Cc}/u.test(value), "Name cannot contain control characters");
export const accountNameSchema = z.object({ displayName }).strict();
export const instanceSettingsSchema = z.object({
  cli: z.string().max(4096).refine((value) => !/\p{Cc}/u.test(value), "CLI cannot contain control characters").optional(),
  tools: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "No settings supplied");

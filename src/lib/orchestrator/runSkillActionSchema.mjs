import { z } from "zod";

export const runSkillActionSchema = z.object({
  artifact: z.string().min(1).describe("Assigned skill name, path, slug, or artifact id"),
  action: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).describe("Declared action name from the skill catalog"),
  args: z.array(z.object({
    name: z.string().min(1).max(128).describe("Argument name declared by the action input schema"),
    value: z.union([z.string(), z.number(), z.boolean()]).describe("Argument value"),
  })).max(100).describe("Arguments declared by the action input schema as name/value entries; use an empty list when the action has no arguments"),
});

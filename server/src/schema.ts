import { z } from "zod";

export const anchorSchema = z.object({
  side: z.enum(["base", "compare"]),
  anchorText: z.string().max(80),
  approxLine: z.number().int().nonnegative(),
  hash: z.string().min(1)
});

export const evidenceSchema = z.object({
  source: z.enum(["base", "compare", "diff", "rules"]),
  snippet: z.string(),
  anchor: anchorSchema
});

export const findingSchema = z.object({
  id: z.string(),
  type: z.enum([
    "missing_rule",
    "missing_block",
    "weakened_constraint",
    "format_risk",
    "extra_noise"
  ]),
  severity: z.enum(["high", "medium", "low"]),
  claim: z.string(),
  evidence: z.array(evidenceSchema).min(1),
  action: z.enum(["add", "remove", "revise", "ignore"]),
  suggestedText: z.string().optional()
});

export const minoritySchema = z.object({
  id: z.string(),
  who: z.enum(["formalist", "riskAuditor", "pragmaticEditor"]),
  claim: z.string(),
  evidence: z.array(evidenceSchema).min(1)
});

export const patchSchema = z.object({
  strategy: z.literal("minimal"),
  blocksToInsert: z.array(
    z.object({
      anchorHint: z.string(),
      text: z.string()
    })
  ),
  suggestedCompareText: z.string().optional()
});

export const auditResultSchema = z.object({
  consensusFindings: z.array(findingSchema),
  minorityReport: z.array(minoritySchema),
  patch: patchSchema.optional()
});

export const auditResponseSchema = z.object({
  provider: z.string(),
  model: z.string(),
  ok: z.boolean(),
  data: auditResultSchema.optional(),
  rawText: z.string().optional(),
  error: z.string().optional()
});

export const debateTimelineSchema = z.object({
  round: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  speaker: z.enum(["formalist", "riskAuditor", "pragmaticEditor", "moderator"]),
  json: z.unknown()
});

export const debateResponseSchema = z.object({
  ok: z.boolean(),
  timeline: z.array(debateTimelineSchema),
  final: auditResultSchema
});

export type AuditResult = z.infer<typeof auditResultSchema>;

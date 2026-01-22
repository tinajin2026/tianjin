import "dotenv/config";
import express from "express";
import cors from "cors";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import {
  auditResultSchema,
  auditResponseSchema,
  debateResponseSchema,
  type AuditResult
} from "./schema.js";
import { createMockAudit, createMockDebate } from "./mock.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const requestSchema = z.object({
  baseName: z.string(),
  compareName: z.string(),
  baseText: z.string(),
  compareText: z.string(),
  diffSummary: z.string(),
  rules: z.string(),
  reviewSystemPromptLayer1: z.string(),
  reviewExtraPromptLayer2: z.string(),
  provider: z.string(),
  model: z.string(),
  redactMode: z.boolean()
});

const debateRequestSchema = requestSchema.extend({
  agents: z.array(
    z.object({
      role: z.enum(["formalist", "riskAuditor", "pragmaticEditor"]),
      provider: z.string(),
      model: z.string()
    })
  ),
  moderator: z.object({ provider: z.string(), model: z.string() })
});

const buildRetryPrompt = (content: string) =>
  `${content}\n\n只输出有效JSON，不要任何多余文本。`;

async function callOpenAIChat(payload: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: payload.model,
      messages: [
        { role: "system", content: payload.systemPrompt },
        { role: "user", content: payload.userPrompt }
      ],
      temperature: payload.temperature ?? 0.2
    })
  });

  const json = await response.json();
  return json.choices?.[0]?.message?.content ?? "";
}

async function parseJsonWithRepair<T>(text: string, schema: z.ZodSchema<T>) {
  try {
    const parsed = JSON.parse(text);
    return schema.parse(parsed);
  } catch (error) {
    const repaired = jsonrepair(text);
    const parsed = JSON.parse(repaired);
    return schema.parse(parsed);
  }
}

async function handleModelResponse<T>(
  rawText: string,
  schema: z.ZodSchema<T>
): Promise<{ ok: true; data: T } | { ok: false; error: string; rawText: string }> {
  try {
    const data = await parseJsonWithRepair(rawText, schema);
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to parse",
      rawText
    };
  }
}

async function callRoundWithRetry<T>(params: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodSchema<T>;
}) {
  const raw = await callOpenAIChat({
    model: params.model,
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt
  });
  let parsed = await handleModelResponse(raw, params.schema);
  if (parsed.ok) {
    return { ok: true as const, data: parsed.data };
  }
  const retryRaw = await callOpenAIChat({
    model: params.model,
    systemPrompt: buildRetryPrompt(params.systemPrompt),
    userPrompt: params.userPrompt
  });
  parsed = await handleModelResponse(retryRaw, params.schema);
  if (parsed.ok) {
    return { ok: true as const, data: parsed.data };
  }
  return { ok: false as const, error: parsed.error, rawText: retryRaw };
}

async function callMockAudit(body: z.infer<typeof requestSchema>): Promise<AuditResult> {
  return createMockAudit({
    baseText: body.baseText,
    compareText: body.compareText,
    diffSummary: body.diffSummary,
    rules: body.rules
  });
}

app.post("/api/ai/audit", async (req, res) => {
  const parseResult = requestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const body = parseResult.data;
  const provider = body.provider || "mock";
  const model = body.model || "mock";

  const useMock = provider === "mock" || !process.env.OPENAI_API_KEY;

  if (useMock) {
    const data = await callMockAudit(body);
    return res.json({ provider: "mock", model: "local", ok: true, data });
  }

  const systemPrompt = `${body.reviewSystemPromptLayer1}\n${body.reviewExtraPromptLayer2}`.trim();
  const userPrompt = JSON.stringify({
    baseName: body.baseName,
    compareName: body.compareName,
    baseText: body.baseText,
    compareText: body.compareText,
    diffSummary: body.diffSummary,
    rules: body.rules
  });

  const rawText = await callOpenAIChat({ model, systemPrompt, userPrompt });
  let result = await handleModelResponse(rawText, auditResultSchema);

  if (!result.ok) {
    const retryText = await callOpenAIChat({
      model,
      systemPrompt: buildRetryPrompt(systemPrompt),
      userPrompt
    });
    result = await handleModelResponse(retryText, auditResultSchema);

    if (!result.ok) {
      return res.json({
        provider,
        model,
        ok: false,
        rawText: retryText,
        error: result.error
      });
    }
  }

  return res.json({ provider, model, ok: true, data: result.data });
});

app.post("/api/ai/patch", async (req, res) => {
  const parseResult = requestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const body = parseResult.data;
  const provider = body.provider || "mock";
  const model = body.model || "mock";

  const useMock = provider === "mock" || !process.env.OPENAI_API_KEY;

  if (useMock) {
    const data = await callMockAudit(body);
    return res.json({ provider: "mock", model: "local", ok: true, data });
  }

  const systemPrompt = `${body.reviewSystemPromptLayer1}\n${body.reviewExtraPromptLayer2}`.trim();
  const userPrompt = JSON.stringify({
    baseName: body.baseName,
    compareName: body.compareName,
    baseText: body.baseText,
    compareText: body.compareText,
    diffSummary: body.diffSummary,
    rules: body.rules,
    task: "Generate minimal patch blocks"
  });

  const rawText = await callOpenAIChat({ model, systemPrompt, userPrompt });
  let result = await handleModelResponse(rawText, auditResultSchema);

  if (!result.ok) {
    const retryText = await callOpenAIChat({
      model,
      systemPrompt: buildRetryPrompt(systemPrompt),
      userPrompt
    });
    result = await handleModelResponse(retryText, auditResultSchema);

    if (!result.ok) {
      return res.json({
        provider,
        model,
        ok: false,
        rawText: retryText,
        error: result.error
      });
    }
  }

  return res.json({ provider, model, ok: true, data: result.data });
});

app.post("/api/ai/debate", async (req, res) => {
  const parseResult = debateRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const body = parseResult.data;
  const useMock = body.moderator.provider === "mock" || !process.env.OPENAI_API_KEY;

  if (useMock) {
    const { timeline, final } = createMockDebate({
      baseText: body.baseText,
      compareText: body.compareText,
      diffSummary: body.diffSummary,
      rules: body.rules
    });
    return res.json({ ok: true, timeline, final });
  }

  const systemPrompt = `${body.reviewSystemPromptLayer1}\n${body.reviewExtraPromptLayer2}`.trim();
  const userContext = JSON.stringify({
    baseName: body.baseName,
    compareName: body.compareName,
    baseText: body.baseText,
    compareText: body.compareText,
    diffSummary: body.diffSummary,
    rules: body.rules
  });

  const round1Schema = z.object({
    topFindings: z.array(auditResultSchema.shape.consensusFindings.element).min(1).max(5)
  });
  const round2Schema = z.object({
    challenges: z
      .array(
        z.object({
          targetId: z.string(),
          note: z.string(),
          evidence: z.array(auditResultSchema.shape.consensusFindings.element.shape.evidence.element)
        })
      )
      .min(2)
  });
  const round3Schema = z.object({
    votes: z.array(
      z.object({
        id: z.string(),
        vote: z.enum(["yes", "no"]),
        reason: z.string(),
        evidence: z.array(auditResultSchema.shape.consensusFindings.element.shape.evidence.element)
      })
    )
  });

  const timeline: { round: 1 | 2 | 3 | 4; speaker: string; json: unknown }[] = [];

  for (const agent of body.agents) {
    const round1Prompt = `${userContext}\n\nRound1: 输出JSON { topFindings: [finding...] }。最多5条，必须包含证据anchor。`;
    const parsed = await callRoundWithRetry({
      model: agent.model,
      systemPrompt,
      userPrompt: round1Prompt,
      schema: round1Schema
    });
    const round1Json = parsed.ok ? parsed.data : { error: parsed.error, rawText: parsed.rawText };
    timeline.push({ round: 1, speaker: agent.role, json: round1Json });
  }

  for (const agent of body.agents) {
    const round2Prompt = `${userContext}\n\nRound2: 输出JSON { challenges: [{ targetId, note, evidence }] }。至少2条，针对他人finding。`;
    const parsed = await callRoundWithRetry({
      model: agent.model,
      systemPrompt,
      userPrompt: round2Prompt,
      schema: round2Schema
    });
    const round2Json = parsed.ok ? parsed.data : { error: parsed.error, rawText: parsed.rawText };
    timeline.push({ round: 2, speaker: agent.role, json: round2Json });
  }

  for (const agent of body.agents) {
    const round3Prompt = `${userContext}\n\nRound3: 输出JSON { votes: [{ id, vote, reason, evidence }] }。对候选finding投票。`;
    const parsed = await callRoundWithRetry({
      model: agent.model,
      systemPrompt,
      userPrompt: round3Prompt,
      schema: round3Schema
    });
    const round3Json = parsed.ok ? parsed.data : { error: parsed.error, rawText: parsed.rawText };
    timeline.push({ round: 3, speaker: agent.role, json: round3Json });
  }

  const round4Prompt = `${userContext}\n\nRound4: 你是Moderator，基于前三轮输出共识(>=2票)与少数意见，并给出最小补丁。输出JSON AuditResult schema。`;
  const rawFinal = await callOpenAIChat({
    model: body.moderator.model,
    systemPrompt,
    userPrompt: round4Prompt
  });
  let finalResult = await handleModelResponse(rawFinal, auditResultSchema);
  if (!finalResult.ok) {
    const retryText = await callOpenAIChat({
      model: body.moderator.model,
      systemPrompt: buildRetryPrompt(systemPrompt),
      userPrompt: round4Prompt
    });
    finalResult = await handleModelResponse(retryText, auditResultSchema);
  }
  const final = finalResult.ok ? finalResult.data : createMockAudit(body);
  timeline.push({ round: 4, speaker: \"moderator\", json: final });

  return res.json({ ok: true, timeline, final });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
app.listen(PORT, () => {
  console.log(`PromptDiff Audit Lab server listening on ${PORT}`);
});

// Validate response shape for type-safety in runtime
const auditResponseValidation = auditResponseSchema.safeParse({
  provider: "mock",
  model: "local",
  ok: true,
  data: createMockAudit({
    baseText: "base",
    compareText: "compare",
    diffSummary: "Missing Lines: 1 Extra Lines: 0 Changed Blocks: 0",
    rules: "rule"
  })
});

if (!auditResponseValidation.success) {
  console.warn("Audit response schema validation failed at startup");
}

const debateResponseValidation = debateResponseSchema.safeParse({
  ok: true,
  ...createMockDebate({
    baseText: "base",
    compareText: "compare",
    diffSummary: "Missing Lines: 1 Extra Lines: 0 Changed Blocks: 0",
    rules: "rule"
  })
});

if (!debateResponseValidation.success) {
  console.warn("Debate response schema validation failed at startup");
}

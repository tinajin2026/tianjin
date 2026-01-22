import crypto from "node:crypto";
import type { AuditResult } from "./schema.js";

type AnchorSide = "base" | "compare";

const hashText = (text: string) =>
  crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);

const buildAnchor = (side: AnchorSide, anchorText: string, approxLine = 1) => ({
  side,
  anchorText: anchorText.slice(0, 80),
  approxLine,
  hash: hashText(`${side}:${anchorText}:${approxLine}`)
});

const summarizeDiff = (diffSummary: string) => {
  const missing = /Missing Lines:\s*(\d+)/i.exec(diffSummary);
  const extra = /Extra Lines:\s*(\d+)/i.exec(diffSummary);
  const changed = /Changed Blocks:\s*(\d+)/i.exec(diffSummary);
  return {
    missing: Number(missing?.[1] ?? 0),
    extra: Number(extra?.[1] ?? 0),
    changed: Number(changed?.[1] ?? 0)
  };
};

export function createMockAudit(params: {
  baseText: string;
  compareText: string;
  diffSummary: string;
  rules: string;
}): AuditResult {
  const { baseText, compareText, diffSummary, rules } = params;
  const stats = summarizeDiff(diffSummary);
  const baseAnchor = buildAnchor("base", baseText.split("\n")[0] || "Base intro", 1);
  const compareAnchor = buildAnchor(
    "compare",
    compareText.split("\n")[0] || "Compare intro",
    1
  );

  const consensusFindings: AuditResult["consensusFindings"] = [];
  if (stats.missing > 0) {
    consensusFindings.push({
      id: "missing-core-rule",
      type: "missing_rule",
      severity: "high",
      claim: "Compare 版本缺少关键约束条款，可能导致审计输出不稳定。",
      evidence: [
        {
          source: "base",
          snippet: baseText.split("\n").slice(0, 3).join("\n") || "(base start)",
          anchor: baseAnchor
        }
      ],
      action: "add",
      suggestedText: rules.split("\n")[0] || "- 必须输出严格 JSON。"
    });
  }

  if (stats.extra > 0) {
    consensusFindings.push({
      id: "extra-noise",
      type: "extra_noise",
      severity: "medium",
      claim: "Compare 版本包含额外噪声段落，可能稀释关键约束。",
      evidence: [
        {
          source: "compare",
          snippet: compareText.split("\n").slice(0, 4).join("\n") || "(compare start)",
          anchor: compareAnchor
        }
      ],
      action: "revise"
    });
  }

  if (stats.changed > 0) {
    consensusFindings.push({
      id: "weakened-format",
      type: "weakened_constraint",
      severity: "medium",
      claim: "部分格式要求被弱化或替换，需恢复严格结构。",
      evidence: [
        {
          source: "diff",
          snippet: diffSummary,
          anchor: compareAnchor
        }
      ],
      action: "revise",
      suggestedText: "恢复‘必须严格 JSON’和‘证据链字段’相关约束。"
    });
  }

  const minorityReport: AuditResult["minorityReport"] = [
    {
      id: "minority-format",
      who: "formalist",
      claim: "格式风险仍可接受，但需要更明确的字段约束。",
      evidence: [
        {
          source: "rules",
          snippet: rules.split("\n").slice(0, 2).join("\n") || "(rules)",
          anchor: baseAnchor
        }
      ]
    }
  ];

  const patch: AuditResult["patch"] = {
    strategy: "minimal",
    blocksToInsert: consensusFindings
      .filter((finding) => finding.severity === "high" && finding.action === "add")
      .map((finding) => ({
        anchorHint: "## Core Rules",
        text: finding.suggestedText || "- 必须输出严格 JSON。"
      }))
  };

  return {
    consensusFindings,
    minorityReport,
    patch
  };
}

export function createMockDebate(params: {
  baseText: string;
  compareText: string;
  diffSummary: string;
  rules: string;
}): { timeline: { round: 1 | 2 | 3 | 4; speaker: string; json: unknown }[]; final: AuditResult } {
  const audit = createMockAudit(params);
  const timeline = [
    {
      round: 1 as const,
      speaker: "formalist",
      json: {
        topFindings: audit.consensusFindings.slice(0, 2)
      }
    },
    {
      round: 1 as const,
      speaker: "riskAuditor",
      json: {
        topFindings: audit.consensusFindings.slice(0, 2)
      }
    },
    {
      round: 1 as const,
      speaker: "pragmaticEditor",
      json: {
        topFindings: audit.consensusFindings.slice(0, 2)
      }
    },
    {
      round: 2 as const,
      speaker: "formalist",
      json: {
        challenges: [
          {
            targetId: audit.consensusFindings[0]?.id || "missing-core-rule",
            note: "需要补充更明确的证据 anchor。",
            evidence: audit.consensusFindings[0]?.evidence ?? []
          },
          {
            targetId: audit.consensusFindings[1]?.id || "extra-noise",
            note: "噪声段落应标记为弱化风险。",
            evidence: audit.consensusFindings[1]?.evidence ?? []
          }
        ]
      }
    },
    {
      round: 2 as const,
      speaker: "riskAuditor",
      json: {
        challenges: [
          {
            targetId: audit.consensusFindings[0]?.id || "missing-core-rule",
            note: "高风险缺失需要最小补丁。",
            evidence: audit.consensusFindings[0]?.evidence ?? []
          },
          {
            targetId: audit.consensusFindings[1]?.id || "extra-noise",
            note: "噪声影响范围需量化。",
            evidence: audit.consensusFindings[1]?.evidence ?? []
          }
        ]
      }
    },
    {
      round: 2 as const,
      speaker: "pragmaticEditor",
      json: {
        challenges: [
          {
            targetId: audit.consensusFindings[0]?.id || "missing-core-rule",
            note: "建议直接给出文本块以便插入。",
            evidence: audit.consensusFindings[0]?.evidence ?? []
          },
          {
            targetId: audit.consensusFindings[1]?.id || "extra-noise",
            note: "保留必要上下文，避免过度删除。",
            evidence: audit.consensusFindings[1]?.evidence ?? []
          }
        ]
      }
    },
    {
      round: 3 as const,
      speaker: "formalist",
      json: {
        votes: audit.consensusFindings.map((finding) => ({
          id: finding.id,
          vote: "yes",
          reason: "符合格式约束与证据链要求。",
          evidence: finding.evidence
        }))
      }
    },
    {
      round: 3 as const,
      speaker: "riskAuditor",
      json: {
        votes: audit.consensusFindings.map((finding) => ({
          id: finding.id,
          vote: "yes",
          reason: "风险明确，需要补丁。",
          evidence: finding.evidence
        }))
      }
    },
    {
      round: 3 as const,
      speaker: "pragmaticEditor",
      json: {
        votes: audit.consensusFindings.map((finding) => ({
          id: finding.id,
          vote: "yes",
          reason: "可执行且最小改动。",
          evidence: finding.evidence
        }))
      }
    },
    {
      round: 4 as const,
      speaker: "moderator",
      json: audit
    }
  ];

  return { timeline, final: audit };
}

import { diffLines } from "diff";

export type DocItem = {
  id: string;
  name: string;
  originalName: string;
  text: string;
  importedAt: string;
  lineCount: number;
  wordCount: number;
};

export type HeadingItem = {
  title: string;
  level: number;
  line: number;
};

export type EvidenceAnchor = {
  side: "base" | "compare";
  anchorText: string;
  approxLine: number;
  hash: string;
};

export type StaticAuditEntry = {
  id: string;
  type: "missing" | "extra" | "changed" | "risk";
  title: string;
  detail: string;
  anchor: EvidenceAnchor;
};

export const normalizeText = (text: string) => {
  const normalized = text.replace(/\r\n?/g, "\n");
  const trimmed = normalized
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n");
  return trimmed.replace(/\n{3,}/g, "\n\n");
};

export const buildHash = (text: string) => {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
};

export const parseHeadings = (text: string): HeadingItem[] => {
  const headings: HeadingItem[] = [];
  text.split("\n").forEach((line, index) => {
    const match = /^(#{1,3})\s+(.+)/.exec(line.trim());
    if (match) {
      headings.push({
        level: match[1].length,
        title: match[2].trim(),
        line: index + 1
      });
    }
  });
  return headings;
};

export const computeStats = (text: string) => {
  const lines = text.split("\n").filter(Boolean);
  const words = text
    .replace(/\n/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return { lineCount: lines.length, wordCount: words.length };
};

export const computeLineDiffDetailed = (base: string, compare: string) => {
  const changes = diffLines(base, compare);
  const missing: { text: string; line: number }[] = [];
  const extra: { text: string; line: number }[] = [];
  let baseLine = 1;
  let compareLine = 1;
  const changedBlocks: { baseStart: number; compareStart: number; text: string }[] = [];

  changes.forEach((change) => {
    const lines = change.value.split("\n");
    const lineCount = change.value.endsWith("\n") ? lines.length - 1 : lines.length;
    if (change.removed) {
      lines.forEach((line, index) => {
        if (line.trim().length > 0) {
          missing.push({ text: line, line: baseLine + index });
        }
      });
      changedBlocks.push({
        baseStart: baseLine,
        compareStart: compareLine,
        text: change.value.trim()
      });
      baseLine += lineCount;
    } else if (change.added) {
      lines.forEach((line, index) => {
        if (line.trim().length > 0) {
          extra.push({ text: line, line: compareLine + index });
        }
      });
      changedBlocks.push({
        baseStart: baseLine,
        compareStart: compareLine,
        text: change.value.trim()
      });
      compareLine += lineCount;
    } else {
      baseLine += lineCount;
      compareLine += lineCount;
    }
  });

  return { missing, extra, changedBlocks };
};

export const computeLineDiff = (base: string, compare: string) => {
  const { missing, extra, changedBlocks } = computeLineDiffDetailed(base, compare);
  return {
    missing: missing.map((item) => item.text),
    extra: extra.map((item) => item.text),
    changedBlocks
  };
};

const splitBlocks = (text: string) => {
  const headings = parseHeadings(text);
  if (headings.length > 0) {
    return headings.map((heading, index) => {
      const startLine = heading.line;
      const endLine = headings[index + 1]?.line ?? text.split("\n").length + 1;
      const block = text
        .split("\n")
        .slice(startLine - 1, endLine - 1)
        .join("\n");
      return { title: heading.title, startLine, text: block };
    });
  }

  const paragraphs = text.split(/\n\n+/).filter(Boolean);
  let lineCursor = 1;
  return paragraphs.map((para, index) => {
    const paraLines = para.split("\n");
    const block = paraLines.join("\n");
    const blockInfo = {
      title: `Paragraph ${index + 1}`,
      startLine: lineCursor,
      text: block
    };
    lineCursor += paraLines.length + 1;
    return blockInfo;
  });
};

export const computeBlockDiff = (base: string, compare: string) => {
  const baseBlocks = splitBlocks(base);
  const compareBlocks = splitBlocks(compare);

  const changed: { title: string; summary: string; anchor: EvidenceAnchor }[] = [];

  baseBlocks.forEach((baseBlock, index) => {
    const compareBlock = compareBlocks[index];
    if (!compareBlock) {
      changed.push({
        title: baseBlock.title,
        summary: "Compare missing corresponding block.",
        anchor: {
          side: "base",
          anchorText: baseBlock.text.slice(0, 80),
          approxLine: baseBlock.startLine,
          hash: buildHash(`${baseBlock.title}-${baseBlock.startLine}`)
        }
      });
      return;
    }
    if (baseBlock.text !== compareBlock.text) {
      changed.push({
        title: baseBlock.title,
        summary: `Block changed (base lines ${baseBlock.startLine}, compare lines ${compareBlock.startLine}).`,
        anchor: {
          side: "compare",
          anchorText: compareBlock.text.slice(0, 80),
          approxLine: compareBlock.startLine,
          hash: buildHash(`${compareBlock.title}-${compareBlock.startLine}`)
        }
      });
    }
  });

  return changed;
};

export const buildDiffSummary = (base: string, compare: string, changedBlocks: number) => {
  const { missing, extra } = computeLineDiff(base, compare);
  return `Missing Lines: ${missing.length} | Extra Lines: ${extra.length} | Changed Blocks: ${changedBlocks}`;
};

export const buildStaticAudit = (
  base: string,
  compare: string
): {
  missing: StaticAuditEntry[];
  extra: StaticAuditEntry[];
  changed: StaticAuditEntry[];
  risk: StaticAuditEntry[];
} => {
  const { missing, extra } = computeLineDiffDetailed(base, compare);
  const blockDiff = computeBlockDiff(base, compare);

  const missingEntries = missing.slice(0, 10).map((line, index) => ({
    id: `missing-${index}`,
    type: "missing" as const,
    title: "Missing Line",
    detail: line.text,
    anchor: {
      side: "base" as const,
      anchorText: line.text.slice(0, 80),
      approxLine: line.line,
      hash: buildHash(`missing-${index}-${line.text}`)
    }
  }));

  const extraEntries = extra.slice(0, 10).map((line, index) => ({
    id: `extra-${index}`,
    type: "extra" as const,
    title: "Extra Line",
    detail: line.text,
    anchor: {
      side: "compare" as const,
      anchorText: line.text.slice(0, 80),
      approxLine: line.line,
      hash: buildHash(`extra-${index}-${line.text}`)
    }
  }));

  const changedEntries = blockDiff.map((block, index) => ({
    id: `changed-${index}`,
    type: "changed" as const,
    title: block.title,
    detail: block.summary,
    anchor: block.anchor
  }));

  const riskEntries: StaticAuditEntry[] = [];
  if (!compare.includes("JSON")) {
    riskEntries.push({
      id: "risk-json",
      type: "risk",
      title: "Format Risk",
      detail: "Compare prompt lacks explicit JSON output constraint.",
      anchor: {
        side: "compare",
        anchorText: compare.split("\n")[0]?.slice(0, 80) || "Compare intro",
        approxLine: 1,
        hash: buildHash("risk-json")
      }
    });
  }
  if (!compare.includes("证据")) {
    riskEntries.push({
      id: "risk-evidence",
      type: "risk",
      title: "Evidence Chain Risk",
      detail: "Compare prompt lacks evidence chain requirement.",
      anchor: {
        side: "compare",
        anchorText: compare.split("\n")[0]?.slice(0, 80) || "Compare intro",
        approxLine: 1,
        hash: buildHash("risk-evidence")
      }
    });
  }

  return {
    missing: missingEntries,
    extra: extraEntries,
    changed: changedEntries,
    risk: riskEntries
  };
};

export const downloadFile = (filename: string, content: string, type: string) => {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
};

export const formatDate = (iso: string) => new Date(iso).toLocaleString();

export const detectLargeText = (text: string) => text.length >= 50000;

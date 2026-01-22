import React, { useCallback, useMemo, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type * as monacoType from "monaco-editor";
import {
  buildDiffSummary,
  buildStaticAudit,
  computeBlockDiff,
  computeStats,
  detectLargeText,
  downloadFile,
  formatDate,
  normalizeText,
  parseHeadings,
  type DocItem,
  type EvidenceAnchor
} from "./utils";
import {
  auditResponseSchema,
  debateResponseSchema,
  type AuditResult,
  type AuditResponse,
  type DebateResponse
} from "./types";

const LAYER1_PROMPT = `你是评审系统提示词审计员。必须输出严格JSON，且包含证据链字段。必须给出最小补丁策略，仅在必要时建议插入文本块。输出必须符合指定schema。`;

const DEFAULT_RULES = `- 必须输出严格JSON\n- 每条结论必须包含证据anchor\n- 给出最小补丁`;

const STORAGE_KEY = "promptdiff-docs";
const STORAGE_PRESETS = "promptdiff-presets";

const defaultPresets = [
  { id: "mock-default", name: "Mock / Local", content: "重点关注缺失规则与格式风险。" }
];

const createDoc = (file: File, text: string): DocItem => {
  const normalized = normalizeText(text);
  const stats = computeStats(normalized);
  return {
    id: `${file.name}-${Date.now()}`,
    name: file.name.replace(/\.[^/.]+$/, ""),
    originalName: file.name,
    text: normalized,
    importedAt: new Date().toISOString(),
    lineCount: stats.lineCount,
    wordCount: stats.wordCount
  };
};

const buildDocFromSample = (name: string, text: string): DocItem => {
  const normalized = normalizeText(text);
  const stats = computeStats(normalized);
  return {
    id: `${name}-${Date.now()}`,
    name,
    originalName: name,
    text: normalized,
    importedAt: new Date().toISOString(),
    lineCount: stats.lineCount,
    wordCount: stats.wordCount
  };
};

export default function App() {
  const [docs, setDocs] = useState<DocItem[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved) as DocItem[];
    }
    return [];
  });
  const [baseId, setBaseId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<"audit" | "debate" | "review">("audit");
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [provider, setProvider] = useState("mock");
  const [model, setModel] = useState("mock");
  const [layer2, setLayer2] = useState(defaultPresets[0].content);
  const [presets, setPresets] = useState(() => {
    const saved = localStorage.getItem(STORAGE_PRESETS);
    if (saved) {
      return JSON.parse(saved) as { id: string; name: string; content: string }[];
    }
    return defaultPresets;
  });
  const [selectedPresetId, setSelectedPresetId] = useState(presets[0]?.id ?? "");
  const [auditResult, setAuditResult] = useState<AuditResponse | null>(null);
  const [debateResult, setDebateResult] = useState<DebateResponse | null>(null);
  const [patchPreview, setPatchPreview] = useState<AuditResult["patch"] | null>(null);
  const [previousCompareText, setPreviousCompareText] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [changeIndex, setChangeIndex] = useState(0);
  const diffEditorRef = useRef<monacoType.editor.IStandaloneDiffEditor | null>(null);

  React.useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(docs));
  }, [docs]);

  React.useEffect(() => {
    localStorage.setItem(STORAGE_PRESETS, JSON.stringify(presets));
  }, [presets]);

  const baseDoc = docs.find((doc) => doc.id === baseId) ?? docs[0];
  const compareDoc = docs.find((doc) => doc.id === compareId) ?? docs[1];

  const baseText = baseDoc?.text ?? "";
  const compareText = compareDoc?.text ?? "";

  const headings = useMemo(() => parseHeadings(baseText), [baseText]);
  const blockDiffs = useMemo(() => computeBlockDiff(baseText, compareText), [baseText, compareText]);
  const diffSummary = useMemo(
    () => buildDiffSummary(baseText, compareText, blockDiffs.length),
    [baseText, compareText, blockDiffs.length]
  );

  const staticAudit = useMemo(
    () => buildStaticAudit(baseText, compareText),
    [baseText, compareText]
  );

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const newDocs: DocItem[] = [];
    for (const file of Array.from(files)) {
      const text = await file.text();
      newDocs.push(createDoc(file, text));
    }
    setDocs((prev) => [...newDocs, ...prev]);
    if (!baseId && newDocs[0]) {
      setBaseId(newDocs[0].id);
    }
    if (!compareId && newDocs[1]) {
      setCompareId(newDocs[1].id);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    handleFiles(event.dataTransfer.files);
  };

  const handleRename = (id: string, name: string) => {
    setDocs((prev) => prev.map((doc) => (doc.id === id ? { ...doc, name } : doc)));
  };

  const handleDelete = (id: string) => {
    setDocs((prev) => prev.filter((doc) => doc.id !== id));
    if (baseId === id) setBaseId(null);
    if (compareId === id) setCompareId(null);
  };

  const updateCompareText = (text: string) => {
    if (!compareDoc) return;
    const stats = computeStats(text);
    setDocs((prev) =>
      prev.map((doc) =>
        doc.id === compareDoc.id
          ? { ...doc, text, lineCount: stats.lineCount, wordCount: stats.wordCount }
          : doc
      )
    );
  };

  const handleLocate = useCallback((anchor: EvidenceAnchor) => {
    if (!diffEditorRef.current) return;
    const editor =
      anchor.side === "base"
        ? diffEditorRef.current.getOriginalEditor()
        : diffEditorRef.current.getModifiedEditor();

    editor.revealLineInCenter(anchor.approxLine || 1);
    const model = editor.getModel();
    if (!model) return;
    const matches = model.findMatches(anchor.anchorText, false, false, false, null, true);
    if (matches[0]) {
      editor.setSelection(matches[0].range);
      editor.revealRangeInCenter(matches[0].range);
    }
  }, []);

  const handleDiffMount = (editor: monacoType.editor.IStandaloneDiffEditor) => {
    diffEditorRef.current = editor;
  };

  const applyPromptVariables = (template: string) =>
    template
      .replaceAll("{{baseName}}", baseDoc?.name ?? "")
      .replaceAll("{{compareName}}", compareDoc?.name ?? "")
      .replaceAll("{{baseText}}", baseText)
      .replaceAll("{{compareText}}", compareText)
      .replaceAll("{{diffSummary}}", diffSummary)
      .replaceAll("{{rules}}", rules);

  const handleNavigateChange = (direction: "next" | "prev") => {
    if (!diffEditorRef.current) return;
    const changes = diffEditorRef.current.getLineChanges() || [];
    if (changes.length === 0) return;
    const nextIndex =
      direction === "next"
        ? (changeIndex + 1) % changes.length
        : (changeIndex - 1 + changes.length) % changes.length;
    setChangeIndex(nextIndex);
    const change = changes[nextIndex];
    const line = change.modifiedStartLineNumber || change.originalStartLineNumber || 1;
    diffEditorRef.current.getModifiedEditor().revealLineInCenter(line);
  };

  const handleRunAudit = async () => {
    if (!baseDoc || !compareDoc) return;
    setStatus("Running audit...");
    const injectedLayer1 = applyPromptVariables(LAYER1_PROMPT);
    const injectedLayer2 = applyPromptVariables(layer2);
    const response = await fetch("/api/ai/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseName: baseDoc.name,
        compareName: compareDoc.name,
        baseText,
        compareText,
        diffSummary,
        rules,
        reviewSystemPromptLayer1: injectedLayer1,
        reviewExtraPromptLayer2: injectedLayer2,
        provider,
        model,
        redactMode: false
      })
    });
    const json = await response.json();
    const parsed = auditResponseSchema.safeParse(json);
    if (!parsed.success) {
      setAuditResult({ provider, model, ok: false, error: "Invalid response" });
      setStatus("Audit failed");
      return;
    }
    setAuditResult(parsed.data);
    setPatchPreview(parsed.data.data?.patch ?? null);
    setStatus("Audit complete");
  };

  const handleRunPatch = async () => {
    if (!baseDoc || !compareDoc) return;
    setStatus("Generating patch...");
    const injectedLayer1 = applyPromptVariables(LAYER1_PROMPT);
    const injectedLayer2 = applyPromptVariables(layer2);
    const response = await fetch("/api/ai/patch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseName: baseDoc.name,
        compareName: compareDoc.name,
        baseText,
        compareText,
        diffSummary,
        rules,
        reviewSystemPromptLayer1: injectedLayer1,
        reviewExtraPromptLayer2: injectedLayer2,
        provider,
        model,
        redactMode: false
      })
    });
    const json = await response.json();
    const parsed = auditResponseSchema.safeParse(json);
    if (!parsed.success) {
      setStatus("Patch failed");
      return;
    }
    setPatchPreview(parsed.data.data?.patch ?? null);
    setStatus("Patch generated");
  };

  const handleApplyPatch = () => {
    if (!patchPreview || !compareDoc) return;
    setPreviousCompareText(compareDoc.text);
    let updated = compareDoc.text;
    patchPreview.blocksToInsert.forEach((block) => {
      const anchorIndex = updated.indexOf(block.anchorHint);
      if (anchorIndex !== -1) {
        const insertPos = updated.indexOf("\n", anchorIndex + block.anchorHint.length);
        const position = insertPos === -1 ? updated.length : insertPos + 1;
        updated = `${updated.slice(0, position)}${block.text}\n${updated.slice(position)}`;
      } else {
        updated = `${updated}\n\n${block.text}`;
      }
    });
    updateCompareText(normalizeText(updated));
  };

  const handleUndoPatch = () => {
    if (!previousCompareText || !compareDoc) return;
    updateCompareText(previousCompareText);
    setPreviousCompareText(null);
  };

  const handleRunDebate = async () => {
    if (!baseDoc || !compareDoc) return;
    setStatus("Running debate...");
    const injectedLayer1 = applyPromptVariables(LAYER1_PROMPT);
    const injectedLayer2 = applyPromptVariables(layer2);
    const response = await fetch("/api/ai/debate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseName: baseDoc.name,
        compareName: compareDoc.name,
        baseText,
        compareText,
        diffSummary,
        rules,
        reviewSystemPromptLayer1: injectedLayer1,
        reviewExtraPromptLayer2: injectedLayer2,
        provider,
        model,
        redactMode: false,
        agents: [
          { role: "formalist", provider, model },
          { role: "riskAuditor", provider, model },
          { role: "pragmaticEditor", provider, model }
        ],
        moderator: { provider, model }
      })
    });
    const json = await response.json();
    const parsed = debateResponseSchema.safeParse(json);
    if (!parsed.success) {
      setStatus("Debate failed");
      return;
    }
    setDebateResult(parsed.data);
    setStatus("Debate complete");
  };

  const handleExport = (format: "md" | "html") => {
    if (!baseDoc || !compareDoc) return;
    const report = `# PromptDiff Audit Lab Report\n\n## Base\n- Name: ${baseDoc.name}\n- Lines: ${baseDoc.lineCount}\n- Words: ${baseDoc.wordCount}\n\n## Compare\n- Name: ${compareDoc.name}\n- Lines: ${compareDoc.lineCount}\n- Words: ${compareDoc.wordCount}\n\n## Diff Summary\n${diffSummary}\n\n## Missing Lines\n${staticAudit.missing.map((item) => `- ${item.detail}`).join("\n") || "None"}\n\n## Extra Lines\n${staticAudit.extra.map((item) => `- ${item.detail}`).join("\n") || "None"}\n\n## Changed Blocks\n${staticAudit.changed.map((item) => `- ${item.title}: ${item.detail}`).join("\n") || "None"}\n\n## Risk Alerts\n${staticAudit.risk.map((item) => `- ${item.detail}`).join("\n") || "None"}\n\n## AI Review\n${auditResult?.data ? JSON.stringify(auditResult.data, null, 2) : "Not run"}\n\n## Debate Final\n${debateResult?.final ? JSON.stringify(debateResult.final, null, 2) : "Not run"}`;

    if (format === "md") {
      downloadFile("promptdiff-report.md", report, "text/markdown");
    } else {
      const html = `<!DOCTYPE html><html><body><pre>${report}</pre></body></html>`;
      downloadFile("promptdiff-report.html", html, "text/html");
    }
  };

  const handlePresetChange = (id: string) => {
    setSelectedPresetId(id);
    const preset = presets.find((item) => item.id === id);
    if (preset) setLayer2(preset.content);
  };

  const handleSavePreset = () => {
    const name = prompt("Preset name")?.trim();
    if (!name) return;
    const newPreset = { id: `${name}-${Date.now()}`, name, content: layer2 };
    setPresets((prev) => [...prev, newPreset]);
    setSelectedPresetId(newPreset.id);
  };

  const handleRestorePresets = () => {
    setPresets(defaultPresets);
    setSelectedPresetId(defaultPresets[0].id);
    setLayer2(defaultPresets[0].content);
  };

  const loadSamples = async () => {
    const samples = [
      { name: "Base Prompt", path: "/samples/base_prompt.md" },
      { name: "Compare Prompt", path: "/samples/compare_prompt.md" },
      { name: "Risky Prompt", path: "/samples/risky_prompt.md" }
    ];
    const docsLoaded: DocItem[] = [];
    for (const sample of samples) {
      const res = await fetch(sample.path);
      const text = await res.text();
      docsLoaded.push(buildDocFromSample(sample.name, text));
    }
    setDocs(docsLoaded);
    setBaseId(docsLoaded[0]?.id ?? null);
    setCompareId(docsLoaded[1]?.id ?? null);
  };

  const largeTextWarning = detectLargeText(baseText) || detectLargeText(compareText);

  return (
    <div className="app" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
      <header className="header">
        <div className="header-title">
          <h1>PromptDiff Audit Lab</h1>
          <p>对比系统提示词版本，生成证据链与可执行最小补丁。</p>
          <div className="header-meta">
            <span className="chip">{docs.length} Versions</span>
            <span className="chip">Base: {baseDoc?.name ?? "N/A"}</span>
            <span className="chip">Compare: {compareDoc?.name ?? "N/A"}</span>
          </div>
        </div>
        <div className="header-actions">
          <button onClick={loadSamples}>Load Samples</button>
          <button onClick={() => handleExport("md")}>Export Markdown</button>
          <button onClick={() => handleExport("html")}>Export HTML</button>
        </div>
      </header>

      <div className="layout">
        <aside className="panel left">
          <section>
            <h2>Versions</h2>
            <input
              type="file"
              multiple
              accept=".md,.txt"
              onChange={(e) => handleFiles(e.target.files)}
            />
            <div className="dropzone">Drag & drop .md/.txt here</div>
            <div className="hint">最多支持多个版本同时导入与对比。</div>
            {docs.map((doc) => (
              <div key={doc.id} className="doc-card">
                <input
                  value={doc.name}
                  onChange={(e) => handleRename(doc.id, e.target.value)}
                />
                <div className="doc-meta">
                  <div>Original: {doc.originalName}</div>
                  <div>Lines: {doc.lineCount} | Words: {doc.wordCount}</div>
                  <div>Imported: {formatDate(doc.importedAt)}</div>
                </div>
                <div className="doc-actions">
                  <label>
                    <input
                      type="radio"
                      name="base"
                      checked={baseDoc?.id === doc.id}
                      onChange={() => setBaseId(doc.id)}
                    />
                    Base
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="compare"
                      checked={compareDoc?.id === doc.id}
                      onChange={() => setCompareId(doc.id)}
                    />
                    Compare
                  </label>
                  <button onClick={() => handleDelete(doc.id)}>Delete</button>
                </div>
              </div>
            ))}
          </section>
          <section>
            <h2>Modules</h2>
            {headings.length === 0 ? (
              <div className="empty">No headings detected</div>
            ) : (
              <ul className="module-list">
                {headings.map((heading, index) => (
                  <li key={`${heading.title}-${index}`}>
                    <button
                      onClick={() =>
                        handleLocate({
                          side: "base",
                          anchorText: heading.title,
                          approxLine: heading.line,
                          hash: `${heading.title}-${heading.line}`
                        })
                      }
                    >
                      {"#".repeat(heading.level)} {heading.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        <main className="panel center">
          <div className="diff-toolbar">
            <div className="diff-stats">{diffSummary}</div>
            <div className="diff-actions">
              <button onClick={() => handleNavigateChange("prev")}>Prev Change</button>
              <button onClick={() => handleNavigateChange("next")}>Next Change</button>
            </div>
          </div>
          {largeTextWarning && (
            <div className="warning">Text is large (≥50k chars). Diff may be slow.</div>
          )}
          <DiffEditor
            height="80vh"
            language="markdown"
            original={baseText}
            modified={compareText}
            onMount={handleDiffMount}
            options={{
              renderSideBySide: true,
              wordWrap: "on",
              readOnly: true
            }}
          />
        </main>

        <aside className="panel right">
          <div className="tabs">
            <button
              className={selectedTab === "audit" ? "active" : ""}
              onClick={() => setSelectedTab("audit")}
            >
              Audit
            </button>
            <button
              className={selectedTab === "review" ? "active" : ""}
              onClick={() => setSelectedTab("review")}
            >
              Review Prompt
            </button>
            <button
              className={selectedTab === "debate" ? "active" : ""}
              onClick={() => setSelectedTab("debate")}
            >
              Debate
            </button>
          </div>

          {selectedTab === "audit" && (
            <div className="tab-content">
              <section>
                <h3>Static Audit</h3>
                <details open>
                  <summary>Missing Lines</summary>
                  {staticAudit.missing.map((item) => (
                    <div key={item.id} className="audit-item">
                      <div>{item.detail}</div>
                      <button onClick={() => handleLocate(item.anchor)}>Locate</button>
                    </div>
                  ))}
                </details>
                <details>
                  <summary>Extra Lines</summary>
                  {staticAudit.extra.map((item) => (
                    <div key={item.id} className="audit-item">
                      <div>{item.detail}</div>
                      <button onClick={() => handleLocate(item.anchor)}>Locate</button>
                    </div>
                  ))}
                </details>
                <details>
                  <summary>Changed Blocks</summary>
                  {staticAudit.changed.map((item) => (
                    <div key={item.id} className="audit-item">
                      <div>{item.title}</div>
                      <small>{item.detail}</small>
                      <button onClick={() => handleLocate(item.anchor)}>Locate</button>
                    </div>
                  ))}
                </details>
                <details>
                  <summary>Risk Alerts</summary>
                  {staticAudit.risk.map((item) => (
                    <div key={item.id} className="audit-item">
                      <div>{item.detail}</div>
                      <button onClick={() => handleLocate(item.anchor)}>Locate</button>
                    </div>
                  ))}
                </details>
              </section>
              <section>
                <h3>AI Audit</h3>
                <div className="field">
                  <label>Provider</label>
                  <input value={provider} onChange={(e) => setProvider(e.target.value)} />
                </div>
                <div className="field">
                  <label>Model</label>
                  <input value={model} onChange={(e) => setModel(e.target.value)} />
                </div>
                <div className="field">
                  <label>Rules</label>
                  <textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={4} />
                </div>
                <button onClick={handleRunAudit}>Run Audit</button>
                <button onClick={handleRunPatch}>Generate Patch</button>
                {status && <div className="status-pill">{status}</div>}
                {auditResult?.ok === false && (
                  <div className="error">
                    <div>Error: {auditResult.error}</div>
                    <pre>{auditResult.rawText}</pre>
                  </div>
                )}
                {auditResult?.data && (
                  <div className="ai-result">
                    <h4>Consensus Findings</h4>
                    {auditResult.data.consensusFindings.map((finding) => (
                      <div key={finding.id} className="audit-item">
                        <strong>{finding.claim}</strong>
                        <div>Severity: {finding.severity}</div>
                        {finding.evidence.map((ev, index) => (
                          <div key={`${finding.id}-${index}`}>
                            <small>{ev.snippet}</small>
                            <button onClick={() => handleLocate(ev.anchor)}>Locate</button>
                          </div>
                        ))}
                      </div>
                    ))}
                    <h4>Minority Report</h4>
                    {auditResult.data.minorityReport.map((item) => (
                      <div key={item.id} className="audit-item">
                        <strong>{item.who}</strong>
                        <div>{item.claim}</div>
                        {item.evidence.map((ev, index) => (
                          <button key={`${item.id}-${index}`} onClick={() => handleLocate(ev.anchor)}>
                            Locate
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </section>
              {patchPreview && (
                <section>
                  <h3>Patch Blocks</h3>
                  {patchPreview.blocksToInsert.map((block, index) => (
                    <div key={`${block.anchorHint}-${index}`} className="patch-block">
                      <div>Anchor: {block.anchorHint}</div>
                      <pre>{block.text}</pre>
                    </div>
                  ))}
                  <button onClick={handleApplyPatch}>Apply Patch</button>
                  <button onClick={handleUndoPatch} disabled={!previousCompareText}>
                    Undo Patch
                  </button>
                </section>
              )}
            </div>
          )}

          {selectedTab === "review" && (
            <div className="tab-content">
              <section>
                <h3>Review Prompt Manager</h3>
                <div className="field">
                  <label>Layer 1 (locked)</label>
                  <textarea value={LAYER1_PROMPT} readOnly rows={6} />
                </div>
                <div className="field">
                  <label>Preset</label>
                  <select value={selectedPresetId} onChange={(e) => handlePresetChange(e.target.value)}>
                    {presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                  <button onClick={handleSavePreset}>Save Preset</button>
                  <button onClick={handleRestorePresets}>Restore Default</button>
                </div>
                <div className="field">
                  <label>Layer 2 (editable)</label>
                  <textarea value={layer2} onChange={(e) => setLayer2(e.target.value)} rows={8} />
                </div>
                <div className="hint">
                  Variables: {{baseName}}, {{compareName}}, {{baseText}}, {{compareText}},
                  {{diffSummary}}, {{rules}}
                </div>
              </section>
            </div>
          )}

          {selectedTab === "debate" && (
            <div className="tab-content">
              <section>
                <h3>Debate</h3>
                <button onClick={handleRunDebate}>Run Debate</button>
                {debateResult && (
                  <div className="debate">
                    <h4>Timeline</h4>
                    {debateResult.timeline.map((entry, index) => (
                      <details key={`${entry.speaker}-${index}`}>
                        <summary>
                          Round {entry.round}: {entry.speaker}
                        </summary>
                        <pre>{JSON.stringify(entry.json, null, 2)}</pre>
                      </details>
                    ))}
                    <h4>Final Decision</h4>
                    {debateResult.final.consensusFindings.map((finding) => (
                      <div key={finding.id} className="audit-item">
                        <strong>{finding.claim}</strong>
                        {finding.evidence.map((ev, index) => (
                          <button key={`${finding.id}-${index}`} onClick={() => handleLocate(ev.anchor)}>
                            Locate
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

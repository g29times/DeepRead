# DeepRead 解释引擎统一重构任务清单

本文件用于跟踪“全文分析与概念/段落解释”统一重构工作的阶段性目标与具体任务。

## 目标概述
- 以 ExplainTask 作为统一抽象，减少全文与概念/段落解释的重复逻辑。
- 保留全文的“可选预览（人工确认）”能力；其他解释流程直接进入解释与渲染。
- 统一段落项渲染与交互（跳转/解释），复用跨上下文查找与高亮滚动。
- 为未来的多文档上下文（跨页面概念关联）预留数据结构与 UI 钩子。

---

## Phase 1：快速见效的通用化（低风险）
- [ ] 抽取 buildParagraphItems(relatedParagraphs) 通用渲染函数（兜底渲染、类名统一 .deepread-paragraph-item）
- [ ] 抽取 bindParagraphListEvents(container) 统一事件绑定（跳转/解释）
- [ ] 事件逻辑统一使用 findByIdEverywhere + highlightAndScrollTo
- [ ] showAnalysisResults 与 updateExplanationArea 同步改造，复用上述两函数
- [ ] 提供 ensurePanelVisible() 工具并在上述入口统一调用
- [ ] 验证在含 iframe/Shadow DOM 页面上相关段落的定位与兜底渲染

产出：
- 重构在 content_copy.js 上进行，确保运行可验证；主文件 content.js 保持稳定。

---

## Phase 2：ExplainTask 统一入口与调度
- [ ] 新增 explain(task: ExplainTask) 统一入口（type: 'full_page' | 'concept' | 'paragraph' | 'selection'）
- [ ] prepareContext(task)：面板可见、必要时预览、按需/延迟 addParagraphIds
- [ ] dispatchAnalysis(task)：
  - full_page → callAnalyzeContent(content)
  - concept/paragraph/selection → callExplanationConcept(term, pageContent/子上下文)
  - 统一产出 ExplainResult：{ explanation, relatedConcepts, relatedParagraphs, keyTerms?, keyParagraphs?, summary? }
- [ ] renderExplanation(task, result)：统一模板与区块结构，支持返回全文、插入对话、删除概念、概念前后切换等
- [ ] 错误与超时处理统一，fallback 规范化

---

## Phase 3：多文档上下文与概念关联（增强）
- [ ] 数据模型扩展：docId=hash(canonicalUrl)，概念历史项增加 { docId, url, senseId? }
- [ ] 概念键区分：conceptKey=hash(term)，conceptId=hash(term + docId)；后续可引入 embedding 做 sense 聚合
- [ ] UI：解释区增加“上下文范围：当前/全局”切换；全局模式显示跨文档命中来源（标题/链接）
- [ ] 跳转行为：跨文档段落的导航策略（新标签或二次确认）

---

## 验收与回归
- [ ] 典型站点（含同源 iframe、Shadow DOM）回归：
  - 全文分析 → 关键段落与相关段落定位、跳转与解释
  - 概念解释 → 相关段落定位、跳转与解释
- [ ] 极端页面回退：兜底渲染正确、跳转按钮在缺失目标时禁用或提示
- [ ] 性能：长页面 addParagraphIds 的延迟或局部打标策略评估

---

## 备注
- 重构在 content_copy.js 上进行；待稳定后再合并回 content.js。
- 样式统一：.deepread-paragraph-item 已在 CSS 中提供分隔与间距，可在需要时微调。

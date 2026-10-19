import { getModelConfig, modelChatCompletionsUrl, type ModelRole } from "../model-config";
import { modelRetryAfterMs, withModelProviderGate } from "./model-provider-gate";
import { KEYWORD_EXPANSION_GUIDANCE } from "./knowledge-search-guidance";
import { normalizeGoal, stableHash, uid, SUGGESTION_MAX_LENGTH, type CapabilityOrigin, type CapabilitySpecDoc, type CapabilitySpecScenario, type JsonSchema, type JsonValue, type KnowledgeCandidate, type ModelInvocation, type ModelInvocationStage, type OutcomeStatus, type PageSnapshot, type SceneDefinition, type SiteProfile, type TaskEpisode } from "./protocol";
import { DEFAULT_KNOWLEDGE_LOCALE, languageName, outputLanguageInstruction, type KnowledgeLocale } from "./prompt-locale";

export function explicitlyRequestsStructuredResult(goal: string) {
  return /(搜索|查询|查找|返回|提取|抽取|导出|统计|汇总|分析|对比|列出|读取.*(?:字段|数据|列表|数量)|告诉我.*(?:数量|内容|结果)|有多少|给我.*(?:数据|列表|结果))/i.test(goal);
}

export type ResultArchetype = "navigation" | "search" | "list" | "ranking" | "detail" | "action" | "analysis";

/**
 * A capability promises the useful result implied by the job, not merely what
 * the user happened to spell out with words such as “return”.  This classic
 * policy is intentionally small and deterministic; the model reviews and
 * refines it from page evidence during contract design.
 */
export function inferResultArchetype(goal: string, description = ""): ResultArchetype {
  const text = `${goal} ${description}`.normalize("NFKC").toLowerCase();
  if (/(总结|概括|分析|对比|趋势|原因|洞察|报告)/.test(text)) return "analysis";
  if (/(提交|保存|删除|收藏|订阅|购买|下单|加入|创建|修改|发送)/.test(text)) return "action";
  if (/(搜索|查询|查找|检索)/.test(text)) return "search";
  if (/(榜单|排行|排名|日榜|周榜|月榜|top\s*\d*)/.test(text)) return "ranking";
  if (/(列表|清单|记录|结果集|全部|有哪些)/.test(text)) return "list";
  if (/(详情|明细|资料|信息|走势|内容)/.test(text)) return "detail";
  return "navigation";
}

export type ModelImageInput = {
  label: string;
  dataUrl: string;
  detail?: "low" | "high";
};

export type ModelJsonFailure = {
  errorCode: string;
  attempt: number;
  httpStatus?: number;
  finishReason?: string;
  parseError?: string;
};

/** A redacted, JSON-safe model failure. It never carries prompts or provider bodies. */
export class ModelJsonError extends Error {
  readonly failure: ModelJsonFailure;

  constructor(failure: ModelJsonFailure) {
    super(failure.errorCode);
    this.name = "ModelJsonError";
    this.failure = { ...failure };
  }
}

export function modelJsonFailure(error: unknown): ModelJsonFailure | undefined {
  return error instanceof ModelJsonError ? { ...error.failure } : undefined;
}

function safeParseError(error: unknown, finishReason?: string) {
  if (finishReason === "length") return "output_truncated";
  if (error instanceof SyntaxError && /end of json|unterminated|unexpected end/i.test(error.message)) return "unexpected_end_of_json";
  return "invalid_json";
}

// Exported so sibling model features (for example effect analysis) reuse this
// JSON-mode primitive. `role` selects the model tier; `signal` preserves
// cancellation for long-running knowledge analysis.
export async function modelJson<T>(
  instruction: string,
  payload: unknown,
  timeoutMs = 180_000,
  telemetry?: {
    siteAgentId: string;
    learningJobId?: string;
    stage: ModelInvocationStage;
    record(invocation: ModelInvocation): void | Promise<void>;
  },
  role: ModelRole = "semantic",
  signal?: AbortSignal,
  images: ModelImageInput[] = [],
  options: { failureMode?: "soft" | "throw" } = {},
): Promise<T | undefined> {
  signal?.throwIfAborted();
  const config = getModelConfig(role);
  if (!config.configured) {
    if (options.failureMode === "throw") throw new ModelJsonError({ errorCode: "model_not_configured", attempt: 0 });
    return undefined;
  }
  const invocationId = uid("model_call");
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const serializedPayload = JSON.stringify(payload);
  const visualInputs = images.filter((image) => /^data:image\/(?:png|jpeg|webp);base64,/i.test(image.dataUrl)).slice(0, 6);
  const estimatedPromptTokens = Math.max(1, Math.ceil((instruction.length + serializedPayload.length) / 4) + visualInputs.length * 300);
  const record = (patch: Partial<ModelInvocation>) => telemetry?.record({ id: invocationId, siteAgentId: telemetry.siteAgentId, learningJobId: telemetry.learningJobId, stage: telemetry.stage, model: config.model, status: "running", promptTokens: estimatedPromptTokens, usageExact: false, startedAt, ...patch });
  // Persist the running edge before waiting on the provider so the capability
  // workbench can show the exact AI stage while it is happening.
  await record({ status: "running" });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const requestSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    const request = (responseFormat: boolean, maxTokens: number, thinkingDisabled: boolean) => fetch(modelChatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: maxTokens,
        ...(thinkingDisabled ? { thinking: { type: "disabled" } } : {}),
        ...(responseFormat ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: `${instruction}\n只输出一个合法 JSON 对象，不要输出 Markdown。` },
          {
            role: "user",
            content: visualInputs.length
              ? [
                { type: "text", text: serializedPayload },
                ...visualInputs.flatMap((image, index) => [
                  { type: "text", text: `证据图片 ${index + 1}：${image.label.slice(0, 160)}` },
                  { type: "image_url", image_url: { url: image.dataUrl, detail: image.detail || "low" } },
                ]),
              ]
              : serializedPayload,
          },
        ],
      }),
      signal: requestSignal,
    });
    let failure: ModelJsonFailure = { errorCode: "model_json_invalid", attempt: 0 };
    const attempts = [
      { responseFormat: true, maxTokens: 2_400, thinkingDisabled: true },
      { responseFormat: false, maxTokens: 4_800, thinkingDisabled: true },
      { responseFormat: true, maxTokens: 4_800, thinkingDisabled: true },
    ];
    let rateLimitRetries = 0;
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = index + 1;
      const option = attempts[index]!;
      await record({ status: "running", attempt });
      let response: Response;
      try {
        response = await withModelProviderGate(config, () => request(option.responseFormat, option.maxTokens, option.thinkingDisabled));
      } catch (error) {
        if (requestSignal.aborted) throw error;
        failure = { errorCode: "model_request_failed", attempt };
        continue;
      }
      if (!response.ok) {
        failure = { errorCode: `model_http_${response.status}`, httpStatus: response.status, attempt };
        if (response.status === 429) {
          if (rateLimitRetries >= 1) break;
          rateLimitRetries += 1;
          await new Promise((resolve) => setTimeout(resolve, modelRetryAfterMs(response)));
        }
        // Some OpenAI-compatible providers reject the optional `thinking`
        // request field. If the broad second request returns HTTP 400, retry
        // that shape once without the field. This request does not consume the
        // final bounded JSON parse retry.
        if (index !== 1 || response.status !== 400) continue;
        try {
          response = await withModelProviderGate(config, () => request(false, 4_800, false));
        } catch (error) {
          if (requestSignal.aborted) throw error;
          failure = { errorCode: "model_request_failed", attempt };
          continue;
        }
        if (!response.ok) {
          failure = { errorCode: `model_http_${response.status}`, httpStatus: response.status, attempt };
          continue;
        }
      }
      let body: {
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
        choices?: Array<{ finish_reason?: string; message?: { content?: string | Array<{ text?: string }> } }>;
      };
      try {
        body = await response.json() as typeof body;
      } catch {
        failure = { errorCode: "model_response_json_invalid", httpStatus: response.status, parseError: "response_body_invalid_json", attempt };
        continue;
      }
      const finishReason = body.choices?.[0]?.finish_reason;
      const content = body.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content : content?.map((item) => item.text || "").join("") || "";
      const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      const json = cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned;
      if (finishReason === "length") {
        failure = {
          errorCode: "model_json_truncated",
          httpStatus: response.status,
          finishReason,
          parseError: "output_truncated",
          attempt,
        };
        continue;
      }
      try {
        const result = JSON.parse(json) as T;
        const promptTokens = Number(body.usage?.prompt_tokens || estimatedPromptTokens);
        const completionTokens = Number(body.usage?.completion_tokens || Math.ceil(text.length / 4));
        await record({ status: "succeeded", attempt, finishReason, httpStatus: response.status, promptTokens, completionTokens, cachedPromptTokens: Number(body.usage?.prompt_cache_hit_tokens || body.usage?.prompt_tokens_details?.cached_tokens || 0), totalTokens: Number(body.usage?.total_tokens || promptTokens + completionTokens), usageExact: Boolean(body.usage), durationMs: Date.now() - started, endedAt: new Date().toISOString() });
        return result;
      } catch (error) {
        failure = {
          errorCode: finishReason === "length" ? "model_json_truncated" : "model_json_invalid",
          httpStatus: response.status,
          finishReason,
          parseError: safeParseError(error, finishReason),
          attempt,
        };
      }
    }
    await record({ status: "failed", ...failure, durationMs: Date.now() - started, endedAt: new Date().toISOString() });
    if (options.failureMode === "throw") throw new ModelJsonError(failure);
    return undefined;
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("model_request_aborted");
    }
    if (error instanceof ModelJsonError) {
      if (options.failureMode === "throw") throw error;
      return undefined;
    }
    const failure: ModelJsonFailure = {
      errorCode: requestSignal.aborted ? "model_request_timeout" : error instanceof Error ? error.name : "model_request_failed",
      attempt: 0,
    };
    await record({ status: "failed", ...failure, durationMs: Date.now() - started, endedAt: new Date().toISOString() });
    if (options.failureMode === "throw") throw new ModelJsonError(failure);
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * AI URL clustering (the general layer beyond the name/date/id heuristic — it catches
 * lowercase slugs the patterns can't). Groups a site's discovered paths into /{param}
 * families vs distinct pages. Temperature 0; returns [] when the model is unconfigured or
 * fails. The CALLER validates every proposed template (`relabelScenesByFamilies`) so a bad
 * answer is only ignored — never corrupts knowledge.
 */
/**
 * Expand a natural-language question into search keywords — the SAME expansion the runtime
 * main agent does inline at tool-call time, but as a standalone call for the console
 * diagnostic probe. Uses the shared `KEYWORD_EXPANSION_GUIDANCE` so the two never drift.
 * Returns 2–6 keywords; falls back to `[question]` when no model is configured (an honest
 * reflection that, without a model, the agent could not expand either). Never throws.
 */
/**
 * Extracts the keyword array from the model reply.
 *
 * Why tolerant: the output shape used to be hinted by **a `schema` field stuffed into
 * the input**, so the model echoed the input shape — returning
 * `{"question":"…","schema":{"keywords":[…]}}`. The keywords were expanded correctly
 * but, not being top-level, were judged "not expanded" and search silently fell back to
 * the literal sentence: the UI showed "search terms unchanged, 0 pages hit". The prompt
 * now states the output format explicitly; this is the second net: if not at the top
 * level, look one level down, and do not throw the whole expansion away over a small
 * shape deviation.
 */
export function keywordsFromModelResult(value: unknown): string[] {
  const clean = (list: unknown): string[] => (Array.isArray(list)
    ? list.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : []);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const direct = clean(record.keywords);
  if (direct.length) return direct.slice(0, 6);
  for (const nested of Object.values(record)) {
    if (!nested || typeof nested !== "object") continue;
    const found = clean((nested as Record<string, unknown>).keywords);
    if (found.length) return found.slice(0, 6);
  }
  return [];
}

export async function expandQueryKeywords(question: string): Promise<string[]> {
  const trimmed = (question || "").trim();
  if (!trimmed) return [];
  const result = await modelJson<Record<string, unknown>>(
    `${KEYWORD_EXPANSION_GUIDANCE}只输出关键词，不要解释。
输出 JSON：{"keywords":["关键词1","关键词2"]}`,
    { question: trimmed },
    20_000,
  ).catch(() => undefined);
  const keywords = keywordsFromModelResult(result);
  return keywords.length ? keywords : [trimmed];
}

export async function clusterUrlFamilies(pages: Array<{ path: string; name?: string }>, locale: KnowledgeLocale = DEFAULT_KNOWLEDGE_LOCALE): Promise<Array<{ template: string; name?: string; members: string[] }>> {
  const seen = new Set<string>();
  const unique = (pages || []).filter((page) => typeof page?.path === "string" && page.path.startsWith("/") && !seen.has(page.path) && Boolean(seen.add(page.path))).slice(0, 300);
  if (unique.length < 4) return [];
  const instruction = `你在整理一个网站的"页面类型"，输入是一批页面（path=路径，name=当前名字）。找出所有"实例类页面模板"，给每个起一个描述『整类』的通用${languageName(locale)}名，并列出属于它的输入路径。两种情况都要处理：
A) 路径已含 {参数}（如 /a/{id}、/b/{name}）——它就是一个模板，但 name 往往只是某一个具体实例。请根据它的路径和多个实例反映的共性，给一个描述整类的名字（类别名，具体依网站内容而定），不要用某个实例名。members 放该模板路径本身。
B) 若有一批只在某一段不同的相似"字面"路径（/x/aaa、/x/bbb…），归成新模板 /x/{参数} 并起通用名，members 放这些字面路径。
规则：模板第一段必须是固定词，不能是整段变量 /{x}；独立功能页（/about /search /首页 等本身不是某物的实例）不要输出。宁缺毋滥，绝不能把不同功能页合并。
输出 JSON：{"families":[{"template":"/a/{id}","name":"这一类页面的通用名","members":["/a/{path1}"]}]}
${outputLanguageInstruction(locale)}`;
  const result = await modelJson<{ families?: Array<{ template?: unknown; name?: unknown; members?: unknown }> }>(instruction, { pages: unique.map((page) => ({ path: page.path, name: page.name })) });
  if (!result || !Array.isArray(result.families)) return [];
  return result.families.flatMap((family) => typeof family.template === "string" && family.template.includes("{")
    ? [{
        template: family.template,
        name: typeof family.name === "string" && family.name.trim() ? family.name.trim().slice(0, 40) : undefined,
        members: Array.isArray(family.members) ? family.members.filter((member): member is string => typeof member === "string") : [],
      }]
    : []);
}

function textList(value: unknown, limit: number, maxLength = 120) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).map((item) => item.slice(0, maxLength)).slice(0, limit) : [];
}

/**
 * Suggested questions, kept whole.
 *
 * `textList` cuts to a character budget, and the budget that fits three Chinese
 * questions cuts an English one mid-word — which matters because the question is
 * sent verbatim as the goal when a visitor clicks it. Drop an over-long one
 * instead of truncating it.
 */
function questionList(value: unknown) {
  // Drop before taking three, or one runaway string costs a usable question its slot.
  return textList(value, Number.MAX_SAFE_INTEGER, SUGGESTION_MAX_LENGTH + 1)
    .filter((item) => item.length <= SUGGESTION_MAX_LENGTH)
    .slice(0, 3);
}

function productNameCandidates(snapshot: PageSnapshot) {
  const titleParts = snapshot.title.split(/\s[-|·—_]\s|[_|]/).map((value) => value.trim()).filter(Boolean);
  return [...new Set([
    snapshot.metadata?.applicationName,
    snapshot.metadata?.ogSiteName,
    ...(snapshot.metadata?.structuredNames || []),
    ...(snapshot.metadata?.logoAlts || []),
    ...titleParts.reverse(),
    snapshot.heading,
    new URL(snapshot.url).hostname.replace(/^www\./, ""),
  ].filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim().slice(0, 100)))].slice(0, 16);
}

function stableProductName(proposed: unknown, candidates: string[], previous?: SiteProfile) {
  if (previous?.fieldEvidence?.name?.pinned) return previous.name;
  const name = typeof proposed === "string" ? proposed.trim() : "";
  if (name && name.length <= 60 && !/[_|].{5,}|.{16,}[-—].{8,}/.test(name)) return name;
  return candidates.find((candidate) => candidate.length <= 60 && !/[_|]/.test(candidate)) || name.slice(0, 60) || "网站";
}

/**
 * Capability design needs the semantic path, not a full DOM recording.  Raw
 * ElementEvidence can contain large attribute maps and page excerpts; passing
 * it wholesale makes a small contract-design call slow and prone to provider
 * timeouts.  Full evidence remains in D1 for the Program Author.
 */
function compactExperienceForDesign(episode: TaskEpisode) {
  const experience = episode.experience;
  if (!experience) return undefined;
  return {
    actorSummary: experience.actorSummary.slice(0, 2_000),
    judgeEvidence: experience.judgeEvidence.slice(0, 12).map((item) => item.slice(0, 320)),
    actions: experience.actions.slice(-16).map((action) => ({
      action: action.action,
      rawAction: action.rawAction.slice(0, 80),
      input: Object.fromEntries(Object.entries(action.input).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 320) : value])),
      element: action.element ? {
        tag: action.element.tag,
        role: action.element.role,
        accessibleName: action.element.accessibleName?.slice(0, 200),
        href: action.element.href?.slice(0, 500),
        placeholder: action.element.placeholder?.slice(0, 160),
        landmark: action.element.landmark?.slice(0, 100),
      } : undefined,
      page: action.page,
    })),
    toolReceipts: experience.toolReceipts?.slice(-12).map((receipt) => ({
      kind: receipt.kind,
      name: receipt.name.slice(0, 120),
      status: receipt.status,
      summary: receipt.summary.slice(0, 500),
      capabilityId: receipt.capabilityId,
      output: receipt.output,
    })),
  };
}

export function siteProfileEvidenceHash(snapshot: PageSnapshot, scenes: SceneDefinition[] = []) {
  return stableHash(JSON.stringify({
    origin: new URL(snapshot.url).origin,
    metadata: snapshot.metadata,
    title: snapshot.title,
    heading: snapshot.heading,
    text: snapshot.visibleText.slice(0, 8_000),
    links: snapshot.links.slice(0, 80),
    // Only the STRUCTURE (which page types exist) — NOT review-derived name/description/
    // businessArea/evidenceStatus, which the review itself rewrites each cycle. Including
    // them made the stamp (taken over pre-review scenes) never match the check (over
    // post-review scenes), so the profile review re-queued forever. A structural change
    // (a new page type) still re-triggers it, as does any homepage-content change above.
    scenes: [...new Set(scenes.map((scene) => scene.urlTemplates[0]?.pathnamePattern).filter(Boolean))].sort(),
  }));
}

export function siteProfileNeedsSemanticReview(profile: SiteProfile, evidenceHash: string, now = Date.now(), force = false) {
  const review = profile.semanticReview;
  if (force || !review || review.evidenceHash !== evidenceHash || review.status === "pending") return true;
  return review.status === "failed" && now - Date.parse(review.attemptedAt) >= 10 * 60_000;
}

export async function analyzeSiteProfile(
  snapshot: PageSnapshot,
  previous?: SiteProfile,
  scenes: SceneDefinition[] = [],
  signal?: AbortSignal,
  locale: KnowledgeLocale = DEFAULT_KNOWLEDGE_LOCALE,
): Promise<SiteProfile | undefined> {
  // Which language the profile's own fields are written in, and which goes under
  // `localized`. The prompt used to fix these as Chinese and English respectively, so
  // an English-only site was described in Chinese however this was configured.
  const secondary: KnowledgeLocale = locale === "en" ? "zh" : "en";
  signal?.throwIfAborted();
  const config = getModelConfig("semantic");
  if (!config.configured) return undefined;
  const evidenceHash = siteProfileEvidenceHash(snapshot, scenes);
  const candidates = productNameCandidates(snapshot);
  const result = await modelJson<Record<string, unknown>>(
    `你是网站产品知识 Reviewer。经典程序已经采集可信的首方页面证据和 URL 场景；请识别真实产品名称（不是 SEO 标题）、一句话价值、服务对象、用户来这里完成的核心工作、业务实体、业务域，以及有证据支持的高价值任务模板。任务如果缺少关键词、日期、商品等参数，必须列入 requiredInputs，不能把不完整目标当作可直接执行。不要虚构未观察到的能力。上述 description、jobsToBeDone、suggestedQuestions 用${languageName(locale)}写；同时在 localized.${secondary} 里用**${languageName(secondary)}**再写一遍这三项，两边说的是同一件事，不是一方的字面翻译，而是用该语言的读者会用的说法。两边的条数与含义保持一致；人名、地区、日期、商品名等页面上的真实取值保持原样，不要翻译。 suggestedQuestions 是必填项，不得省略、不得为空数组：给出 1 到 3 条访客可以原句发送的具体问题。每条是一个完整目标，尽量带上一个在页面证据中真实出现过的取值（人名、地区、日期、商品名等），不得编造取值；不要留出待填的占位，不要写成“查询某个关键词”这类需要访客自行填空的句式。若页面证据里确实找不到可用的具体取值，就把 jobsToBeDone 里的工作改写成访客口吻的一句话作为问题，仍然不得返回空数组。`,
    {
      currentKnowledge: previous,
      productNameCandidates: candidates,
      page: { url: snapshot.url, title: snapshot.title, heading: snapshot.heading, metadata: snapshot.metadata, visibleText: snapshot.visibleText.slice(0, 8_000) },
      links: snapshot.links.slice(0, 80),
      observedScenes: scenes.slice(0, 80).map((scene) => ({ path: scene.urlTemplates[0]?.pathnamePattern, name: scene.name, description: scene.description, businessArea: scene.businessArea, evidenceStatus: scene.evidenceStatus || scene.lifecycle })),
      schema: {
        name: "真实产品名称", description: "一句话说明产品帮谁解决什么问题", category: "业务分类",
        audiences: ["目标用户"], jobsToBeDone: ["用户要完成的工作"],
        suggestedQuestions: ["访客可以原句发送的具体问题，带页面证据中真实出现过的取值"],
        localized: { [secondary]: { description: `the same one-line value, in ${secondary === "en" ? "English" : "Chinese"}`, jobsToBeDone: ["the same jobs"], suggestedQuestions: ["the same questions"] } },
        entityTypes: [{ name: "业务实体", description: "含义", examples: ["页面证据中的例子"] }],
        businessDomains: [{ name: "稳定业务域", description: "范围" }], vocabulary: { term: ["aliases"] },
      },
    },
    180_000,
    undefined,
    "semantic",
    signal,
  );
  signal?.throwIfAborted();
  const attemptedAt = new Date().toISOString();
  if (!result || typeof result.description !== "string") return previous ? { ...previous, semanticReview: { status: "failed", evidenceHash, model: config.model, attemptedAt } } : undefined;
  const name = stableProductName(result.name, candidates, previous);
  const audiences = textList(result.audiences, 8);
  const jobs = textList(result.jobsToBeDone, 10, 180);
  const suggestedQuestions = questionList(result.suggestedQuestions);
  // The same three fields written for a reader of the other language. Absent or
  // unusable, the site simply has nothing in that language yet and its readers
  // get the built-in sentences rather than ones they cannot read.
  const localized = (() => {
    const raw = result.localized && typeof result.localized === "object" ? result.localized as Record<string, unknown> : {};
    const written = raw[secondary] && typeof raw[secondary] === "object" ? raw[secondary] as Record<string, unknown> : undefined;
    if (!written) return previous?.localized;
    const description = typeof written.description === "string" ? written.description.trim().slice(0, 300) : "";
    const entry = {
      description,
      jobsToBeDone: textList(written.jobsToBeDone, 10, 180),
      suggestedQuestions: questionList(written.suggestedQuestions),
    };
    if (!entry.description && !entry.jobsToBeDone.length && !entry.suggestedQuestions.length) return previous?.localized;
    return { ...(previous?.localized || {}), [secondary]: entry };
  })();
  const entityTypes = Array.isArray(result.entityTypes) ? result.entityTypes.flatMap((item) => item && typeof item === "object" ? [{ name: String((item as Record<string, unknown>).name || "").slice(0, 80), description: String((item as Record<string, unknown>).description || "").slice(0, 200), examples: textList((item as Record<string, unknown>).examples, 8, 80) }] : []).filter((item) => item.name).slice(0, 16) : [];
  const businessDomains = Array.isArray(result.businessDomains) ? result.businessDomains.flatMap((item) => item && typeof item === "object" ? [{ name: String((item as Record<string, unknown>).name || "").slice(0, 80), description: String((item as Record<string, unknown>).description || "").slice(0, 200) }] : []).filter((item) => item.name).slice(0, 10) : [];
  const evidence = [snapshot.metadata?.applicationName, snapshot.metadata?.ogSiteName, snapshot.heading, snapshot.title, snapshot.url].filter((value): value is string => Boolean(value)).slice(0, 8);
  const fieldEvidence = { ...(previous?.fieldEvidence || {}) };
  for (const field of ["name", "description", "category", "audiences", "jobsToBeDone", "suggestedQuestions", "localized", "entityTypes", "businessDomains"]) {
    if (fieldEvidence[field]?.pinned) continue;
    fieldEvidence[field] = { source: "ai", confidence: field === "name" ? 0.9 : 0.78, evidence, updatedAt: attemptedAt };
  }
  // entryUrl feeds live navigation and must be same-origin as the crawl — the crawl-document
  // validator (assertDocumentUrlsSameOrigin) rejects the WHOLE document on any cross-origin URL.
  // A site's <link rel=canonical> legitimately points at another host (e.g. a www apex), so never
  // adopt it — or a stale previous entryUrl — unless it matches the crawl origin.
  const crawlOrigin = new URL(snapshot.url).origin;
  const sameOriginEntry = (candidate: string | undefined) => {
    if (!candidate) return undefined;
    try { return new URL(candidate).origin === crawlOrigin ? candidate : undefined; } catch { return undefined; }
  };
  return {
    ...previous,
    name,
    description: result.description.trim().slice(0, 300),
    // Which language the fields above are in, so a reader asking for this one gets them
    // rather than the built-in sentences, and anything choosing a language can tell.
    language: locale,
    semanticSource: "ai",
    entryUrl: sameOriginEntry(previous?.entryUrl) || sameOriginEntry(snapshot.metadata?.canonicalUrl) || crawlOrigin,
    category: typeof result.category === "string" ? result.category.trim().slice(0, 80) : previous?.category,
    audiences,
    jobsToBeDone: jobs,
    suggestedQuestions,
    ...(localized ? { localized } : {}),
    entityTypes,
    businessDomains,
    vocabulary: result.vocabulary && typeof result.vocabulary === "object" ? Object.fromEntries(Object.entries(result.vocabulary as Record<string, unknown>).slice(0, 30).map(([key, values]) => [key.slice(0, 60), textList(values, 10, 80)])) : previous?.vocabulary || {},
    taskTemplates: previous?.taskTemplates || [],
    suggestedGoals: previous?.suggestedGoals || [],
    fieldEvidence,
    semanticReview: { status: "reviewed", evidenceHash, model: config.model, attemptedAt, reviewedAt: attemptedAt },
  };
}

export function sceneSemanticEvidenceHash(scene: SceneDefinition) {
  return stableHash(JSON.stringify({
    path: scene.urlTemplates[0]?.pathnamePattern,
    query: scene.urlTemplates[0]?.query,
    evidence: scene.evidence,
    parameters: scene.parameters.map((parameter) => ({ id: parameter.id, examples: parameter.examples })),
  }));
}

export function sceneNeedsSemanticReview(scene: SceneDefinition, now = Date.now(), force = false) {
  const evidenceStatus = scene.evidenceStatus || scene.lifecycle;
  // A link reference is useful topology evidence, but it is not a page the AI
  // has seen. Reviewing it would either hallucinate business semantics or sit
  // forever in a misleading "AI pending" state. It becomes reviewable as soon
  // as a real connection contributes URL/title/heading evidence.
  if (evidenceStatus === "referenced" && !scene.evidence?.observedUrls.length) return false;
  // A crawled page that the crawl pipeline's own AI pass ALREADY named/classified
  // (semanticSource ai|human) stays out of the usage review queue until real usage
  // promotes it to `observed` — keeping the two pipelines' AI budgets separate. But a
  // crawled page still carrying its raw program name (e.g. the crawl ran with no model,
  // or the page didn't cluster into a named family) DOES need review: otherwise it is
  // stuck showing its raw <title> and has no businessArea, so the topology falls back to
  // an ugly title-derived area name. Summarize those.
  if (evidenceStatus === "crawled" && scene.semanticSource !== "program" && !force) return false;
  const review = scene.semanticReview;
  const evidenceHash = sceneSemanticEvidenceHash(scene);
  if (force || !review || review.evidenceHash !== evidenceHash || review.status === "pending") return true;
  return review.status === "failed" && now - Date.parse(review.attemptedAt) >= 10 * 60_000;
}

/**
 * Deterministic category name for a parameterized family from its instance titles: the
 * shared tail after the varying instance part (周润发微博热搜记录…, 章若楠微博热搜记录… ->
 * 微博热搜记录). The review model tends to echo — or even hallucinate — one instance name
 * for a family; this shared-tail extraction is a reliable, never-an-instance override.
 */
export function commonCategoryName(samples: string[]): string | undefined {
  // The category descriptor lives in a title's leading segment, before any " - ",
  // " | ", or "_" descriptor/brand tail (e.g. "周润发微博热搜记录 - 上榜次数…").
  const firstSegment = (sample: string) => sample.split(/\s[-|·—]\s|[|｜]|_/)[0].trim();
  const cleaned = [...new Set(samples.map(firstSegment).filter((sample) => sample.length >= 2))];
  if (cleaned.length < 2) return undefined;
  // The MAJORITY shared tail — robust to a few odd titles (error pages, alternate
  // phrasings) that would collapse an all-samples common suffix to nothing.
  const need = Math.max(2, Math.ceil(cleaned.length * 0.6));
  const freq = new Map<string, number>();
  for (const sample of cleaned) {
    const seen = new Set<string>();
    for (let length = 3; length <= Math.min(sample.length, 20); length += 1) seen.add(sample.slice(sample.length - length));
    for (const suffix of seen) freq.set(suffix, (freq.get(suffix) || 0) + 1);
  }
  let best: string | undefined;
  for (const [suffix, count] of freq) if (count >= need && (!best || suffix.length > best.length)) best = suffix;
  if (!best) return undefined;
  best = best.replace(/^[的了在与和·\-\s，,、。日号期第：:_]+/, "").trim();
  // A category name is a noun phrase; list/sentence punctuation means we captured a
  // descriptive SEO tail ("…微博热搜历史、热度趋势与相关事件"), not a name — leave it to AI.
  if (/[、，。？?！!：:]/.test(best)) return undefined;
  return best.length >= 3 && best.length <= 20 ? best : undefined;
}

/**
 * The descriptor token from a title's SECOND segment (after " - "/" | "/"_", up to the
 * first list separator): "重庆相关微博热搜 - 城市事件、热度…" -> "城市事件". Used only to
 * tell apart two families whose leading segments collapsed to the same generic name.
 */
export function categoryDescriptor(samples: string[]): string | undefined {
  const tokens = samples
    .map((sample) => (sample.split(/\s[-|·—]\s|[|｜]|_/)[1] || "").split(/[、，,。]/)[0].trim())
    .filter((token) => token.length >= 2 && !/[？?！!：:]/.test(token));
  if (tokens.length < 2) return undefined;
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  const [best, count] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0] || [];
  return best && count >= Math.max(2, Math.ceil(tokens.length * 0.6)) ? best : undefined;
}

export async function reviewSceneSemantics(snapshot: PageSnapshot, scenes: SceneDefinition[], knownBusinessAreas: string[] = [], locale: KnowledgeLocale = DEFAULT_KNOWLEDGE_LOCALE): Promise<SceneDefinition[]> {
  if (!scenes.length) return scenes;
  const config = getModelConfig("semantic");
  if (!config.configured) return scenes;
  const reviews = new Map<string, { id?: string; name?: string; description?: string; businessArea?: string; parameters?: Record<string, string> }>();
  for (let index = 0; index < scenes.length; index += 24) {
    const batch = scenes.slice(index, index + 24);
    const result = await modelJson<{ scenes?: Array<{ id?: string; name?: string; description?: string; businessArea?: string; parameters?: Record<string, string> }> }>(
      `你是网站业务拓扑 Reviewer。程序已经确定 Scene 候选的 URL 身份和样本证据。为每个 Scene 生成稳定、面向业务的${languageName(locale)}名称、业务说明、所属业务域和参数语义。优先复用已有业务域，整站通常控制在 3-8 个稳定分组；全站帮助、条款等归入同一治理类业务域。不得新增、删除、合并 Scene 或改变 URL 身份，不得把链接存在推断成页面已经访问，也不得虚构证据中没有的功能。名称不要使用 search详情、path1 等技术词。关键：当 Scene 的 path 含参数（parameters.examples 里是多个不同的实例值）时，它是『一整类共用同一模板的实例页面』，不是某一个实例。请依据这个 Scene 自己的页面证据（title/heading/正文、以及多个 examples 反映的共性）判断这一类页面在讲什么，用一个描述『整类』的名称；绝不能拿其中某一个实例的名字当作这一类的名字。`,
      {
        page: { url: snapshot.url, title: snapshot.title, heading: snapshot.heading, visibleText: snapshot.visibleText.slice(0, 6_000) },
        links: snapshot.links.slice(0, 80),
        knownBusinessAreas: [...new Set(knownBusinessAreas)].slice(0, 12),
        scenes: batch.map((scene) => {
          const parameterized = (scene.urlTemplates[0]?.pathnamePattern || "").includes("{");
          return {
            id: scene.id,
            // A parameterized scene's current name is one instance (e.g. "Angelababy热搜记录"),
            // which anchors the model into keeping it. Withhold it for templates so the model
            // names the CLASS from the path + the multiple examples + page evidence, not the name.
            ...(parameterized ? {} : { currentName: scene.name }),
            path: scene.urlTemplates[0]?.pathnamePattern,
            query: scene.urlTemplates[0]?.query,
            evidenceStatus: scene.evidenceStatus || scene.lifecycle,
            evidence: scene.evidence,
            parameters: scene.parameters.map((parameter) => ({ id: parameter.id, examples: parameter.examples })),
          };
        }),
        schema: { scenes: [{ id: "existing scene id", name: "business name", description: "business purpose", businessArea: "stable business area", parameters: { parameterId: "semantic name" } }] },
      },
      180_000,
    );
    for (const review of result?.scenes || []) if (typeof review.id === "string") reviews.set(review.id, review);
  }
  const attemptedAt = new Date().toISOString();
  // Deterministic category names for parameterized families (from titles) — the model
  // echoes/hallucinates one instance ("Angelababy热搜记录"), so name the family from the
  // shared tail of its instance titles (从头介入). Then disambiguate any two families that
  // collapsed to the same generic name via the title's descriptor segment (city vs
  // country both "相关微博热搜" -> "城市事件" / "国家地区事件").
  const categoryByScene = new Map<string, string>();
  for (const scene of scenes) {
    if (!(scene.urlTemplates[0]?.pathnamePattern || "").includes("{")) continue;
    const category = commonCategoryName(scene.evidence?.titles || []);
    if (category) categoryByScene.set(scene.id, category);
  }
  const nameCounts = new Map<string, number>();
  for (const name of categoryByScene.values()) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  for (const [id, name] of categoryByScene) {
    if ((nameCounts.get(name) || 0) < 2) continue;
    const scene = scenes.find((item) => item.id === id);
    const descriptor = scene && categoryDescriptor(scene.evidence?.titles || []);
    if (descriptor && descriptor !== name) categoryByScene.set(id, descriptor);
  }
  return scenes.map((scene) => {
    const review = reviews.get(scene.id);
    const evidenceHash = sceneSemanticEvidenceHash(scene);
    const categoryName = categoryByScene.get(scene.id);
    if (!review) {
      return categoryName
        ? { ...scene, name: categoryName, semanticSource: "ai", semanticReview: { status: "reviewed", evidenceHash, model: config.model, attemptedAt, reviewedAt: attemptedAt } }
        : { ...scene, semanticReview: { status: "failed", evidenceHash, model: config.model, attemptedAt } };
    }
    const name = review.name?.trim().slice(0, 100);
    const description = review.description?.trim().slice(0, 300);
    const accepted = Boolean(name && description);
    const reviewed = accepted || Boolean(categoryName);
    return {
      ...scene,
      name: categoryName || name || scene.name,
      description: description || scene.description,
      businessArea: review.businessArea?.trim().slice(0, 80) || scene.businessArea,
      semanticSource: reviewed ? "ai" : scene.semanticSource || "program",
      semanticReview: { status: reviewed ? "reviewed" : "failed", evidenceHash, model: config.model, attemptedAt, reviewedAt: reviewed ? attemptedAt : undefined },
      parameters: scene.parameters.map((parameter) => ({ ...parameter, name: review.parameters?.[parameter.id]?.trim().slice(0, 80) || parameter.name })),
    };
  });
}

/**
 * P2 · Capability requirement design. Produces a human-readable requirement document
 * (intent + when-to-use + narrative I/O + acceptance scenarios + non-goals)
 * rather than an IDL-like hard contract. The machine-readable `projected`
 * schema is a hint the authoring agent may tighten, and `projected.resultFields`
 * feeds the deterministic submit gate (core fields must be truly produced).
 */
export async function designCapabilitySpec(
  episode: TaskEpisode,
  candidate: { siteAgentId: string; capability?: { description?: string } },
  context: { siteAgentId: string; projectId: string; revisionId: string; existingIntents?: Array<{ intentKey: string; name: string; goalTemplate?: string }>; telemetry?: { learningJobId?: string; record(invocation: ModelInvocation): void | Promise<void> } },
): Promise<CapabilitySpecDoc | undefined> {
  const result = await modelJson<{
    intent?: string;
    whenToUse?: string;
    inputsNarrative?: string;
    resultNarrative?: string;
    scenarios?: Array<{ title?: string; given?: string; when?: string; then?: string; sampleInput?: Record<string, JsonValue>; expectedOutcome?: string }>;
    nonGoals?: string[];
    openQuestions?: string[];
    intentKey?: string;
    reuseDecision?: "create" | "strengthen" | "conversation-only";
    resultFields?: Array<{ id?: string; name?: string; type?: string; description?: string; source?: string; importance?: "core" | "optional" | "metadata" }>;
  }>(
    "你是 SiteAgent 的能力产品设计师，写一份简短、可读、可验收的需求文档，而不是强约束的 IDL。文档面向人类阅读，用于对齐这项能力到底承诺给用户什么。要点：intent 用一句话说清用户最终获得什么；whenToUse 说清何时应触发该能力、何时不应；inputsNarrative 用自然语言描述需要哪些输入及来源，不要写 JSON schema；resultNarrative 描述返回的业务结果形态（例如“返回榜单前 N 条，每条含排名、名称与核心指标”），搜索/查询/榜单/列表/详情/分析类目标即使用户没说“返回”也必须承诺返回业务数据；scenarios 给 2-4 个 Given/When/Then 验收场景，覆盖主路径与至少一个边界（无结果或被业务拒绝），sampleInput 用真实证据里的值，expectedOutcome ∈ success/no-result/business-rejection；nonGoals 明确不做什么以防范围蔓延；openQuestions 列出仍需人工澄清的问题（没有则空数组）。projected 是可选的机器投影：resultFields 每项标 importance=core|optional|metadata，core 是回答目标不可缺少、必须能从真实页面或输入证明的字段。所有内容必须基于给定证据，不得臆造。",
    {
      goal: episode.goal,
      input: episode.input,
      start: { url: episode.startSnapshot.url, heading: episode.startSnapshot.heading },
      end: { url: episode.endSnapshot.url, heading: episode.endSnapshot.heading },
      experience: compactExperienceForDesign(episode),
      existingIntents: context.existingIntents || [],
      schema: {
        intent: "一句话：用户最终获得什么",
        whenToUse: "何时应触发 / 何时不应",
        inputsNarrative: "自然语言描述输入与来源",
        resultNarrative: "自然语言描述返回的业务结果形态",
        scenarios: [{ title: "场景名", given: "前置条件", when: "用户动作/输入", then: "可观察的结果", sampleInput: { field: "真实证据值" }, expectedOutcome: "success | no-result | business-rejection" }],
        nonGoals: ["明确不做的事"],
        openQuestions: ["仍需澄清的问题"],
        intentKey: "稳定 snake_case 意图标识；相同意图复用 existingIntents",
        reuseDecision: "create | strengthen | conversation-only",
        resultFields: [{ id: "稳定英文字段", name: "字段名", type: "string|number|boolean|object|array", description: "含义", source: "page-url|page-title|page-heading|input|extracted", importance: "core|optional|metadata" }],
      },
    },
    180_000,
    context.telemetry ? { siteAgentId: context.siteAgentId, learningJobId: context.telemetry.learningJobId, stage: "capability-design", record: context.telemetry.record } : undefined,
  );
  if (!result) return undefined;
  const now = new Date().toISOString();
  const clampOutcome = (value: string | undefined): OutcomeStatus | undefined => value === "success" || value === "no-result" || value === "business-rejection" || value === "execution-fault" || value === "unknown" ? value : undefined;
  const scenarios: CapabilitySpecScenario[] = (result.scenarios || []).slice(0, 6).flatMap((scenario, index) => {
    const title = scenario.title?.trim().slice(0, 120);
    const given = scenario.given?.trim().slice(0, 400);
    const when = scenario.when?.trim().slice(0, 400);
    const then = scenario.then?.trim().slice(0, 400);
    if (!title || !given || !when || !then) return [];
    return [{ id: `scenario_${index + 1}`, title, given, when, then, sampleInput: scenario.sampleInput && typeof scenario.sampleInput === "object" ? scenario.sampleInput : undefined, expectedOutcome: clampOutcome(scenario.expectedOutcome) }];
  });
  const resultFields = (result.resultFields || []).flatMap((field) => {
    const id = field.id?.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
    if (!id) return [];
    const type = field.type === "number" || field.type === "boolean" || field.type === "object" || field.type === "array" ? field.type : "string";
    const source = field.source === "page-url" || field.source === "page-title" || field.source === "page-heading" || field.source === "input" ? field.source : "extracted";
    const importance = field.importance === "optional" || field.importance === "metadata" ? field.importance : "core";
    return [{ id, name: field.name?.trim().slice(0, 80) || id, type: type as "string" | "number" | "boolean" | "object" | "array", description: field.description?.trim().slice(0, 240), source: source as "page-url" | "page-title" | "page-heading" | "input" | "extracted", importance: importance as "core" | "optional" | "metadata" }];
  }).slice(0, 12);
  const intent = result.intent?.trim().slice(0, 400) || candidate.capability?.description || episode.goal;
  return {
    id: uid("spec_doc"),
    siteAgentId: context.siteAgentId,
    projectId: context.projectId,
    revisionId: context.revisionId,
    version: 1,
    intent,
    whenToUse: result.whenToUse?.trim().slice(0, 600) || `当用户想要「${intent}」时使用。`,
    inputsNarrative: result.inputsNarrative?.trim().slice(0, 800) || "无需额外输入。",
    resultNarrative: result.resultNarrative?.trim().slice(0, 800) || "返回任务完成状态与目标页面身份。",
    scenarios,
    nonGoals: (result.nonGoals || []).map((item) => String(item).trim().slice(0, 240)).filter(Boolean).slice(0, 8),
    openQuestions: (result.openQuestions || []).map((item) => String(item).trim().slice(0, 240)).filter(Boolean).slice(0, 8),
    projected: {
      resultFields: resultFields.length ? resultFields : undefined,
      intentKey: result.intentKey?.trim().replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 80) || undefined,
      reuseDecision: result.reuseDecision === "strengthen" || result.reuseDecision === "conversation-only" ? result.reuseDecision : "create",
    },
    source: "ai",
    createdAt: now,
    updatedAt: now,
  };
}

export async function designCapabilityContract(
  episode: TaskEpisode,
  candidate: KnowledgeCandidate,
  context: { existingIntents?: Array<{ intentKey: string; capabilityId?: string; origin?: CapabilityOrigin; name: string; goalTemplate?: string }>; telemetry?: { learningJobId?: string; record(invocation: ModelInvocation): void | Promise<void> } } = {},
): Promise<KnowledgeCandidate | undefined> {
  if (episode.outcome.status !== "success") return undefined;
  const result = await modelJson<{
    capabilityName?: string;
    capabilityDescription?: string;
    aliases?: string[];
    operationName?: string;
    goalTemplate?: string;
    intentKey?: string;
    capabilityKind?: "navigation" | "task";
    reusableTrace?: boolean;
    authoringReason?: string;
    requiredInputs?: Array<{ id?: string; name?: string; type?: string; value?: string | number | boolean; examples?: Array<string | number | boolean> }>;
    resultFields?: Array<{ id?: string; name?: string; type?: string; description?: string; source?: string; inputId?: string; importance?: "core" | "optional" }>;
    resultArchetype?: ResultArchetype;
    parameterizationDecisions?: Array<{ observedValue?: string | number | boolean; evidence?: string; decision?: string; inputId?: string; reason?: string }>;
    reuseDecision?: "create-capability" | "strengthen-capability" | "do-not-persist";
    reuseReason?: string;
    assessmentFactors?: Array<{ label?: string; evidence?: string }>;
  }>(
    "你是 SiteAgent 的能力架构师。先判断本次已经成功完成的用户任务是否值得沉淀为所有用户可复用的共享能力。只在目标可重复、具体值可参数化、结果可稳定验证且具有跨用户业务价值时创建或增强能力；个人化的一次性请求、偶然页面状态、无法安全重放、无法验证结果或只适合当前任务的需求必须使用 do-not-persist。已有 Intent 已表达相同目标时必须使用 strengthen-capability 并复用 intentKey，禁止为每次用户回答线性新增函数。assessmentFactors 给出 2-5 条面向管理员的简短判断依据，只陈述可核验信号与结论，不输出隐藏推理过程。一次用户成功路径只是证据，不等于通用函数。若值得沉淀，请一次性设计完整 CapabilityDraft：稳定 Intent、目标模板、输入、结果形态、核心返回值、可选返回值、合法结果和参数化决策。Capability 表达用户最终获得什么，Operation 才表达点击或导航。只有纯粹“打开/进入某页面”且不隐含查询、榜单、详情、分析或业务动作时才使用 navigation/page。搜索、查询、榜单、列表、详情、总结和分析必须自动返回完成任务所需的业务数据，即使用户没有明确说“返回”。字段必须能从真实页面或输入中证明，不得臆造。像“第三个结果”这样的具体序号必须生成 rank:number 输入，不能固化为单次路径。",
    {
      goal: episode.goal,
      input: episode.input,
      start: { url: episode.startSnapshot.url, heading: episode.startSnapshot.heading },
      end: { url: episode.endSnapshot.url, heading: episode.endSnapshot.heading },
      experience: compactExperienceForDesign(episode),
      observedUrls: { start: episode.startSnapshot.url, end: episode.endSnapshot.url },
      existingIntents: context.existingIntents || [],
      schema: {
        intentKey: "稳定的 snake_case 业务意图标识；相同意图复用 existingIntents",
        capabilityKind: "navigation 或 task",
        capabilityName: "稳定、参数无关的函数名称",
        capabilityDescription: "用户得到的结果",
        aliases: ["自然语言别名"],
        operationName: "稳定操作名",
        goalTemplate: "包含 {inputId} 的通用目标",
        requiredInputs: [{ id: "英文或拼音字段", name: "业务字段名", type: "string|number|boolean", value: "本次目标中的具体值", examples: ["只能来自页面或历史证据的替代值"] }],
        resultArchetype: "navigation | search | list | ranking | detail | action | analysis",
        resultFields: [{ id: "稳定英文字段", name: "返回字段名", type: "string|number|boolean|object|array", description: "字段含义", source: "extracted|input", inputId: "仅 source=input 时填写", importance: "core|optional" }],
        parameterizationDecisions: [{ observedValue: "经验中的具体值", evidence: "它出现在哪段真实证据", decision: "input|scene-ref|previous-output|constant|reject", inputId: "decision=input 时对应字段", reason: "为什么这样处理" }],
        reusableTrace: false,
        authoringReason: "为何可复用，或为何需要独立浏览器重新设计",
        reuseDecision: "create-capability | strengthen-capability | do-not-persist",
        reuseReason: "为何应该或不应该沉淀为共享能力",
        assessmentFactors: [{ label: "可复用性|参数化|稳定性|业务价值|安全性", evidence: "来自本次成功证据的简短判断依据" }],
      },
    },
    180_000,
    context.telemetry ? { siteAgentId: candidate.siteAgentId, learningJobId: context.telemetry.learningJobId, stage: "capability-design", record: context.telemetry.record } : undefined,
  );
  if (!result) return undefined;
  const capabilityName = result.capabilityName?.trim().slice(0, 120) || candidate.capability.name;
  const inputEvidenceCorpus = [episode.goal, JSON.stringify(episode.input)]
    .join("\n").normalize("NFKC").toLowerCase();
  let requiredInputs: NonNullable<NonNullable<KnowledgeCandidate["authoring"]>["requiredInputs"]> = (result.requiredInputs || []).flatMap((field) => {
    const id = field.id?.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
    if (!id) return [];
    const type: "string" | "number" | "boolean" = field.type === "number" || field.type === "boolean" ? field.type : "string";
    // Inputs may originate only in the goal or explicit invocation input.
    // Result-page values are output evidence, never reverse-engineered inputs.
    const evidenced = (value: string | number | boolean | undefined) => value !== undefined && inputEvidenceCorpus.includes(String(value).normalize("NFKC").toLowerCase());
    const rawObservedValue = evidenced(field.value) ? field.value : episode.input[id];
    const observedValue = typeof rawObservedValue === type ? rawObservedValue as string | number | boolean : undefined;
    const examples = (field.examples || []).filter(evidenced).filter((value) => value !== observedValue).slice(0, 5);
    return [{ id, name: field.name?.trim().slice(0, 80) || id, type, value: observedValue, examples }];
  }).slice(0, 6);
  const ordinal = episode.goal.match(/第\s*([一二三四五六七八九十\d]+)\s*(个|条|名|项)/);
  if (ordinal && !requiredInputs.some((field) => field.id === "rank")) {
    const chinese = "零一二三四五六七八九十";
    const raw = ordinal[1];
    const rank = /^\d+$/.test(raw) ? Number(raw) : raw === "十" ? 10 : raw.startsWith("十") ? 10 + chinese.indexOf(raw[1]) : raw.endsWith("十") ? chinese.indexOf(raw[0]) * 10 : raw.includes("十") ? chinese.indexOf(raw[0]) * 10 + chinese.indexOf(raw.at(-1)!) : chinese.indexOf(raw);
    if (Number.isFinite(rank) && rank > 0) requiredInputs = [...requiredInputs, { id: "rank", name: "榜单序号", type: "number" as const, value: rank, examples: [] }].slice(0, 6);
  }
  const dateCorpus = `${episode.goal} ${JSON.stringify(episode.input)}`.normalize("NFKC");
  const fullDate = dateCorpus.match(/(?:^|[^\d])(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|号)?(?:[^\d]|$)/);
  const shortDate = dateCorpus.match(/(?:^|[^\d])(\d{2})年(\d{1,2})月(\d{1,2})(?:日|号)(?:[^\d]|$)/);
  const observedDate = fullDate || shortDate;
  if (observedDate && !requiredInputs.some((field) => field.id === "date")) {
    const year = observedDate === shortDate ? 2000 + Number(observedDate[1]) : Number(observedDate[1]);
    const date = `${year.toString().padStart(4, "0")}-${Number(observedDate[2]).toString().padStart(2, "0")}-${Number(observedDate[3]).toString().padStart(2, "0")}`;
    requiredInputs = [...requiredInputs, { id: "date", name: "日期（YYYY-MM-DD）", type: "string" as const, value: date, examples: [] }].slice(0, 6);
  }
  const inputSchema: JsonSchema = {
    type: "object" as const,
    properties: Object.fromEntries(requiredInputs.map((field) => {
      const examples = [field.value, ...(field.examples || [])].filter((value): value is string | number | boolean => value !== undefined).slice(0, 5);
      const dateLike = field.type === "string" && /(?:^date$|日期|年月日|yyyy)/i.test(`${field.id} ${field.name}`);
      return [field.id, {
        type: field.type,
        description: field.name,
        ...(dateLike ? { format: "date" as const } : {}),
        ...(examples.length ? { examples } : {}),
      } satisfies JsonSchema];
    })),
    required: requiredInputs.map((field) => field.id),
  };
  const inferredArchetype = inferResultArchetype(episode.goal, `${capabilityName} ${result.capabilityDescription || ""}`);
  const proposedArchetype = (["navigation", "search", "list", "ranking", "detail", "action", "analysis"] as const).includes(result.resultArchetype as ResultArchetype)
    ? result.resultArchetype as ResultArchetype
    : inferredArchetype;
  // The model may under-specify a business task as navigation.  A deterministic
  // semantic floor prevents searches, rankings and detail reads from silently
  // degrading into a pageUrl/pageTitle-only capability.
  const resultArchetype = inferredArchetype !== "navigation" && proposedArchetype === "navigation" ? inferredArchetype : proposedArchetype;
  const needsBusinessResult = resultArchetype !== "navigation";
  const requestedResultFields = result.resultFields || [];
  let resultFields = requestedResultFields.flatMap((field) => {
    const id = field.id?.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
    // Page identity is runtime metadata.  It never counts as the business
    // payload promised by a search/list/ranking/detail capability.
    if (!id || id.startsWith("__") || ["pageUrl", "pageTitle", "pageHeading"].includes(id)) return [];
    const type = ["string", "number", "boolean", "object", "array"].includes(String(field.type)) ? field.type as "string" | "number" | "boolean" | "object" | "array" : "string";
    const source = field.source === "input" && requiredInputs.some((input) => input.id === (field.inputId || id)) ? "input" as const : "extracted" as const;
    const importance = field.importance === "optional" ? "optional" as const : "core" as const;
    return [{ id, name: field.name?.trim().slice(0, 80) || id, type, description: field.description?.trim().slice(0, 180), source, inputId: source === "input" ? field.inputId || id : undefined, importance }];
  }).slice(0, 8);
  if (needsBusinessResult && !resultFields.some((field) => field.importance === "core")) {
    const defaults: Record<Exclude<ResultArchetype, "navigation">, typeof resultFields> = {
      search: [{ id: "items", name: "搜索结果", type: "array", description: "与查询条件匹配的主要结果", source: "extracted", inputId: undefined, importance: "core" }, { id: "totalCount", name: "结果数量", type: "number", description: "页面显示的匹配结果数量", source: "extracted", inputId: undefined, importance: "optional" }],
      list: [{ id: "items", name: "列表内容", type: "array", description: "页面中的主要业务条目", source: "extracted", inputId: undefined, importance: "core" }],
      ranking: [{ id: "items", name: "榜单条目", type: "array", description: "包含排名、名称和核心指标的榜单条目", source: "extracted", inputId: undefined, importance: "core" }, { id: "totalCount", name: "榜单数量", type: "number", description: "榜单条目总数", source: "extracted", inputId: undefined, importance: "optional" }],
      detail: [{ id: "details", name: "详情信息", type: "object", description: "目标实体在页面中的关键业务信息", source: "extracted", inputId: undefined, importance: "core" }],
      action: [{ id: "status", name: "执行状态", type: "string", description: "业务动作完成后的状态或拒绝原因", source: "extracted", inputId: undefined, importance: "core" }],
      analysis: [{ id: "sourceData", name: "分析依据", type: "array", description: "支撑总结或分析的完整结构化业务数据", source: "extracted", inputId: undefined, importance: "core" }],
    };
    resultFields = defaults[resultArchetype as Exclude<ResultArchetype, "navigation">];
  }
  // A search/query/list/analysis promise is not honestly fulfilled by merely
  // returning the URL of its result page.  Keep it out of Release until the
  // author has grounded at least one real business field and extraction proof.
  if (needsBusinessResult && !resultFields.some((field) => field.importance === "core")) return undefined;
  const completeResultFields: NonNullable<KnowledgeCandidate["authoring"]>["resultFields"] = [
    ...resultFields,
    ...(!resultFields.some((field) => field.id === "pageUrl") ? [{ id: "pageUrl", name: "结果页面", type: "string" as const, description: "完成目标后的页面地址", source: "page-url" as const, importance: "metadata" as const }] : []),
    ...(!resultFields.some((field) => field.id === "pageTitle") ? [{ id: "pageTitle", name: "页面标题", type: "string" as const, description: "完成目标后的页面标题", source: "page-title" as const, importance: "metadata" as const }] : []),
  ];
  const outputSchema: JsonSchema = {
    type: "object",
    properties: Object.fromEntries(completeResultFields.map((field) => [field.id, { type: field.type, description: field.description || field.name } satisfies JsonSchema])),
    // Page identity remains useful runtime metadata, but it is not part of a
    // business capability's required data promise.
    required: completeResultFields.filter((field) => field.importance === "core").map((field) => field.id),
  };
  const businessResultIntent = /(搜索|查询|查找|榜|列表|详情|结果|分析|对比|数据|记录|趋势|报告)/.test(`${capabilityName}${result.capabilityDescription || ""}`);
  const capabilityKind = result.capabilityKind === "navigation" && !businessResultIntent ? "navigation" as const : "task" as const;
  const parameterizationDecisions = (result.parameterizationDecisions || []).flatMap((decision, index) => {
    const observedValue = decision.observedValue;
    if (observedValue === undefined || !inputEvidenceCorpus.includes(String(observedValue).normalize("NFKC").toLowerCase())) return [];
    const kind = decision.decision as "input" | "scene-ref" | "previous-output" | "constant" | "reject" | undefined;
    if (kind !== "input" && kind !== "scene-ref" && kind !== "previous-output" && kind !== "constant" && kind !== "reject") return [];
    const inputId = kind === "input" && requiredInputs.some((field) => field.id === decision.inputId) ? decision.inputId : undefined;
    return [{ id: `parameter_${stableHash(`${candidate.id}:${index}:${String(observedValue)}`)}`, observedValue, evidence: decision.evidence?.trim().slice(0, 240) || "来自成功经验", decision: kind, inputId, reason: decision.reason?.trim().slice(0, 300) || "AI 能力架构师的参数化判断" }];
  });
  for (const field of requiredInputs) {
    if (field.value === undefined || parameterizationDecisions.some((item) => item.decision === "input" && item.inputId === field.id)) continue;
    if (typeof field.value !== "string" && typeof field.value !== "number" && typeof field.value !== "boolean") continue;
    parameterizationDecisions.push({ id: `parameter_${stableHash(`${candidate.id}:${field.id}:${String(field.value)}`)}`, observedValue: field.value, evidence: "来自用户目标、输入或页面证据", decision: "input", inputId: field.id, reason: `具体值被提升为业务输入 ${field.name}` });
  }
  let goalTemplate = result.goalTemplate?.trim().slice(0, 240);
  if (ordinal && requiredInputs.some((field) => field.id === "rank") && !goalTemplate?.includes("{rank}")) goalTemplate = episode.goal.replace(ordinal[0], `第 {rank} ${ordinal[2]}`);
  if (observedDate && requiredInputs.some((field) => field.id === "date") && !goalTemplate?.includes("{date}")) goalTemplate = episode.goal.replace(/(?:20\d{2}|\d{2})[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日|号)?/, "{date}");
  const intentKey = result.intentKey?.trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, "_").slice(0, 100)
    || `intent_${stableHash(result.goalTemplate || capabilityName)}`;
  const strengthenedIntent = result.reuseDecision === "strengthen-capability"
    ? context.existingIntents?.find((intent) => intent.intentKey === intentKey)
    : undefined;
  if (result.reuseDecision === "strengthen-capability" && !strengthenedIntent?.capabilityId) return undefined;
  const assessmentFactors = (result.assessmentFactors || []).flatMap((factor) => {
    const label = factor.label?.trim().slice(0, 80);
    const evidence = factor.evidence?.trim().slice(0, 300);
    return label && evidence ? [{ label, evidence }] : [];
  }).slice(0, 5);
  if (!assessmentFactors.length) {
    assessmentFactors.push(
      {
        label: "任务证据",
        evidence: `该需求已在 ${episode.endSnapshot.url} 得到“${episode.outcome.status}”结果。`,
      },
      {
        label: "沉淀结论",
        evidence: result.reuseReason?.trim().slice(0, 300)
          || (result.reuseDecision === "do-not-persist"
            ? "该成功经验不满足稳定复用条件，仅保留为本次任务证据。"
            : "该成功经验具备参数化并由独立浏览器验证的条件。"),
      },
    );
  }
  const businessOutputCount = completeResultFields.filter((field) => !["pageUrl", "pageTitle", "pageHeading"].includes(field.id)).length;
  const resultKind = /(收藏|加入|提交|删除|保存|订阅|购买|下单)/.test(`${capabilityName}${result.capabilityDescription || ""}`) ? "action" as const : businessOutputCount ? "data" as const : "page" as const;
  const refined: KnowledgeCandidate = {
    ...candidate,
    capability: {
      ...candidate.capability,
      id: strengthenedIntent?.capabilityId || candidate.capability.id,
      origin: strengthenedIntent?.origin || candidate.capability.origin,
      name: capabilityName,
      resultKind,
      exposure: "public",
      description: result.capabilityDescription?.trim().slice(0, 300) || candidate.capability.description,
      normalizedGoal: normalizeGoal(goalTemplate || capabilityName),
      inputs: requiredInputs.length ? inputSchema : candidate.capability.inputs,
      outputs: outputSchema,
      aliases: [...new Set([...candidate.capability.aliases, ...(result.aliases || []).filter((value) => typeof value === "string").map((value) => value.trim().slice(0, 120))])].slice(0, 12),
    },
    operations: candidate.operations.map((operation, index) => ({
      ...operation,
      inputs: requiredInputs.length ? inputSchema : operation.inputs,
      name: index === 0 && result.operationName?.trim() ? result.operationName.trim().slice(0, 120) : operation.name,
    })),
    authoring: {
      stage: "designed",
      // A semantic design may explain that the experience looks reusable, but
      // only the Program Author and browser gate are allowed to create code.
      reusableTrace: false,
      intentKey,
      parameterizationDecisions,
      capabilityKind,
      reason: result.authoringReason?.trim().slice(0, 400) || "等待独立浏览器完成能力设计和验证",
      reuseDecision: result.reuseDecision === "do-not-persist" || result.reuseDecision === "strengthen-capability" ? result.reuseDecision : "create-capability",
      reuseReason: result.reuseReason?.trim().slice(0, 400) || "这是一个可以在网站中重复完成并验证结果的用户目标。",
      evolutionAssessment: {
        decision: result.reuseDecision === "do-not-persist" ? "skip" : result.reuseDecision === "strengthen-capability" ? "strengthen" : "create",
        summary: result.reuseReason?.trim().slice(0, 400) || "这是一个可以在网站中重复完成并验证结果的用户目标。",
        factors: assessmentFactors,
        analyzedAt: new Date().toISOString(),
        model: getModelConfig("semantic").model,
      },
      goalTemplate,
      requiredInputs,
      resultFields: completeResultFields,
      resultArchetype,
    },
  };
  return refined;
}

export async function deriveValidationInputFromEvidence(candidate: KnowledgeCandidate, episode: TaskEpisode) {
  const fields = candidate.authoring?.requiredInputs || [];
  if (!fields.length) return undefined;
  const evidence = {
    goal: episode.goal,
    observedInput: episode.input,
    startPage: {
      url: episode.startSnapshot.url,
      heading: episode.startSnapshot.heading,
      text: episode.startSnapshot.visibleText.slice(0, 6_000),
      links: episode.startSnapshot.links.slice(0, 80).map((link) => link.text),
    },
    resultPage: {
      url: episode.endSnapshot.url,
      heading: episode.endSnapshot.heading,
      text: episode.endSnapshot.visibleText.slice(0, 8_000),
      links: episode.endSnapshot.links.slice(0, 80).map((link) => link.text),
    },
  };
  const result = await modelJson<{ input?: Record<string, string | number | boolean>; reasons?: Record<string, string> }>(
    "你是独立验证用例设计师。请为每个业务输入选择一个与本次样例不同、但明确出现在所给页面证据中的真实值。新值必须适合相同能力契约，不能使用导航文案、字段标题或凭空编造的值。若证据中没有可靠替代值，就不要返回该字段。",
    {
      capability: { name: candidate.capability.name, description: candidate.capability.description, goalTemplate: candidate.authoring?.goalTemplate },
      fields: fields.map((field) => ({ id: field.id, name: field.name, type: field.type, observedValue: field.value })),
      evidence,
      output: { input: { fieldId: "只允许逐字来自 evidence 的替代值" }, reasons: { fieldId: "证据位置和适用理由" } },
    },
    180_000,
  );
  if (!result?.input) return undefined;
  const corpus = JSON.stringify(evidence).normalize("NFKC").toLowerCase();
  const input: Record<string, string | number | boolean> = {};
  for (const field of fields) {
    const value = result.input[field.id];
    if (value === undefined || value === field.value) continue;
    if (typeof value !== field.type) continue;
    if (!corpus.includes(String(value).normalize("NFKC").toLowerCase())) continue;
    input[field.id] = value;
  }
  return Object.keys(input).length ? input : undefined;
}

/**
 * Arbitration model call for block-level filtering: **picks indices only, produces no
 * content**.
 *
 * Returns an array of block indices; the caller always takes the text by index from the
 * page original — the model has no way to put generated text into the knowledge base.
 * Returns null when the model is unavailable, and the orchestrator takes the
 * deterministic fallback.
 */
export async function judgeContentBlocks(
  request: { url: string; kind: "gray" | "fallback"; blocks: Array<{ id: number; text: string }> },
): Promise<number[] | null> {
  if (!request.blocks.length) return [];
  const instruction = request.kind === "gray"
    ? `你在给一个网页做知识库入库筛选。下面这些内容块拿不准该不该留。
判断标准：**长期有效的知识**才留——正文段落、条款、说明、规格、教程、问答。
**每天/每次访问都会变、或只是页面外壳的不要留**——热搜榜、推荐位、最新动态、
导航链接、页脚版权、广告位。
只返回应当保留的块编号，不要复述或改写任何内容。
输出 JSON：{"keep":[编号,…]}`
    : `你在给一个网页做知识库入库筛选。这一页几乎所有内容都被判成了噪声，需要你复核。
有两种可能：A) 这页本来就没有正文（纯榜单页、目录页、站点地图、栏目首页），
那就一个都不要挑；B) 判错了，这里面其实有长期有效的知识被误伤了，把它们挑出来。
只返回应当保留的块编号，不要复述或改写任何内容。
输出 JSON：{"keep":[编号,…]}`;
  const result = await modelJson<{ keep?: unknown }>(instruction, {
    url: request.url,
    blocks: request.blocks.map((block) => ({ id: block.id, text: block.text.slice(0, 400) })).slice(0, 60),
  });
  if (!result || !Array.isArray(result.keep)) return null;
  return result.keep.filter((id): id is number => typeof id === "number" && Number.isFinite(id));
}


/**
 * Writes a type description for a "data page" class, stored in the **structure
 * knowledge base**.
 *
 * These pages are mass-generated from a template and differ only in short fields — ten
 * thousand near-duplicate instance texts burden retrieval; one description of what the
 * class is and which fields it has is the useful knowledge.
 *
 * The model **writes a description only, no indexed body**: the structure store already
 * holds model-generated scene names and site profiles, and its rule is "descriptions may
 * be model-written"; the content store's rule is unchanged — every sentence must be
 * findable verbatim on the page. Two rules, each in its own layer.
 */
export async function describePageType(
  input: { urlPattern: string; sampleUrls: string[]; constantText: string; variantSamples: string[] },
  locale: KnowledgeLocale = DEFAULT_KNOWLEDGE_LOCALE,
): Promise<{ name: string; description: string } | null> {
  const result = await modelJson<{ name?: unknown; description?: unknown }>(
    `下面是一类由模板批量生成的页面。给它起一个描述**整类**的${languageName(locale)}名字，并用一两句话说明
这类页面是干什么的、包含哪些字段。名字必须描述类别而不是某个实例（例如"明星热搜记录页"
而不是"周杰伦"）。不要复述具体数值。
输出 JSON：{"name":"…","description":"…"}
${outputLanguageInstruction(locale)}`,
    {
      urlPattern: input.urlPattern,
      sampleUrls: input.sampleUrls.slice(0, 5),
      templateText: input.constantText.slice(0, 800),
      variantSamples: input.variantSamples.slice(0, 6).map((text) => text.slice(0, 120)),
    },
  );
  if (!result || typeof result.name !== "string" || typeof result.description !== "string") return null;
  return { name: result.name.trim().slice(0, 60), description: result.description.trim().slice(0, 300) };
}

/**
 * Writes one line on what a page is for. **Called only when no prose block survives
 * filtering** — when the page has its own description, the original is used: more
 * trustworthy and cheaper.
 *
 * Unlike `describePageType`, which describes a whole class of template instances and
 * lands in the structure store, this describes **one specific page** and goes into the
 * content store, so it **must be indexed with source=model**. The content store's rule
 * thereby changes from "every sentence is findable verbatim" to "every unmarked
 * sentence is".
 *
 * The prompt says "summarize only the given text, add no outside knowledge": this line
 * will be retrieved and used in answers, and an invention is worse than the enumeration.
 */
export async function describePage(
  input: { url: string; heading?: string; keptText: string },
): Promise<string | null> {
  const result = await modelJson<{ description?: unknown }>(
    `下面是一个网页过滤后剩下的文字，它基本只有条目、标签和数字，没有成段的说明。
用**一句**中文说明这个页面是干什么的、能在上面找到什么。只根据给到的文字概括，
**不要引入外部知识、不要复述具体数值、不要猜测未给出的功能**。
输出 JSON：{"description":"…"}`,
    {
      url: input.url,
      heading: input.heading || "",
      pageText: input.keptText.slice(0, 1200),
    },
  );
  if (!result || typeof result.description !== "string") return null;
  const description = result.description.trim();
  return description ? description.slice(0, 200) : null;
}

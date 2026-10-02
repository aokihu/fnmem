import { MemoryInputError } from "./errors.js";
import { checkFields, parseJson, snapshotJson } from "./validation.js";

export const LIKELIHOOD_VERSION = "likelihood-v1";
export type LikelihoodLanguage = "en" | "zh";

const options = [
  {
    id: "ruled_out", weight: 0,
    label: { en: "Ruled out", zh: "明确不适用" },
    criteria: {
      en: "A necessary condition is verified false, or external evidence has disproved applicability. Requires host verification.",
      zh: "必要条件已核验为不满足，或外部证据已否定适用性。需要宿主核验。",
    },
  },
  {
    id: "very_unlikely", weight: 0.2,
    label: { en: "Very unlikely", zh: "很不可能适用" },
    criteria: {
      en: "Evidence strongly opposes applicability, with only limited supporting evidence.",
      zh: "证据明显偏向不适用，仅有少量支持。",
    },
  },
  {
    id: "unlikely", weight: 0.4,
    label: { en: "Unlikely", zh: "不太可能适用" },
    criteria: {
      en: "Evidence against applicability slightly outweighs supporting evidence.",
      zh: "反对适用的证据略强于支持证据。",
    },
  },
  {
    id: "likely", weight: 0.6,
    label: { en: "Likely", zh: "较有可能适用" },
    criteria: {
      en: "Supporting evidence slightly outweighs evidence against applicability.",
      zh: "支持适用的证据略强于反对证据。",
    },
  },
  {
    id: "very_likely", weight: 0.8,
    label: { en: "Very likely", zh: "很可能适用" },
    criteria: {
      en: "Key conditions match and strong evidence supports applicability, with some checks still outstanding.",
      zh: "关键条件匹配、支持充分，仍有少量未验证部分。",
    },
  },
  {
    id: "confirmed", weight: 1,
    label: { en: "Confirmed applicable", zh: "已确认适用" },
    criteria: {
      en: "All required applicability conditions have been verified by external facts. Requires host verification; does not guarantee task success.",
      zh: "所需适用条件已经由外部事实核验。需要宿主核验，不代表任务必然成功。",
    },
  },
  {
    id: "unknown", weight: null,
    label: { en: "Insufficient information", zh: "信息不足" },
    criteria: {
      en: "A necessary fact is missing, so applicability cannot be assessed. Do not invent the missing fact.",
      zh: "缺少必要事实，无法判断适用程度，不得补造缺失事实。",
    },
  },
  {
    id: "undetermined", weight: null,
    label: { en: "No clear inclination", zh: "暂无法倾向" },
    criteria: {
      en: "The necessary facts are available, but evidence for and against is balanced. Do not force a choice between unlikely and likely.",
      zh: "必要事实已有，但正反证据相当，不得强行选择不太可能或较有可能。",
    },
  },
] as const;

export type Likelihood = typeof options[number]["id"];
export type VerifiedLikelihood = "ruled_out" | "confirmed";
export interface LikelihoodJudgment {
  readonly version: typeof LIKELIHOOD_VERSION;
  readonly likelihood: Likelihood;
  /** Control weight, not an empirically calibrated success probability. */
  readonly weight: number | null;
}

export const LIKELIHOOD_CATALOG = snapshotJson({ version: LIKELIHOOD_VERSION, options }) as {
  readonly version: typeof LIKELIHOOD_VERSION;
  readonly options: typeof options;
};

const choices = new Map<string, typeof options[number]>(LIKELIHOOD_CATALOG.options.map((option) => [option.id, option]));

// Shared by tool arguments and constrained model responses. IDs never translate.
export const LIKELIHOOD_VALUE_SCHEMA = snapshotJson({ type: "string", enum: options.map((option) => option.id) }) as {
  readonly type: "string"; readonly enum: readonly Likelihood[];
};
export const LIKELIHOOD_RESPONSE_SCHEMA = snapshotJson({
  type: "object", additionalProperties: false,
  required: ["likelihood"], properties: { likelihood: LIKELIHOOD_VALUE_SCHEMA },
}) as {
  readonly type: "object"; readonly additionalProperties: false;
  readonly required: readonly ["likelihood"];
  readonly properties: { readonly likelihood: typeof LIKELIHOOD_VALUE_SCHEMA };
};

/** Validate at the host boundary before constructing a DSL query. */
export function parseLikelihoodJudgment(
  response: unknown,
  configuration: { readonly version: string; readonly verified?: VerifiedLikelihood },
): LikelihoodJudgment {
  if (configuration.version !== LIKELIHOOD_VERSION) throw new MemoryInputError("Unsupported likelihood vocabulary version.");
  if (configuration.verified !== undefined && !["ruled_out", "confirmed"].includes(configuration.verified)) throw new MemoryInputError("Invalid host verification.");
  let value: unknown;
  try {
    value = typeof response === "string" ? parseJson(response) : snapshotJson(response);
    checkFields(value, "likelihood response");
  } catch (error) {
    throw new MemoryInputError(error instanceof Error ? error.message : String(error));
  }
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, "likelihood")) throw new MemoryInputError("Expected only the likelihood field.");
  const option = typeof value.likelihood === "string" ? choices.get(value.likelihood) : undefined;
  if (!option) throw new MemoryInputError("Expected a canonical likelihood identifier.");
  if ((option.id === "ruled_out" || option.id === "confirmed") && configuration.verified !== option.id) {
    throw new MemoryInputError(`'${option.id}' requires matching host verification.`);
  }
  return Object.freeze({ version: LIKELIHOOD_VERSION, likelihood: option.id, weight: option.weight });
}

/** Use one fixed language per experiment; explanations may use the user's language. */
export function getLikelihoodPrompt(language: LikelihoodLanguage = "en"): string {
  if (language !== "en" && language !== "zh") throw new MemoryInputError("Unsupported likelihood prompt language; use en or zh.");
  const lines = LIKELIHOOD_CATALOG.options.map((option) => `- ${option.id} (${option.label[language]}): ${option.criteria[language]}`);
  return [
    language === "zh"
      ? "根据提供的当前事实与记忆模式，判断该模式的适用程度。仅依据提供的证据。"
      : "Assess whether the supplied memory pattern applies to the supplied current facts. Use only the provided evidence.",
    `Vocabulary: ${LIKELIHOOD_VERSION}`,
    ...lines,
    language === "zh"
      ? '严格返回一个 JSON 对象，仅包含 likelihood 字段，例如 {"likelihood":"likely"}。使用上述固定标识，不翻译、不使用同义词、不输出数值或解释。'
      : 'Return exactly one JSON object with only the likelihood field, for example {"likelihood":"likely"}. Use a canonical identifier above; do not translate it, use synonyms, output numbers, or include explanations.',
    language === "zh"
      ? "外部事实不包含系统提供的核验结果时，不得选择 confirmed 或 ruled_out。说明可以另行使用用户语言，不参与程序分支判断。"
      : "Do not select confirmed or ruled_out without host verification in the supplied facts. Any explanation belongs outside this object and may use the user's language; it is not a routing input.",
  ].join("\n");
}

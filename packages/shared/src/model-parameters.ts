import { z } from 'zod';
import { GenerationRequestSchema, type GenerationRequest } from './generation.js';

export const PARAMETER_KEYS = ['aspectRatio', 'resolution', 'width', 'height', 'count', 'durationSeconds', 'fps', 'quality', 'format', 'seed', 'audio', 'negativePrompt'] as const;
const scalar = z.union([z.string().max(10000), z.number().finite(), z.boolean()]);
export const ModelParameterSchema = z.object({
  path: z.string().regex(/^(aspectRatio|resolution|width|height|count|durationSeconds|fps|quality|format|seed|audio|negativePrompt|extra\.[a-zA-Z][a-zA-Z0-9_]{0,63})$/).refine(value => !/(?:__proto__|constructor|prototype|secret|token|password|api_?key|header|authorization)/i.test(value)),
  label: z.string().trim().min(1).max(120),
  type: z.enum(['text', 'select', 'number', 'boolean']),
  enabled: z.boolean().default(true),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  required: z.boolean().default(false),
  defaultValue: scalar.optional(),
  options: z.array(scalar).max(100).optional(),
  allowCustom: z.boolean().default(false),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().positive().optional(),
}).strict().superRefine((rule, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) issue('参数最小值不能超过最大值');
  if (rule.locked && rule.enabled && rule.defaultValue === undefined) issue('固定参数必须配置默认值');
  if (rule.type === 'select' && !rule.options?.length) issue('枚举参数至少需要一个选项');
  if (rule.defaultValue !== undefined) { try { validateParameter(rule, rule.defaultValue); } catch { issue('参数默认值不符合规则'); } }
});
export type ModelParameter = z.infer<typeof ModelParameterSchema>;
export const ModelParametersSchema = z.array(ModelParameterSchema).max(50).refine(rules => new Set(rules.map(rule => rule.path)).size === rules.length, '参数路径不能重复');

function validateParameter(rule: Pick<ModelParameter, 'type' | 'label' | 'options' | 'allowCustom' | 'min' | 'max' | 'step'>, value: unknown) {
  if (!scalar.safeParse(value).success) throw new Error(`${rule.label}必须是文本、数值或开关`);
  if ((rule.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) || (rule.type === 'boolean' && typeof value !== 'boolean') || (rule.type === 'text' && typeof value !== 'string')) throw new Error(`${rule.label}类型无效`);
  if (rule.type === 'select' && !rule.allowCustom && !rule.options?.includes(value as string | number | boolean)) throw new Error(`${rule.label}不在可选范围内`);
  if (typeof value === 'number') {
    if ((rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max)) throw new Error(`${rule.label}超出允许范围`);
    if (rule.step !== undefined && Math.abs((value - (rule.min ?? 0)) / rule.step - Math.round((value - (rule.min ?? 0)) / rule.step)) > 1e-8) throw new Error(`${rule.label}不符合步长`);
  }
}

export function applyModelParameters(request: GenerationRequest, rules: readonly ModelParameter[] | undefined): GenerationRequest {
  if (rules === undefined) return request;
  const result: Record<string, unknown> = { ...request, extra: { ...request.extra } };
  const extras = result.extra as Record<string, unknown>;
  const paths = new Set(rules.filter(rule => rule.enabled).map(rule => rule.path));
  for (const key of PARAMETER_KEYS) if (request[key] !== undefined && !paths.has(key)) throw new Error(`模型未启用参数 ${key}`);
  for (const key of Object.keys(extras)) if (!paths.has(`extra.${key}`)) throw new Error(`模型未启用参数 extra.${key}`);
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const target = rule.path.startsWith('extra.') ? extras : result;
    const key = rule.path.startsWith('extra.') ? rule.path.slice(6) : rule.path;
    const value = rule.locked ? rule.defaultValue : target[key] ?? rule.defaultValue;
    if (value === undefined) { if (rule.required) throw new Error(`请填写${rule.label}`); continue; }
    validateParameter(rule, value);
    target[key] = value;
  }
  if (!Object.keys(extras).length) delete result.extra;
  return GenerationRequestSchema.parse(result);
}

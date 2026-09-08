import { assertOperationParameters, type GenerationRequest } from '@imagine/shared';
import type { ProviderContext, ProviderInput } from '@imagine/provider-contract';
import { videoOperationPolicies } from './video-operation-policy.js';

export function sourceVideo(request: GenerationRequest, context: ProviderContext, profile: string): ProviderInput {
  const policy = context.operationPolicy ?? videoOperationPolicies(profile, request.modelId)[request.operation];
  if (!policy?.video) throw new Error('此模型未配置视频编辑或续写能力');
  assertOperationParameters(request, policy);
  if (request.extra && Object.keys(request.extra).length) throw new Error('当前视频操作不支持额外参数');
  if (request.providerId !== context.providerId || !request.prompt.trim() || (request.count !== undefined && request.count !== 1)) throw new Error('视频请求无效');
  if (request.inputs.length !== 1 || request.inputs[0]?.role !== 'source') throw new Error('需要一个源视频');
  const input = context.inputs?.find(input => input.assetId === request.inputs[0]!.assetId && input.role === 'source');
  if (!input || !policy.video.mimeTypes.includes(input.mimeType) || input.bytes.byteLength === 0 || input.bytes.byteLength > (policy.video.maxBytes ?? 64 * 1024 * 1024)) throw new Error('源视频格式或大小不符合要求');
  const duration = input.durationSeconds;
  const origin = input.videoSource;
  const valid = origin?.providerId === context.providerId && origin.profile === profile && (policy.video.source !== 'same-provider-model' || origin.modelId === request.modelId);
  const liveInteraction = valid && origin.modelId === request.modelId && origin.remoteJobId.startsWith('interaction:') && (!origin.expiresAt || Date.parse(origin.expiresAt) > Date.now());
  const maxDuration = policy.video.maxDurationSeconds ?? (liveInteraction ? Infinity : policy.video.maxUploadedDurationSeconds ?? Infinity);
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0 || duration < (policy.video.minDurationSeconds ?? 0) || duration > maxDuration) throw new Error('源视频时长不符合要求');
  if (policy.video.source !== 'uploaded-or-generated' && !valid && !policy.video.allowUploaded) throw new Error('需要同连接生成的有效视频来源');
  if (valid && policy.video.requireLiveSource && origin.expiresAt && (!Number.isFinite(Date.parse(origin.expiresAt)) || Date.parse(origin.expiresAt) <= Date.now())) throw new Error('上游视频来源已过期');
  return input;
}

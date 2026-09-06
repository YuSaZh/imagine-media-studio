import type { ProviderAdapter, ProviderCapabilities, ProviderContext, ProviderError, ProviderAssetReference } from '@imagine/provider-contract';
import { matchModelProtocol, providerFamily, resolveModelProfile, type GenerationRequest, type NativeProviderProfile, type ProviderFamily } from '@imagine/shared';

interface CatalogAdapter extends ProviderAdapter {
  getLiveCapabilities?(context: ProviderContext): Promise<ProviderCapabilities>;
}

class RoutedError extends Error {
  constructor(readonly normalized: ProviderError) { super(normalized.message); }
}

function protocolMismatch(error: ProviderError): boolean {
  if ([404, 405, 415, 501].includes(error.statusCode ?? 0)) return true;
  return [400, 422, 500, 502].includes(error.statusCode ?? 0) &&
    /(?:unsupported|not supported|not support|only .+ supported).*(?:endpoint|protocol|image generation|imagen|model)|(?:endpoint|protocol|model).*(?:unsupported|not supported|not support)/i.test(error.message);
}

/** A connection owns credentials; each model selects its wire protocol. */
export class FamilyProvider implements ProviderAdapter {
  constructor(readonly type: ProviderFamily, private readonly adapters: ReadonlyMap<string, CatalogAdapter>) {}

  private adapter(profile?: NativeProviderProfile, modelId = '', operation = 'video.generate') {
    const resolved = resolveModelProfile(this.type, operation, modelId, profile);
    const adapter = resolved && this.adapters.get(resolved);
    if (!adapter) throw new Error('Model protocol is unavailable.');
    return adapter;
  }

  private async call<T>(adapter: ProviderAdapter, work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) { throw new RoutedError(await adapter.normalizeError(error)); }
  }

  private async catalog(context: ProviderContext, live: boolean): Promise<ProviderCapabilities> {
    const primary = [...this.adapters.values()].filter(adapter => providerFamily(adapter.type) === this.type && !adapter.type.includes('responses') && !adapter.type.includes('interactions') && !adapter.type.includes('chat'));
    const results = await Promise.allSettled(primary.map(adapter => this.call(adapter, async () => {
      const result = live && adapter.getLiveCapabilities ? await adapter.getLiveCapabilities(context) : await adapter.getCapabilities(context);
      return result.models.map(model => ({ ...model, capabilities: { ...model.capabilities, profile: adapter.type as NativeProviderProfile } }));
    })));
    const models = new Map<string, ProviderCapabilities['models'][number]>();
    for (const result of results) if (result.status === 'fulfilled') for (const model of result.value) if (!models.has(model.id)) models.set(model.id, model);
    if (!models.size) {
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
    const defaults = new Map<string, Promise<ProviderCapabilities>>();
    const matchedModels = await Promise.all([...models.values()].map(async model => {
      const profile = matchModelProtocol(model.id);
      const adapter = profile && this.adapters.get(profile);
      if (!adapter || profile === model.capabilities.profile) return model;
      let catalog = defaults.get(adapter.type);
      if (!catalog) { catalog = adapter.getCapabilities(context); defaults.set(adapter.type, catalog); }
      const capabilities = (await catalog).models;
      const preset = capabilities.find(candidate => candidate.id === model.id.replace(/^models\//, '')) ?? capabilities[0];
      return preset ? { ...model, capabilities: { ...preset.capabilities, profile } } : model;
    }));
    return { providerType: this.type, models: matchedModels };
  }

  getCapabilities(context: ProviderContext) { return this.catalog(context, false); }
  getLiveCapabilities(context: ProviderContext) { return this.catalog(context, true); }
  async testConnection(context: ProviderContext) {
    const adapter = this.adapter(undefined, '', 'image.generate');
    await this.call(adapter, () => adapter.testConnection ? adapter.testConnection(context) : adapter.getCapabilities(context).then(() => undefined));
  }
  async validate(request: GenerationRequest, context: ProviderContext) {
    const { profile, ...nativeRequest } = request;
    const adapter = this.adapter(profile, request.modelId, request.operation);
    return this.call(adapter, () => adapter.validate(nativeRequest, context));
  }
  async submit(request: GenerationRequest, context: ProviderContext) {
    const { profile, ...nativeRequest } = request;
    const adapter = this.adapter(profile, request.modelId, request.operation);
    let failure: RoutedError;
    try { return await this.call(adapter, () => adapter.submit(nativeRequest, context)); }
    catch (error) {
      if (!(error instanceof RoutedError) || !request.operation.startsWith('image.') || !protocolMismatch(error.normalized)) throw error;
      failure = error;
    }
    const candidates = /gemini/i.test(request.modelId)
      ? ['openai-chat-image-v1', 'gemini-generate-content-image-v1', 'openai-images-v1', 'openai-responses-image-v1']
      : ['openai-images-v1', 'openai-chat-image-v1', 'openai-responses-image-v1'];
    for (const type of candidates) {
      const candidate = this.adapters.get(type);
      if (!candidate || candidate === adapter) continue;
      context.signal?.throwIfAborted();
      // Validate without dropping options or inputs that a different protocol cannot represent.
      try { await candidate.validate(nativeRequest, context); } catch { continue; }
      try { return await this.call(candidate, () => candidate.submit(nativeRequest, context)); }
      catch (error) {
        if (!(error instanceof RoutedError) || !protocolMismatch(error.normalized)) throw error;
        failure = error;
      }
    }
    throw failure;
  }
  poll(remoteJobId: string, context: ProviderContext) {
    const adapter = this.adapter(context.profile, context.modelId);
    return this.call(adapter, () => { if (!adapter.poll) throw new Error('Model protocol does not support polling.'); return adapter.poll(remoteJobId, context); });
  }
  cancel(remoteJobId: string, context: ProviderContext) {
    const adapter = this.adapter(context.profile, context.modelId);
    return this.call(adapter, () => { if (!adapter.cancel) throw new Error('Model protocol does not support cancellation.'); return adapter.cancel(remoteJobId, context); });
  }
  resolveResult(asset: ProviderAssetReference, context: ProviderContext) {
    const adapter = this.adapter(context.profile, context.modelId);
    return this.call(adapter, () => { if (!adapter.resolveResult) throw new Error('Model protocol does not support result resolution.'); return adapter.resolveResult(asset, context); });
  }
  normalizeError(error: unknown): ProviderError {
    return error instanceof RoutedError ? error.normalized : { code: 'model_protocol_invalid', kind: 'rejected', message: '模型调用协议不可用，请检查模型配置。', retryable: false };
  }
}

import type { ProviderAdapter, ProviderCapabilities, ProviderContext, ProviderError, ProviderAssetReference } from '@imagine/provider-contract';
import { resolveModelProfile, type GenerationRequest, type NativeProviderProfile, type ProviderFamily } from '@imagine/shared';

interface CatalogAdapter extends ProviderAdapter {
  getLiveCapabilities?(context: ProviderContext): Promise<ProviderCapabilities>;
}

class RoutedError extends Error {
  constructor(readonly normalized: ProviderError) { super(normalized.message); }
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
    const primary = [...this.adapters.values()].filter(adapter => !adapter.type.includes('responses') && !adapter.type.includes('interactions'));
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
    return { providerType: this.type, models: [...models.values()] };
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
    return this.call(adapter, () => adapter.submit(nativeRequest, context));
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

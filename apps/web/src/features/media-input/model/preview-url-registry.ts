export interface PreviewUrlPort {
  create(file: File): string;
  revoke(url: string): void;
}

const browserPreviewUrls: PreviewUrlPort = {
  create: (file) => URL.createObjectURL(file),
  revoke: (url) => URL.revokeObjectURL(url),
};

export class PreviewUrlRegistry {
  private readonly urls = new Map<string, string>();

  public constructor(private readonly port: PreviewUrlPort = browserPreviewUrls) {}

  public create(clientId: string, file: File): string {
    this.release(clientId);
    const url = this.port.create(file);
    this.urls.set(clientId, url);
    return url;
  }

  public createBatch(
    inputs: readonly { readonly clientId: string; readonly file: File }[],
  ): Readonly<Record<string, string>> {
    const createdIds: string[] = [];
    const urls: Record<string, string> = {};
    try {
      for (const input of inputs) {
        urls[input.clientId] = this.create(input.clientId, input.file);
        createdIds.push(input.clientId);
      }
      return urls;
    } catch (error) {
      for (const clientId of createdIds) this.release(clientId);
      throw error;
    }
  }

  public release(clientId: string): void {
    const url = this.urls.get(clientId);
    if (!url) return;
    this.urls.delete(clientId);
    this.port.revoke(url);
  }

  public dispose(): void {
    for (const url of this.urls.values()) this.port.revoke(url);
    this.urls.clear();
  }
}

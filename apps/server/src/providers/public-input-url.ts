export function publicInputUrl(input: { assetId: string; publicUrl?: string }): string | undefined {
  if (input.publicUrl === undefined) return undefined;
  const url = new URL(input.publicUrl);
  const suffix = url.pathname.split('/').slice(-4);
  if (input.publicUrl.length > 4096 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || suffix[0] !== 'media-inputs' || suffix[1] !== encodeURIComponent(input.assetId) || !/^\d{10,12}$/.test(suffix[2] ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(suffix[3] ?? '')) throw new Error('Invalid server-issued input URL.');
  return url.toString();
}

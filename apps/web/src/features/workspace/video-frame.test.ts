import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureVideoFrame, videoFrameLabel } from './video-frame';
function fixture() {
  const drawImage = vi.fn(), canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob: (done: BlobCallback) => done(new Blob(['frame'], { type: 'image/png' })) };
  const video = Object.assign(new EventTarget(), { pause: vi.fn(), error: null, seeking: false, readyState: 2, videoWidth: 320, videoHeight: 180, currentTime: 1.5, ownerDocument: { createElement: () => canvas } });
  return { video, canvas, drawImage, capture: (signal?: AbortSignal) => captureVideoFrame(video as unknown as HTMLVideoElement, signal) };
}
afterEach(() => vi.useRealTimers());
describe('current video frame capture', () => {
  it('captures the current decoded frame at intrinsic dimensions without seeking', async () => {
    const { video, canvas, drawImage, capture } = fixture(); const result = await capture();
    expect(video.pause).toHaveBeenCalledOnce(); expect(video.currentTime).toBe(1.5);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 180);
    expect(result).toMatchObject({ timeSeconds: 1.5, width: 320, height: 180 });
    expect(result.file.name).toBe('video-frame-1500ms.png'); expect(result.file.type).toBe('image/png');
    expect(canvas.width).toBe(0); expect(canvas.height).toBe(0); expect(videoFrameLabel(61.5)).toBe('01:01.5');
  });
  it('waits for an in-progress seek and respects cancellation', async () => {
    const f = fixture(); f.video.seeking = true; const pending = f.capture();
    await Promise.resolve(); expect(f.drawImage).not.toHaveBeenCalled();
    f.video.currentTime = 4; f.video.seeking = false; f.video.dispatchEvent(new Event('seeked'));
    expect((await pending).timeSeconds).toBe(4);
    f.video.seeking = true; const controller = new AbortController(); const aborted = f.capture(controller.signal); controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('bounds waiting and rejects oversized frames or failed encoding', async () => {
    vi.useFakeTimers(); const f = fixture(); f.video.readyState = 0;
    const assertion = expect(f.capture()).rejects.toThrow('无法读取'); await vi.advanceTimersByTimeAsync(8000); await assertion;
    f.video.readyState = 2; f.video.videoWidth = 100000; await expect(f.capture()).rejects.toThrow('尺寸限制');
    f.video.videoWidth = 320; f.canvas.toBlob = done => done(null); await expect(f.capture()).rejects.toThrow('编码失败'); expect(f.canvas.width).toBe(0);
  });
});

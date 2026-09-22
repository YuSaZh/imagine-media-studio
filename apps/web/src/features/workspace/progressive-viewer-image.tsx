import { t } from '../../i18n/index';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { MediaItem } from './data';
import { viewerMediaBounds } from './viewer-media-geometry';

export function ProgressiveViewerImage({ item, source, opening, style }: { item: MediaItem; source: string; opening: boolean; style: CSSProperties }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [decoded, setDecoded] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    const original = new Image(); original.src = source;
    setError(false);
    void original.decode().then(() => { if (!disposed) setDecoded(source); }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; };
  }, [source, attempt]);
  useLayoutEffect(() => {
    const image = imageRef.current, stage = image?.closest<HTMLElement>('.viewer-stage');
    if (!image || !stage) return;
    const measure = () => {
      const bounds = viewerMediaBounds(stage, item.width, item.height);
      image.style.width = `${bounds.width}px`; image.style.height = `${bounds.height}px`;
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(stage);
    return () => observer.disconnect();
  }, [item.width, item.height]);
  return <>
    <img ref={imageRef} className="viewer-image" src={!opening && decoded ? decoded : item.thumbnail} data-image-quality={!opening && decoded ? 'original' : 'thumbnail'} alt={item.title} draggable={false} style={style} />
    {error && <p className="media-error viewer-image-error" role="alert">{t("原文件暂时无法加载")}<button className="quiet-command" onClick={() => setAttempt(value => value + 1)}>{t("重试")}</button></p>}
  </>;
}

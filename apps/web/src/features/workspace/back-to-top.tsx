import { useEffect, useState, type RefObject } from 'react';
import { ArrowUpToLine } from 'lucide-react';
import { Tool } from './ui';

export function BackToTop({ scrollRef, galleryRef, workspaceRef, hasComposer, hidden, reduceMotion }: {
  scrollRef: RefObject<HTMLElement | null>; galleryRef: RefObject<HTMLElement | null>; workspaceRef: RefObject<HTMLElement | null>;
  hasComposer: boolean; hidden: boolean; reduceMotion: 'always' | 'never' | 'system';
}) {
  const [position, setPosition] = useState({ visible: false, right: 12, bottom: 20, centered: false });
  useEffect(() => {
    const scroll = scrollRef.current, gallery = galleryRef.current;
    if (!scroll || !gallery) return;
    const viewport = window.visualViewport;
    const composer = hasComposer ? workspaceRef.current?.querySelector('.creation-composer') : null;
    const measure = () => {
      const keyboard = viewport ? innerHeight - viewport.height - viewport.offsetTop > 80 : false;
      const send = composer?.querySelector('.generate-button')?.getBoundingClientRect();
      const next = { centered: !!send, visible: scroll.scrollTop > 600 && !keyboard,
        right: send ? innerWidth - send.left - send.width / 2 : Math.max(12, innerWidth - (gallery.querySelector('.study-grid') ?? gallery.closest('.library-area') ?? gallery).getBoundingClientRect().right),
        bottom: composer ? Math.max(20, innerHeight - composer.getBoundingClientRect().top + 12) : 20 };
      setPosition(current => current.centered === next.centered && current.visible === next.visible && current.right === next.right && current.bottom === next.bottom ? current : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(scroll); observer.observe(gallery.closest('.library-area') ?? gallery);
    if (composer) observer.observe(composer);
    measure(); scroll.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure); viewport?.addEventListener('resize', measure); viewport?.addEventListener('scroll', measure);
    return () => { observer.disconnect(); scroll.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); viewport?.removeEventListener('resize', measure); viewport?.removeEventListener('scroll', measure); };
  }, [scrollRef, galleryRef, workspaceRef, hasComposer]);
  if (hidden || !position.visible) return null;
  return <Tool label="返回顶部" className="back-to-top" style={{ right: position.right, bottom: position.bottom, transform: position.centered ? 'translateX(50%)' : undefined }} onClick={() => {
    const reduced = reduceMotion === 'always' || reduceMotion === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollRef.current?.scrollTo({ top: 0, behavior: reduced ? 'instant' : 'smooth' });
  }}><ArrowUpToLine size={18} strokeWidth={1.75} /></Tool>;
}

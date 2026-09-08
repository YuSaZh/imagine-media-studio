export async function copyPrompt(prompt: string, notice: (message: string) => void): Promise<void> {
  try {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(prompt);
    } catch {
      const previous = document.activeElement;
      const field = document.createElement('textarea');
      field.value = prompt;
      field.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0';
      document.body.append(field);
      try { field.select(); if (!document.execCommand('copy')) throw new Error('Copy failed'); }
      finally { field.remove(); if (previous instanceof HTMLElement) previous.focus({ preventScroll: true }); }
    }
    notice('已复制提示词');
  } catch { notice('复制失败，请打开详情选择提示词复制'); }
}

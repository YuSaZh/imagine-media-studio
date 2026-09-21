export function viewerMediaBounds(stage: HTMLElement, width: number, height: number) {
  const box = stage.getBoundingClientRect(), style = getComputedStyle(stage);
  const left = parseFloat(style.paddingLeft), right = parseFloat(style.paddingRight);
  const top = parseFloat(style.paddingTop), bottom = parseFloat(style.paddingBottom);
  const availableWidth = Math.max(1, box.width - left - right), availableHeight = Math.max(1, box.height - top - bottom);
  const scale = Math.min(1, availableWidth / width, availableHeight / height);
  const fittedWidth = width * scale, fittedHeight = height * scale;
  return { left: box.left + left + (availableWidth - fittedWidth) / 2, top: box.top + top + (availableHeight - fittedHeight) / 2, width: fittedWidth, height: fittedHeight };
}

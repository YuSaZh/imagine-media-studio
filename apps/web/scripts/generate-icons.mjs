import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sparkles } from 'lucide-react';

const browser = await chromium.launch();
try {
  for (const [name, size, padding] of [['app-icon-192.png', 192, 40], ['app-icon-512.png', 512, 108], ['app-icon-maskable.png', 512, 140], ['apple-touch-icon.png', 180, 38]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const icon = renderToStaticMarkup(createElement(Sparkles, { size: size - padding * 2, strokeWidth: 1.5 }));
    await page.setContent(`<style>body{margin:0;display:grid;place-items:center;width:100vw;height:100vh;background:#e5ebe8;color:#293e36}</style>${icon}`);
    await page.screenshot({ path: resolve('apps/web/public/icons', name) });
    await page.close();
  }
} finally { await browser.close(); }

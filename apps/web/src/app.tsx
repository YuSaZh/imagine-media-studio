import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { GalleryPage } from './features/gallery/components/gallery-page';
import { AppShell } from './features/shell/components/app-shell';
import { RouteLoading } from './route-loading.js';

const LibraryPage = lazy(async () => ({
  default: (await import('./features/library/components/library-page')).LibraryPage,
}));

const MaskEditorPage = lazy(async () => ({
  default: (await import('./features/image-editor/components/mask-editor-page')).MaskEditorPage,
}));

const SettingsPage = lazy(async () => ({
  default: (await import('./features/settings/components/settings-page')).SettingsPage,
}));

function MaskEditorRoute() {
  return (
    <Suspense fallback={(
      <main className="mask-editor-page mask-editor-page--status">
        <h1 className="mask-editor-title">Edit image</h1>
        <div className="mask-editor-status" role="status">Loading editor</div>
      </main>
    )}>
      <MaskEditorPage />
    </Suspense>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/edit/:assetId" element={<MaskEditorRoute />} />
        <Route element={<AppShell />}>
          <Route index element={<Navigate replace to="/imagine" />} />
          <Route path="/imagine" element={<GalleryPage />} />
          <Route path="/saved" element={<Suspense fallback={<RouteLoading label="Loading saved" />}><LibraryPage mode="saved" /></Suspense>} />
          <Route path="/folders/:folderId" element={<Suspense fallback={<RouteLoading label="Loading folder" />}><LibraryPage mode="folder" /></Suspense>} />
          <Route path="/jobs" element={<Suspense fallback={<RouteLoading label="Loading jobs" />}><LibraryPage mode="jobs" /></Suspense>} />
          <Route path="/settings" element={<Suspense fallback={<RouteLoading label="Loading settings" settings />}><SettingsPage section="general" /></Suspense>} />
          <Route path="/settings/providers" element={<Suspense fallback={<RouteLoading label="Loading settings" settings />}><SettingsPage section="providers" /></Suspense>} />
          <Route path="/settings/storage" element={<Suspense fallback={<RouteLoading label="Loading settings" settings />}><SettingsPage section="storage" /></Suspense>} />
          <Route path="/settings/pwa" element={<Suspense fallback={<RouteLoading label="Loading settings" settings />}><SettingsPage section="pwa" /></Suspense>} />
          <Route path="*" element={<Navigate replace to="/imagine" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

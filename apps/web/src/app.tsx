import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { GalleryPage } from './features/gallery/components/gallery-page';
import { LibraryPage } from './features/library/components/library-page';
import { SettingsPage } from './features/settings/components/settings-page';
import { AppShell } from './features/shell/components/app-shell';

const MaskEditorPage = lazy(async () => ({
  default: (await import('./features/image-editor/components/mask-editor-page')).MaskEditorPage,
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
          <Route path="/saved" element={<LibraryPage mode="saved" />} />
          <Route path="/folders/:folderId" element={<LibraryPage mode="folder" />} />
          <Route path="/jobs" element={<LibraryPage mode="jobs" />} />
          <Route path="/settings" element={<SettingsPage section="general" />} />
          <Route path="/settings/providers" element={<SettingsPage section="providers" />} />
          <Route path="/settings/storage" element={<SettingsPage section="storage" />} />
          <Route path="/settings/pwa" element={<SettingsPage section="pwa" />} />
          <Route path="*" element={<Navigate replace to="/imagine" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

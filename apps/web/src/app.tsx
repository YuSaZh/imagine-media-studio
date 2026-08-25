import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { GalleryPage } from './features/gallery/components/gallery-page';
import { LibraryPage } from './features/library/components/library-page';
import { SettingsPage } from './features/settings/components/settings-page';
import { AppShell } from './features/shell/components/app-shell';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
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

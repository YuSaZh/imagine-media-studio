import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Workspace } from './features/workspace/workspace';

export function App() {
  return <BrowserRouter><Routes>
    <Route path="/" element={<Navigate to="/imagine" replace />} />
    <Route path="/*" element={<Workspace />} />
  </Routes></BrowserRouter>;
}

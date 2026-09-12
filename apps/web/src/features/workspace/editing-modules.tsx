import { lazy, type ComponentType } from 'react';
import type { MediaEditingWorkspace as WorkspaceModule } from './media-editing-workspace';
import type { Editor as EditorModule } from './editor';
import { preloadAfterGallery } from './preload-after-gallery';

// Warmed modules render synchronously on first opening. A failed background
// download is retried through the normal lazy entry when the user opens it.
function preloadable<Props extends object>(loader: () => Promise<{ default: ComponentType<Props> }>) {
  let loaded: ComponentType<Props> | undefined;
  let pending: ReturnType<typeof loader> | undefined;
  const preload = () => pending ??= loader().then(module => {
    loaded = module.default;
    return module;
  }).catch(error => { pending = undefined; throw error; });
  const Lazy = lazy(preload);
  function Component(props: Props) {
    const Resolved = loaded ?? Lazy;
    return <Resolved {...props} />;
  }
  return { Component, preload, isLoaded: () => loaded !== undefined };
}

const workspace = preloadable<Parameters<typeof WorkspaceModule>[0]>(() => import('./media-editing-workspace').then(module => ({ default: module.MediaEditingWorkspace })));
const editor = preloadable<Parameters<typeof EditorModule>[0]>(() => import('./editor').then(module => ({ default: module.Editor })));
export const MediaEditingWorkspace = workspace.Component;
export const Editor = editor.Component;
export function preloadEditingModules(root: HTMLElement) {
  const pending = [workspace, editor].filter(module => !module.isLoaded());
  if (!pending.length) return;
  return preloadAfterGallery(root, pending.map(module => module.preload));
}

import { MAX_MASK_BRUSH_DIAMETER } from '@imagine/shared';
import type { MaskTool } from '@imagine/shared';
import {
  Brush,
  Check,
  Eraser,
  Redo2,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';

import { IconButton } from '../../../components/icon-button.js';

export interface MaskEditorToolbarProps {
  readonly applyDisabled: boolean;
  readonly applying: boolean;
  readonly canClear: boolean;
  readonly canRedo: boolean;
  readonly canUndo: boolean;
  readonly clearConfirmation: boolean;
  readonly diameter: number;
  readonly onApply: () => void;
  readonly onCancelClear: () => void;
  readonly onClose: () => void;
  readonly onConfirmClear: () => void;
  readonly onDiameterChange: (diameter: number) => void;
  readonly onRedo: () => void;
  readonly onRequestClear: () => void;
  readonly onShowMaskChange: (visible: boolean) => void;
  readonly onShowOriginalChange: (visible: boolean) => void;
  readonly onToolChange: (tool: MaskTool) => void;
  readonly onUndo: () => void;
  readonly showMask: boolean;
  readonly showOriginal: boolean;
  readonly tool: MaskTool;
}

export function MaskEditorToolbar(props: MaskEditorToolbarProps) {
  const commandsDisabled = props.applying;
  return (
    <div className="mask-editor-toolbar" aria-label="Mask editor tools" role="toolbar">
      <div className="mask-editor-toolbar__commands" role="group" aria-label="Drawing tools">
        <IconButton
          aria-pressed={props.tool === 'brush'}
          className="mask-editor-touch-target"
          disabled={commandsDisabled}
          icon={<Brush size={19} />}
          label="Brush"
          onClick={() => props.onToolChange('brush')}
        />
        <IconButton
          aria-pressed={props.tool === 'erase'}
          className="mask-editor-touch-target"
          disabled={commandsDisabled}
          icon={<Eraser size={19} />}
          label="Eraser"
          onClick={() => props.onToolChange('erase')}
        />
        <label className="mask-editor-brush-size">
          <span>Brush size</span>
          <input
            aria-label="Brush size"
            disabled={commandsDisabled}
            max={MAX_MASK_BRUSH_DIAMETER}
            min={1}
            onChange={(event) => props.onDiameterChange(Number(event.target.value))}
            step={1}
            type="range"
            value={props.diameter}
          />
          <output>{Math.round(props.diameter)}</output>
        </label>
        <IconButton
          className="mask-editor-touch-target"
          disabled={commandsDisabled || !props.canUndo}
          icon={<Undo2 size={19} />}
          label="Undo"
          onClick={props.onUndo}
        />
        <IconButton
          className="mask-editor-touch-target"
          disabled={commandsDisabled || !props.canRedo}
          icon={<Redo2 size={19} />}
          label="Redo"
          onClick={props.onRedo}
        />
        {!props.clearConfirmation && (
          <IconButton
            className="mask-editor-touch-target"
            disabled={commandsDisabled || !props.canClear}
            icon={<Trash2 size={19} />}
            label="Clear mask"
            onClick={props.onRequestClear}
            tone="danger"
          />
        )}
        {props.clearConfirmation && (
          <span className="mask-editor-clear-confirmation" role="alert">
            <span>Clear mask?</span>
            <button
              className="mask-editor-text-command mask-editor-touch-target"
              disabled={commandsDisabled}
              onClick={props.onConfirmClear}
              type="button"
            >
              Clear
            </button>
            <button
              className="mask-editor-text-command mask-editor-touch-target"
              disabled={commandsDisabled}
              onClick={props.onCancelClear}
              type="button"
            >
              Keep
            </button>
          </span>
        )}
      </div>

      <div className="mask-editor-toolbar__layers" role="group" aria-label="Canvas layers">
        <label className="mask-editor-layer-toggle mask-editor-touch-target">
          <input
            aria-label="Show original image"
            checked={props.showOriginal}
            onChange={(event) => props.onShowOriginalChange(event.target.checked)}
            type="checkbox"
          />
          <span>Original</span>
        </label>
        <label className="mask-editor-layer-toggle mask-editor-touch-target">
          <input
            aria-label="Show mask overlay"
            checked={props.showMask}
            onChange={(event) => props.onShowMaskChange(event.target.checked)}
            type="checkbox"
          />
          <span>Mask overlay</span>
        </label>
      </div>

      <div className="mask-editor-toolbar__completion" role="group" aria-label="Editor commands">
        <IconButton
          className="mask-editor-touch-target"
          disabled={props.applying}
          icon={<X size={20} />}
          label="Cancel editing"
          onClick={props.onClose}
        />
        <IconButton
          className="mask-editor-touch-target"
          disabled={props.applyDisabled || props.applying}
          icon={<Check size={20} />}
          label={props.applying ? 'Applying mask' : 'Apply mask'}
          onClick={props.onApply}
          tone="primary"
        />
      </div>
    </div>
  );
}

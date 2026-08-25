import { classifyMaskRgba } from '@imagine/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  MaskEditorController,
  createMaskEditorState,
  maskDocumentForRender,
  maskEditorReducer,
} from './mask-editor.js';

const rect = { height: 50, left: 10, top: 20, width: 100 };

describe('mask editor model', () => {
  it('maps client pointer coordinates and commits one canonical stroke', () => {
    const controller = new MaskEditorController(createMaskEditorState({
      diameter: 1,
      height: 5,
      width: 10,
    }));
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.pointerDown(1, { x: 10, y: 20 }, rect);
    controller.pointerMove(1, { x: 60, y: 45 }, rect);

    expect(controller.getSnapshot().document.history).toHaveLength(0);
    expect(classifyMaskRgba(maskDocumentForRender(controller.getSnapshot()).rgba)).toBe('partial');
    controller.pointerUp(1, { x: 110, y: 70 }, rect);

    const state = controller.getSnapshot();
    expect(state.activeStroke).toBeNull();
    expect(state.document.history).toHaveLength(1);
    expect(state.document.history[0]).toMatchObject({
      points: [{ x: 0, y: 0 }, { x: 5, y: 2.5 }, { x: 9, y: 4 }],
      tool: 'brush',
    });
    expect(listener).toHaveBeenCalled();
  });

  it('supports tool, diameter, undo, redo, clear, and pointer cancellation', () => {
    let state = createMaskEditorState({ diameter: 1, height: 3, width: 3 });
    state = maskEditorReducer(state, { tool: 'erase', type: 'set_tool' });
    state = maskEditorReducer(state, { diameter: 2, type: 'set_diameter' });
    state = maskEditorReducer(state, {
      pointerId: 2,
      point: { x: -10, y: 99 },
      type: 'pointer_start',
    });
    expect(state.activeStroke).toMatchObject({
      diameter: 2,
      points: [{ x: 0, y: 2 }],
      tool: 'erase',
    });
    expect(maskEditorReducer(state, { pointerId: 3, type: 'pointer_cancel' })).toBe(state);
    state = maskEditorReducer(state, { pointerId: 2, type: 'pointer_cancel' });
    expect(state.activeStroke).toBeNull();

    state = maskEditorReducer(state, {
      pointerId: 2,
      point: { x: 1, y: 1 },
      type: 'pointer_start',
    });
    state = maskEditorReducer(state, { pointerId: 2, type: 'pointer_end' });
    const painted = state.document.rgba;
    state = maskEditorReducer(state, { type: 'undo' });
    expect(state.document.cursor).toBe(0);
    state = maskEditorReducer(state, { type: 'redo' });
    expect(state.document.rgba).toEqual(painted);
    state = maskEditorReducer(state, { type: 'clear' });
    expect(classifyMaskRgba(state.document.rgba)).toBe('empty');
  });

  it('atomically cancels a stroke that exceeds interpolated raster work', () => {
    let state = createMaskEditorState({ diameter: 48, height: 2_048, width: 2_048 });
    state = maskEditorReducer(state, {
      pointerId: 1,
      point: { x: 0, y: 0 },
      type: 'pointer_start',
    });
    for (let index = 1; index <= 10; index += 1) {
      state = maskEditorReducer(state, {
        pointerId: 1,
        point: { x: index % 2 === 0 ? 0 : 2_047, y: 0 },
        type: 'pointer_move',
      });
    }
    expect(state.activeStroke).toBeNull();
    expect(state.document.history).toHaveLength(0);
    expect(state.error).toMatchObject({ code: 'stroke_work_exceeded' });
    state = maskEditorReducer(state, { type: 'clear_error' });
    expect(state.error).toBeNull();
  });

  it('keeps pointer cancellation and undo atomic for a whole gesture', () => {
    let state = createMaskEditorState({ diameter: 1, height: 10, width: 100 });
    state = maskEditorReducer(state, {
      pointerId: 1,
      point: { x: 0, y: 2 },
      type: 'pointer_start',
    });
    for (let x = 1; x < 100; x += 1) {
      state = maskEditorReducer(state, {
        pointerId: 1,
        point: { x, y: 2 },
        type: 'pointer_move',
      });
    }
    state = maskEditorReducer(state, { pointerId: 1, type: 'pointer_cancel' });
    expect(state.document.history).toHaveLength(0);
    expect(classifyMaskRgba(state.document.rgba)).toBe('empty');

    state = maskEditorReducer(state, {
      pointerId: 2,
      point: { x: 0, y: 2 },
      type: 'pointer_start',
    });
    for (let x = 1; x < 100; x += 1) {
      state = maskEditorReducer(state, {
        pointerId: 2,
        point: { x, y: 2 },
        type: 'pointer_move',
      });
    }
    state = maskEditorReducer(state, { pointerId: 2, type: 'pointer_end' });
    expect(state.document.history).toHaveLength(1);
    state = maskEditorReducer(state, { type: 'undo' });
    expect(state.document.cursor).toBe(0);
    expect(classifyMaskRgba(state.document.rgba)).toBe('empty');
  });

  it('rejects unsafe configuration and cannot be used after disposal', () => {
    expect(() => createMaskEditorState({ height: 1, historyLimit: 51, width: 1 }))
      .toThrowError(expect.objectContaining({ code: 'invalid_history_limit' }));
    expect(() => createMaskEditorState({ diameter: 0, height: 1, width: 1 }))
      .toThrowError(expect.objectContaining({ code: 'invalid_brush_diameter' }));
    expect(() => createMaskEditorState({ height: 2_049, width: 2_049 }))
      .toThrowError(expect.objectContaining({ code: 'invalid_image_dimensions' }));
    const controller = new MaskEditorController(createMaskEditorState({ height: 1, width: 1 }));
    controller.dispose();
    expect(() => controller.undo()).toThrowError(
      expect.objectContaining({ code: 'controller_disposed' }),
    );
  });
});

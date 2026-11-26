import { describe, expect, it } from 'vitest';
import { ipcErrorMessage } from './ipcError';

describe('ipcErrorMessage', () => {
  it('strips Electron invoke-rejection wrapper AND the UserNameError domain prefix down to the clean message — the exact string collections.spec.ts observed live', () => {
    const err = new Error(
      `Error invoking remote method 'ntwine:createCollection': UserNameError: A collection named "Crate" already exists.`,
    );
    expect(ipcErrorMessage(err)).toBe('A collection named "Crate" already exists.');
  });

  it('a plain clean Error (no Electron wrapper — the shape every UserLayerStore.test.ts mock throws) passes through unchanged', () => {
    expect(ipcErrorMessage(new Error('A collection named "Drums" already exists.'))).toBe(
      'A collection named "Drums" already exists.',
    );
  });

  it('a non-Error rejection falls back to String(err)', () => {
    expect(ipcErrorMessage('just a string')).toBe('just a string');
  });

  it('a message with nested colons AFTER the prefix is left alone — only the two anchored prefixes strip, nothing deeper in the string', () => {
    const err = new Error(
      `Error invoking remote method 'ntwine:renameCollection': UserNameError: A collection named "Kicks: Live" already exists.`,
    );
    expect(ipcErrorMessage(err)).toBe('A collection named "Kicks: Live" already exists.');
  });

  it('an unexpected system error stays visible, unstripped — the strip is the LITERAL "UserNameError:" prefix, never a broad \\w+Error: pattern', () => {
    expect(ipcErrorMessage(new Error('TypeError: boom'))).toBe('TypeError: boom');
  });

  it('extra (disclosed): the same system-error guarantee holds even wrapped by Electron — the outer wrapper always strips as pure noise, but "TypeError:" is not "UserNameError:" so it stays visible', () => {
    const err = new Error(`Error invoking remote method 'ntwine:someHandler': TypeError: boom`);
    expect(ipcErrorMessage(err)).toBe('TypeError: boom');
  });

  it('both prefixes are anchored to the START of the message, not wherever the substring appears — an unanchored strip would find "Error invoking remote method \'x\': " and "UserNameError: " mid-string and corrupt this to "Not actually wrapped: gotcha"', () => {
    const err = new Error(
      "Not actually wrapped: Error invoking remote method 'x': UserNameError: gotcha",
    );
    expect(ipcErrorMessage(err)).toBe(
      "Not actually wrapped: Error invoking remote method 'x': UserNameError: gotcha",
    );
  });
});

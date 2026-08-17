import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['out/', '.vite/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  // Plain Node scripts (e.g. scripts/*.mjs) aren't type-checked, so js.configs.recommended's
  // no-undef needs the Node global environment explicitly — TS files get this for free from
  // typescript-eslint's type-aware checking, which is why this gap wasn't visible before.
  { files: ['scripts/**/*.{js,mjs,cjs}'], languageOptions: { globals: globals.node } },
);

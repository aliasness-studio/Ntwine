import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['out/', '.vite/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  // Main-process test files map raw driver-level results (better-sqlite3 rows, etc.)
  // that come back as `unknown` without an explicit generic; `no-explicit-any` forces
  // every such spot into a cast. Scoped to src/main/**/*.test.ts specifically — this is
  // a main-process-only concern (only main-side tests touch better-sqlite3/Node driver
  // results), so renderer test files keep full type-safety linting.
  { files: ['src/main/**/*.test.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
);

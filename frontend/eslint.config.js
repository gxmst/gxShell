import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

// Flat config. The goal here is to catch real defects, not to reformat the
// codebase: this repo has 13k lines of working frontend written without a
// linter, so every rule that would fire hundreds of times on correct code is
// off. Stylistic opinions stay out — tsc and review already cover those.
export default tseslint.config(
  {
    // Generated Wails bindings, build output and coverage reports are not ours.
    ignores: ['dist', 'coverage', 'wailsjs', 'node_modules'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // eslint-plugin-react-hooks v7 ships the React Compiler's analysis as
      // lint rules. They answer "could the compiler memoize this?", which is a
      // different question from "is this a bug" — and gxShell is hand-optimized
      // for React 18 with no compiler in the build: refs hold xterm instances
      // and PTY buffers on purpose, effects set state when a Wails event
      // arrives, and the memo boundaries are placed by hand to keep terminal
      // re-renders off the hot path. The four below fired ~100 times on working
      // code, which would bury the rules that do find defects. exhaustive-deps
      // and rules-of-hooks stay on. Revisit if the app adopts the compiler.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',

      // The codebase deliberately uses `any` at the Wails boundary and in error
      // handlers, where the runtime hands over untyped values. Flagging those
      // would be noise; genuine modelling gaps are a review concern.
      '@typescript-eslint/no-explicit-any': 'off',

      // Unused *code* is worth knowing about; unused *signature* parameters are
      // often required by a callback shape. Underscore opts out.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // An empty catch is how this codebase says "this failure is expected and
      // the fallback below handles it" — localStorage in private mode, an
      // optional WebGL context, dispose() on an already-torn-down addon. See
      // usePersistedState.ts for the shape.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Terminal code has to match ANSI escapes and C0 control bytes literally:
      // utils/automation.ts strips them out of labels before they reach the UI,
      // which is a sanitization step, not an accident.
      'no-control-regex': 'off',

      // Fires on escapes that are redundant to the regex engine but deliberate
      // for a human reader, and on initializations that a later branch always
      // overwrites but that document the shape of the accumulated state.
      'no-useless-escape': 'off',
      'no-useless-assignment': 'off',

      // These two catch actual bugs, so they are errors rather than warnings.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Tests run in Node-flavoured jsdom and use vitest globals.
    files: ['src/**/*.{test,spec}.{ts,tsx}', 'src/test/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // Build scripts are Node ESM, not browser code.
    files: ['scripts/**/*.mjs', '*.config.{js,ts}'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-console': 'off',
    },
  },
)

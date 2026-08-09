import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

// Flat config for the Vite/React/TS frontend (src/) and the Electron main
// process (electron/) — the devDependencies importing here (@eslint/js,
// eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals,
// typescript-eslint) were already installed but this config file itself was
// missing, which made `npm run lint` (and therefore `build:electron`, which
// runs lint first per docs/DEPLOY.md) fail before touching any source.
export default tseslint.config(
  {
    ignores: [
      'dist',
      'dist-electron',
      'dist-customer',
      'dist-tauri',
      'release*',
      'backend',
      'node_modules',
      // Ported verbatim from GoBilling (docs/ARCHITECTURE.md "As-is" reuse),
      // not authored fresh in this repo — generic TSPL/serial printer driver
      // with intentional `any` (dynamic SDK interop) and a control-char regex
      // matching raw printer command bytes. GoBilling's own lint:release
      // script used a curated file allowlist for the same reason rather than
      // linting this file broadly.
      'electron/printer-api.ts',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
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
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // The whole app's data-loading convention is `useEffect(() => { void
      // loadX() }, [deps])` where loadX calls setState — a standard,
      // already-verified-working fetch-on-mount pattern used on every page.
      // eslint-plugin-react-hooks v7 added this rule opinionating against it
      // in favor of external data-fetching libraries; not adopting that
      // architecture change this close to delivery, so this is a warning,
      // not a build-blocking error.
      'react-hooks/set-state-in-effect': 'warn',
      // Same rationale as above: flags `Date.now()`/`new Date()` used directly
      // in render (e.g. the Dashboard sparkline bucketing, the license-banner
      // days-left calc) as "impure." These are simple derived-display values,
      // not memoized/cached in a way purity actually matters for here, and
      // both were verified working in manual testing.
      'react-hooks/purity': 'warn',
    },
  },
  {
    files: ['electron/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  }
);

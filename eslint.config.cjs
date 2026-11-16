const globals = require('globals');
module.exports = [
  { ignores: ['node_modules/**', 'docs/**'] },
  {
    files: ['server.js', 'api/**/*.js', 'src/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', '*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-dupe-args': 'error', 'no-dupe-keys': 'error', 'no-duplicate-case': 'error' }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.serviceworker } },
    rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-dupe-args': 'error', 'no-dupe-keys': 'error', 'no-duplicate-case': 'error' }
  },
  { files: ['public/app.js', 'public/csvImport.js'], languageOptions: { globals: { module: 'readonly' } } },
  { files: ['tests/withdrawal-ui.e2e.js', 'tests/csv-import.e2e.js'], languageOptions: { globals: { ...globals.browser, showToast: 'readonly' } } }
];

import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    ignorePatterns: ['**/*.md', '**/*.toml', 'output/**', 'tasks/**'],
    printWidth: 100,
    semi: false,
    singleQuote: true,
    sortPackageJson: false,
  },
  lint: {
    ignorePatterns: ['output/**', 'tasks/**'],
  },
})

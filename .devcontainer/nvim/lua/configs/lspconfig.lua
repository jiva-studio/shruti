require("nvchad.configs.lspconfig").defaults()

vim.lsp.config('ts_ls', {
  init_options = {
    plugins = {
      {
        name            = '@vue/typescript-plugin',
        location        = 'vue-language-server',
        languages       = { 'vue' },
        configNamespace = 'typescript',
      },
    },
  },
  filetypes = {
    'typescript',
    'javascript',
    'javascriptreact',
    'typescriptreact',
    'vue'
  },
})

vim.lsp.config('vue_ls', {})
vim.lsp.enable({'ts_ls', 'vue_ls'})

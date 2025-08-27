require "nvchad.options"

-- add yours here!

local o = vim.o
o.cursorlineopt ='both' -- to enable cursorline!
vim.api.nvim_set_hl(0, "FlashLabel", { fg = "#ffffff", bg = "#ff0055", bold = true })

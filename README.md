# kflat-lsp

Thin LSP bridge for KFlat. On file open and save it runs
`komp check --diagnostic-format=json` on the file's crate (nearest ancestor
with a `kf.toml`) and republishes the diagnostics to the editor. Outline,
folding, hover, inlay-hint, selection-range, signature-help, completion,
rename, go-to-definition, find-references and semantic-token requests run
`komp query` over the one file instead. Code actions are answered from the
fixes the last check's diagnostics carried, without re-running it. The
compiler is the single source
of truth — this server never parses `.kf` itself.

Zero dependencies; requires Node 18+ and a `komp` binary built from a tree
that includes the `--diagnostic-format=json` flag (commit `8573097` or later).

## Setup

Point the server at your komp binary via `KOMP_BIN` (defaults to `komp` on
`PATH`):

```sh
KOMP_BIN=/path/to/komp node server.js
```

The server speaks LSP over stdio. It negotiates `positionEncoding: utf-8`
when the client offers it and converts byte columns to UTF-16 otherwise.

## Neovim

```lua
vim.filetype.add({ extension = { kf = "kflat" } })

vim.api.nvim_create_autocmd("FileType", {
  pattern = "kflat",
  callback = function(args)
    vim.lsp.start({
      name = "kflat-lsp",
      cmd = { "node", vim.fn.expand("~/path/to/kf-lsp/server.js") },
      root_dir = vim.fs.root(args.buf, "kf.toml"),
      cmd_env = { KOMP_BIN = vim.fn.expand("~/path/to/komp/.build/komp") },
    })
  end,
})
```

Diagnostics refresh on `:w` (the bridge checks saved state, not the live
buffer). `documentSymbol` and `foldingRange` are answered on request and read
the saved file too, so an outline reflects the last write.

## VS Code

Use the extension in [kf-extensions](https://github.com/komp-co/kf-extensions) instead. VS Code cannot attach a bare stdio server,
and the extension host already exposes a diagnostics API, so the extension
runs `komp check` directly rather than going through this bridge. It also
ships the generated TextMate grammar, which this server has no way to
provide.

## Behavior and limits

- Runs one check per crate at a time; a save during a running check queues
  exactly one re-run.
- Diagnostics for other files in the crate (and its deps) are published too,
  and cleared when a later check no longer reports them.
- Checks the nearest enclosing crate only — an error that only manifests in a
  downstream crate won't appear until you save a file there.
- The crate root is passed to komp as an absolute path deliberately: crate
  dedup mis-canonicalizes relative paths whose `..` escape the invocation
  directory (see `canonicalize_path` in `compiler/kf-driver/src/multi_crate.kf`).
- `komp query symbols`, `folding` and `selection` only parse, so the
  outline, the fold gutter and expand-selection keep answering on a file
  that does not type-check.
- Hover, inlay hints, signature help and find-references resolve names, so they run the
  checker over the file's whole crate — a hover costs about what a `komp check` costs, and a
  file with no `kf.toml` above it gets no answer at all.
- A symbol's selection range is the whole declaration: komp does not record
  where a name token sits inside one yet.

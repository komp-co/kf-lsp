# kflat-lsp

The KFlat language server. Two servers live here while one replaces the
other:

- **`kflat_lsp`, in KFlat (`src/`),** is the server going forward. It keeps
  one `kflatc serve` running and hands it the editor's unsaved text, so
  diagnostics and the outline follow typing instead of saves. Today it
  answers diagnostics, document symbols, folding ranges, selection
  ranges, hover, go-to-definition, find-references, signature help,
  completion, inlay hints, semantic tokens and rename.
- **`server.js`, the Node bridge,** answers the same by running
  `komp query` per request, on saved files, and code actions besides. It
  goes away once the KFlat server answers code actions too.

## The KFlat server

It talks to the compiler only through `kflatc serve`, whose protocol is
stable (the KFlat book's "The compiler as a service" chapter), never through
the compiler's own crates. `komp metadata` tells it where that kflatc is and
how the workspace is laid out.

On the first opened file it runs `komp check` on the workspace once, so every
dependency's interface is built, then starts `kflatc serve`. Each open and
edit is staged with the compiler, and the file's crate is checked once typing
pauses for 300 ms. The questions that need types (hover, definition,
references, signature help, completion, inlay hints, semantic tokens and
rename) type the file's crate and what it loads once, and answer from that
until the next edit. A rename the compiler refuses, because the new name is
taken or is not a name, fails with the compiler's reason. Diagnostics for every file of that crate are published,
and cleared when a later check no longer reports them. It negotiates
`positionEncoding: utf-8` when the client offers it, and counts UTF-16 code
units otherwise.

### Building it

`kflatc serve` is newer than the latest release, so build with a komp from
komp's `development` branch, checked out beside this repository (`kf.toml`
names its `std` there):

```sh
git clone -b development https://github.com/komp-co/komp ../komp
git clone https://github.com/komp-co/json ../json
git -C ../json checkout "$(cat ../komp/bootstrap/json.rev)"
(cd ../komp && sh scripts/refresh-komp.sh)
../komp/.build/komp build .        # target/kflat/kflat_lsp
```

Run it with `KOMP_BIN` naming that komp (`komp` on `PATH` otherwise). It
speaks LSP over stdio, like the bridge.

### Testing it

```sh
../komp/.build/komp test .
KOMP_BIN=../komp/.build/komp python3 tests/session.py target/kflat/kflat_lsp
```

`tests/session.py` drives one editor session end to end: an error published
where it is, then cleared by a fix typed in three quick edits that are
checked once, then the outline, folds and selection of the unsaved text, a
hover before and after an edit, the definition, references and signature of
a call, and the hints, tokens, completions and renames of a later edit.

### Limits for now

- Code actions answer MethodNotFound; the bridge still has them.
- Only the crate holding the edited file is checked. A crate that depends on
  it sees its interface as of the last `komp check` or save.
- Memory grows with each check: the compiler does not yet free a check's
  state. Restarting the server clears it.

## The Node bridge

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

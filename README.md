<img src="https://raw.githubusercontent.com/komp-co/kf-extensions/main/brand/kiwi.svg" width="96" alt="The KFlat paper kiwi">

# kf-lsp

The KFlat language server, written in KFlat and published to the package
index as `komp_lsp`. It keeps one `kflatc serve` running and hands it the
editor's unsaved text, so every answer follows typing instead of saves. It
answers diagnostics, quick fixes, document symbols, folding ranges, selection
ranges, hover, go-to-definition, find-references, signature help, completion,
inlay hints, semantic tokens and rename.

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
taken or is not a name, fails with the compiler's reason. Quick fixes are the
repairs the last check's diagnostics carried, offered on the diagnostic's
line without checking again. Diagnostics for every file of that crate are
published, and cleared when a later check no longer reports them. It negotiates
`positionEncoding: utf-8` when the client offers it, and counts UTF-16 code
units otherwise.

## Installing it

```sh
komp install komp_lsp
```

An editor then starts `komp lsp` in the project's directory, and talks LSP to
it over stdio. komp runs the version the project's `[tools]` table pins, else
the installed one, and hands its process to it, so stopping the server leaves
nothing behind. The server asks the komp that started it about the project
(`KOMP_BIN` overrides that, `komp` on `PATH` otherwise).

## Building it

Build it with an installed kflat: a release from 0.5.1 on, the version in
`kflat-version` being the one CI builds with.

```sh
komp build .        # target/kflat/komp_lsp
```

## Testing it

```sh
komp test .
python3 tests/session.py target/kflat/komp_lsp
```

`tests/session.py` drives one editor session end to end: an error published
where it is, then cleared by a fix typed in three quick edits that are
checked once, then the outline, folds and selection of the unsaved text, a
hover before and after an edit, the definition, references and signature of
a call, the hints, tokens, completions and renames of a later edit, and the
quick fix for a misspelt method.

## Neovim

```lua
vim.filetype.add({ extension = { kf = "kflat" } })

vim.api.nvim_create_autocmd("FileType", {
  pattern = "kflat",
  callback = function(args)
    local root = vim.fs.root(args.buf, "kf.toml")
    vim.lsp.start({ name = "komp-lsp", cmd = { "komp", "lsp" }, cmd_cwd = root, root_dir = root })
  end,
})
```

For highlighting, point a TextMate-compatible plugin at the grammar in
[kf-extensions](https://github.com/komp-co/kf-extensions).

## Limits for now

- Only the crate holding the edited file is checked. A crate that depends on
  it sees its interface as of the last `komp check` or save.
- Memory grows with each check: the compiler does not yet free a check's
  state. Restarting the server clears it.

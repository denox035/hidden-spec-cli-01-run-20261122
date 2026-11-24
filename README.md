# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/denox035/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/denox035/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in
four formats, and `mend` reads all four to one specification: a unified diff (often with wrong
line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON.
Every file is changed or nothing is.

Built for the [make.fun competition](https://make.fun/c/hidden-spec-cli-01-run-20261122)
"Build mend, one patch tool for every AI edit format".

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When `PATCH` is
  absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or
  `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` when the tree is written (or would be, with `--check`), `1` when one or
more edits failed (nothing is written, every failure is reported), `2` for a usage,
missing-patch, format or parse error.

## How it works

- **Three-tier line matching.** Old lines are found at the first tier where they occur:
  exact (tier 0), trailing whitespace ignored (tier 1), leading and trailing whitespace
  ignored with re-indentation (tier 2). `--strict` tries tier 0 only.
- **Unified diffs.** Sections, hunks, creates, deletes, renames and moves; hunks apply at
  the occurrence nearest their (possibly wrong) line number, with the `\ No newline at end
  of file` rules for final line breaks.
- **SEARCH/REPLACE blocks.** The path is the nearest non-blank, non-fence line before the
  block (falling back to the previous block's path); old text must occur exactly once.
- **V4A patches.** Add / Delete / Update File sections, `Move to:`, anchored chunks with a
  cursor, and end-of-file chunks.
- **JSON edits.** `create`, `str_replace` and `insert`, as one JSON array or as JSON Lines.
- **Atomic.** Edits apply in order to the tree as earlier edits left it; a failed edit
  changes nothing, and when any edit fails no file is written at all.

## Files

- `main.ts` — the whole CLI. Node 22 standard library only; run it directly, no build step.
- `runner.ts` — the kit's trial runner (unchanged from the kit).
- `LICENSE` — MIT.

## License

MIT. See [LICENSE](LICENSE).

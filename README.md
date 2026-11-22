[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Vikkry88/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Vikkry88/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend: one patch tool for every AI edit format

mend applies an edit that an AI model wrote to a tree of text files. It reads all four formats models write, finds
the lines each edit names even when the model drifted their whitespace or indentation, and changes every file or
none. `SPEC.md` is the whole contract; this implementation follows it sentence by sentence.

Run it as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` (Node 22, standard library only) with the
working directory as the root of the tree. Without `PATCH` (or with `-`) the patch is read from standard input.

## Formats

- **Unified diffs** (`unified`): `diff --git` sections and bare `---`/`+++` sections, creations (`/dev/null`,
  `new file mode`), deletions, renames (`rename from`/`rename to`, differing old/new paths) and changes. Hunk line
  numbers may be wrong: each hunk takes the occurrence nearest its stated position (adjusted for earlier hunks in
  the section), and `\ No newline at end of file` lines control the final line break when a hunk touches the end
  of the file. Prose and code fences around the diff are ignored.
- **SEARCH/REPLACE blocks** (`search-replace`): `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks with the
  path on the nearest preceding non-blank, non-fence line (reused when a block names none). Empty old text creates
  the file; otherwise the old lines must occur exactly once.
- **V4A patches** (`v4a`): `*** Begin Patch` … `*** End Patch` with Add/Delete/Update File sections, `*** Move to:`
  renames, `@@` anchor lines, a forward cursor across chunks, and `*** End of File` chunks anchored to the last line.
- **JSON edits** (`json`): one array of edit objects or JSON Lines with `create` (byte-for-byte `file_text`),
  `str_replace` (exact, counted with overlap, CRLF-aware) and `insert` (by line number).

With `--format=auto` (the default) the format is detected in SPEC section 4 order: V4A, JSON, SEARCH/REPLACE,
then unified.

## Fuzzy matching and atomicity

Old lines are matched at the first of three tiers that finds them: tier 0 exact, tier 1 ignoring trailing spaces
and tabs, tier 2 ignoring leading and trailing spaces and tabs. Context lines are always written back as the
file's own lines, and at tier 2 new lines are re-indented from the patch's indent to the file's. `--strict`
restricts matching to tier 0. Files keep their own line break (LF or CRLF) and final-break state, except where a
unified hunk's `\` line says otherwise.

Edits apply in patch order to the tree as earlier edits left it, every path is checked for safety first, a failed
edit changes nothing, and when any edit fails nothing is written at all (exit 1, one `error: <code> <path>` line
per failure). On success it prints one `A`/`D`/`M`/`R` line per changed path in byte order and `ok: <n> files`;
`--check` prints the same without writing. Usage, unreadable-patch, undetected-format and parse failures exit 2
with a single `error:` line.

## Files

- `main.ts`: the CLI. In a trial it hands over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's trial runner (kept as shipped).
- `check.ts`: runs the public practice set locally: `node check.ts <practice.json>`.
- `SPEC.md`: the specification. `LICENSE`: MIT.

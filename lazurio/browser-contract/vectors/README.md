# The Environment browser's contract: its vectors

The executable vectors are the truth of the Environment browser's contract
(decision F50 point 4). The Platform runs every case against its module
(`tests/browser-contract-vectors.test.ts`), and each fork runs the same files
against its own copy of the module, in every toolchain that imports it. Like
the module, this directory is licensed under MIT (`../LICENSE`).

`v1/` holds one file per contract: `remote-tab-ids` (C1), `strips` (C2),
`view-addresses` (C3), `boot-clock` (C4), `holder-files` (C5), `live-tabs`
(C6), `agent-browser` (C7), `messages` (C8 and C9), `new-tab` (C10), `cli`
(C13), `times` (C14), `framing` (C15), `address-bar` (C16) and `language`
(C17). C11 and C12 are internal to the Platform: their shapes live in the
module's `platform.ts`, which no fork takes, and have no vectors. Within v1
a file only gains cases. A changed
expectation is a change of the contract's major (F50 point 3), seen in review
as a changed line, not an added one. So a case pins only what v1 keeps: no
log wording, no member a release may add, no refusal a later v1 may lift (a
MausBot session name, agent-browser's own resolution of its socket
directory), and of letting go of a window only its outcome, not the line the
daemon hears.

## A vector file

```json
{
  "schema": "lazurio.browser-vectors.v1",
  "contract": "<the file's name without .json>",
  "cases": [{ "name": "…", "call": "…", "args": […], "expect": … }]
}
```

A case calls the module's export `call` with `args` and expects `expect`. A
case of a value export (a constant such as `holderSchema`) has no `args` and
expects the value. Each export has at least one case, and no case names
anything else. `call` and `name` together are unique within a file.

## How a result matches

- An object matches by the members the case names: a result may hold more,
  since a release may add members within v1. Each named member matches by
  the same rule.
- A list matches element by element and has exactly as many elements.
- A Map (`{"$map": …}` below) matches entry by entry, with exactly these keys.
- `{"$json": value}` in `expect` matches a text that is JSON of a value that
  matches `value`, so a written file is compared by its members, not by its
  bytes.
- Anything else matches when it is equal.

## What stands for what JSON lacks

These objects stand for a value in `args`, in `expect` and in a file's text:

| Marker | Stands for |
| --- | --- |
| `{"$": "undefined"}` | `undefined` |
| `{"$": "throws"}` | as `expect`: the call throws, or its promise rejects |
| `{"$map": {"key": value}}` | a `Map` of those entries |
| `{"$json": value}` | in `args` and a file's text: the JSON text of `value`; in `expect`: as above |
| `{"$repeat": "x", "times": n}` | the text repeated `n` times |
| `{"$ids": n}` | the target ids 1 to `n`, 32 hexadecimal digits in upper case |

## A case of the Node part

It runs in a directory of its own, made for the case and removed after it.

- `directory`: the directory before the call. A file by its path relative to
  the directory, with its text (a string, or `{"$json": value}`), or
  `{"unreadable": true}`, a file of mode 000 with an optional `text`. A path
  that ends in `/` is a directory: `{}`, or `{"unreadable": true}` for one
  that cannot be listed. Modes are set after every file is written, so a
  file can lie in a directory that cannot be listed.
- In `args` and `expect`, a text that begins with `$dir` begins with the
  case's directory instead. `"$read"` is a reader of a file below it by an
  absolute path (`/proc/uptime` reads `<directory>/proc/uptime`). `"$alive"`
  answers whether a process id is one of the case's `alive` list. `"$pid"` is
  the runner's own process id. `"$changed"` is a callback that counts its
  calls, for a watch.
- `daemon`: a daemon listening on a Unix socket below the directory,
  `socket` being its path there. It reads one line and answers `reply` and
  a newline, or closes without an answer when `reply` is null. After
  answering it removes the files of `removes`, and with `locks` it makes its
  directory unreadable (mode 000). With `unreadable` its socket has mode 000
  and cannot be opened.
- `heard`: the lines the daemon read, without their newline.
- `after`: the directory after the call, exactly these entries. A file's
  `text` is compared as it is, its `json` as `{"$json": …}` above, and a
  `mode` (octal, such as `"600"`) where it is given; a directory ends in `/`.
- `steps`: a call whose result is driven further. For a reader (a function
  that reads again), each step lays out the directory anew from its
  `directory` and expects one reading, its `expect`. For a watch (`retry` and
  `stop`), a step writes the file `write` until a change is reported (with
  `changed`), makes the directory `mkdir`, or calls `retry`. The runner stops
  the watch after the last step.

## Running them in a fork

A fork vendors the module and this directory together, by digest, from the
release's attested shell artifact (F50 point 5), and runs every case with a
runner like the Platform's `tests/browser-contract-vectors.test.ts`. Its CI
also runs the cases about its own code that F50 point 4 names.

- A `daemon` case needs Unix sockets: the Platform skips it on Windows. The
  socket's path must stay within the system's limit (104 bytes on macOS), so
  the case's directory belongs under a short temporary directory.
- A case with a mode-000 file, socket or directory assumes a runner that is
  not root, since root reads such a file anyway.
- A watch case waits for the file system's notice, up to 5 s per step.

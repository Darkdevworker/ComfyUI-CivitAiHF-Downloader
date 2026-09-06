# Where to take it next

Ideas for the extension, in the order I would do them. Everything here was
checked against the code as it stands, so the "already there" notes are real
and the gaps are gaps.

Sizes are rough: **S** = an evening, **M** = a weekend, **L** = a week or more.

---

## 1. Make tags clickable — the `tag` filter is built but unreachable  **S**

The biggest thing sitting half-finished in this repo.

`server.py` already reads a `tag` parameter, forwards it to Civitai, and even
caches on it. Nothing in `js/civitai.js` ever sends it. Meanwhile the detail
modal already renders up to eight tags as `.cvt-tag` chips — they are just
inert text.

This is exactly the creator filter from the last commit, one more time:

- a **Tag** field in the search bar, or
- make the chips in the detail modal clickable → filter by that tag, and
- optionally show tags on the cards too.

Half a day of work for a whole new axis of search, using a code path that is
already written and already tested by the server. I would do this first.

## 2. Continuous integration  **S**

There are issue and PR templates but no workflow, so the 763 tests only run
when someone remembers to run them. A single `.github/workflows/tests.yml`
that runs the Python and JS suites on every push would catch the class of bug
that a refactor like the page-fill change can introduce. Cheap, and it makes
every item below this one safer to attempt.

## 3. "You already have this"  **M**

Every downloaded model gets its SHA256 saved to a `.civitai.json` sidecar, and
the local manager already hashes models in the background. Civitai returns
file hashes in its API. Wire those together:

- On a card, mark models whose hash is already on disk — **"have it"** instead
  of **Download**.
- In the local manager, flag models that are also on Civitai and show whether
  a newer version exists.

This is the single feature that would change how the extension feels to use:
it turns a downloader into a library. The plumbing is 90% there.

## 4. Duplicate finder  **M**

The same hash data powers a local-only win: find models that appear in more
than one folder. ComfyUI setups accumulate these constantly (a checkpoint
copied into `checkpoints/` and `models/checkpoints/`, LoRAs duplicated across
diffusers installs). Show them, with sizes, and offer to remove the copies
while keeping the one in the right folder. No network needed, and it makes
the disk-usage readout actionable.

## 5. Verify downloads, and resume them  **M**

Downloads are hashed *after* they land, but the result is not compared against
what Civitai said the file should be. For a 12 GB checkpoint on a shaky
connection, a silent truncation is the worst possible failure — it looks fine
until it fails to load.

- Compare the computed SHA256 with the one Civitai advertised; on mismatch,
  say so and offer a retry.
- Support HTTP `Range` resumption so a retry picks up at 90% instead of 0%.

## 6. A queue that survives a restart  **M**

The download queue lives in memory. ComfyUI restarts are frequent, and losing
a queue of twenty models is painful. Persisting jobs to the same store
bookmarks already use, with resume-on-start, is a contained change and a
reliability feature rather than a shiny one.

## 7. Save searches  **S**

Filters currently reset when you leave the tab. Remembering the last filter
set across restarts is a few lines. Saving *named* searches ("SDXL写实",
"Pony illustrations") as bookmarkable entries is slightly more, and turns
repeated hunting into one click.

## 8. Resolve models inside a workflow  **L**

The Prompt Fetcher node proves the pattern. The bigger version: a node that
takes a Civitai URL or model ID and outputs the **local path**, downloading
on demand if it is missing. Workflows then reference models by Civitai ID
instead of a filename, and they keep working on a fresh machine.

This is the most ambitious item here and the one that would make the
extension indispensable rather than convenient, but it needs care around
downloads triggered from graph execution.

## 9. Smaller polish, each an hour or two  **S**

- **Keyboard shortcuts for paging** — `←`/`→` already navigate cards, but
  there is no key for Prev/Next page. `[` and `]` would fit the existing map.
- **Show the band on every card** — the badge exists; making it consistent
  between the grid, the detail modal and the local manager would remove the
  last guesswork about what you are about to download.
- **Copy a model's URL** from the detail modal, next to "copy path".
- **A "downloaded" filter** in the local manager, from the Civitai metadata
  sidecars.

---

## A note on what not to add

The band system, the paging, and the image pipeline are now the parts with
real tests behind them. Anything new that touches search or downloads should
get the same treatment — the suite is the reason the last few changes could
be made confidently.

Two things I would avoid:

- **Anything that searches on a keystroke or a tick.** Every request to
  Civitai costs the user's patience, and the page-fill work only pays off if
  a page is one request rather than a burst.
- **More per-card data.** Previews are already re-encoded and lazy-loaded;
  adding weight to 24 cards at once undoes that.

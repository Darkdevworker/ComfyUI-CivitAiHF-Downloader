# Where to take it next

Ideas for the extension. Everything here was checked against the code as it
stands, so the "already there" notes are real and the gaps are gaps. The
downloader section comes first because it is the half people use most.

Sizes are rough: **S** = an evening, **M** = a weekend, **L** = a week or more.

---

# Downloader

Focused on the download half. To save suggesting something you already have,
these all exist: cancelling a job, retrying a failed one with its original
payload, the Civitai API key for login-required models, SHA256 sidecars,
metadata and preview images, trigger words pulled from Civitai, the mirror
domains (`civitai.com` / `.red` / `.work`), export to a list, auto-tag,
auto-organize and the cleanup scan.

The gaps are these.

## D1. Limit how many downloads run at once  **S**

The clearest one, because it is closer to a bug than a feature. Every job
starts its own thread the moment it is queued — there is no queue depth
anywhere. Ask for twenty models and twenty transfers begin together, which is
how you get throttled by Civitai, stall on disk contention, and end up with
six half-written files instead of four finished ones.

A "download 1 / 2 / 4 at a time" setting, with the rest waiting their turn,
would make large batches finish sooner and fail less. I would do this before
anything else here.

## D2. Resume an interrupted download  **M**

There is no `Range` support anywhere in the download path. A transfer that
dies at 90% starts again from zero. For a 12 GB checkpoint that is the whole
difference between a retry costing seconds and costing an hour — and it is
the most common failure, because big downloads are exactly the ones that get
interrupted.

Keeping the partial file and resuming it would also make a restart of
ComfyUI survivable.

## D3. Refresh ComfyUI's model lists when a download lands  **S**

After a checkpoint downloads, none of ComfyUI's model dropdowns know about it
until you refresh the page or hit the refresh button. The extension could do
that itself, so a model is usable the moment it finishes. Small, and it
removes the one manual step between "downloaded" and "in a workflow".

## D4. Check the disk before starting  **S**

A download that fails at 99% with "no space left on device" is the most
annoying version of failure. Compare the file size against the free space on
the destination before the first byte, and say so up front.

## D5. Naming templates  **M**

Right now the destination is an auto-named subfolder plus a free-text rename
field. A template — `{creator}/{model}/{base_model}/{version}.{ext}`, with
live preview of the result — makes a library of hundreds of models
predictable, and it is the kind of thing people set once and then rely on
for years.

## D6. Queue several models straight from the grid  **M**

Batching currently means the files of one model, one at a time. A selection
mode on the cards — tick the ones you want, then "Queue 6 models" — would
fit how people actually browse: find a creator you like, take five.

## D7. "You already have this"  **M**

Every model already gets a SHA256 sidecar, and the local manager already
hashes in the background. Compare before downloading: mark the cards you own,
and offer to skip rather than fetch again. The same data answers "do I have a
newer version of this?" (D8).

## D8. Tell me when a model I own has an update  **M**

Civitai resolves a model by hash, and you store those hashes. A periodic
check — "4 of your models have newer versions" — turns the local manager from
an inventory into something that maintains itself.

## D9. Pause, not just cancel  **S**

Cancelling exists; pausing does not. Resuming a paused job needs D2 first, so
these two pair up.

## D10. A queue that survives a restart  **M**

`DOWNLOAD_TASKS` is a plain dictionary in memory. ComfyUI restarts often, and
losing a queue of twenty models hurts. Persisting jobs to the store bookmarks
already use, with resume-on-start, is a reliability feature rather than a
shiny one.

## D11. Download history  **S**

A log of what was downloaded, when, from which URL and to where. Separate
from the queue, which clears itself. It is what you reach for when you want
to re-fetch something, work out where a file came from, or audit a library
built up over a year.

## D12. Speed limit and scheduling  **M**

Cap bandwidth so browsing stays responsive while a batch runs, and optionally
let big downloads run at night. Niche, but the people who want it really
want it.

---

# Everything else

The browse and library side, in the order I would do them.

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

## 3. Duplicate finder  **M**

The same hash data powers a local-only win: find models that appear in more
than one folder. ComfyUI setups accumulate these constantly (a checkpoint
copied into `checkpoints/` and `models/checkpoints/`, LoRAs duplicated across
diffusers installs). Show them, with sizes, and offer to remove the copies
while keeping the one in the right folder. No network needed, and it makes
the disk-usage readout actionable.

## 4. Verify a download against the hash Civitai advertised  **S**

Downloads are hashed *after* they land, but the result is never compared with
what Civitai said the file should be. For a 12 GB checkpoint on a shaky
connection, a silent truncation is the worst possible failure — it looks
fine until it fails to load. (Resuming is D2; retrying is already there.)

## 5. Save searches  **S**

Filters currently reset when you leave the tab. Remembering the last filter
set across restarts is a few lines. Saving *named* searches ("SDXL写实",
"Pony illustrations") as bookmarkable entries is slightly more, and turns
repeated hunting into one click.

## 6. Resolve models inside a workflow  **L**

The Prompt Fetcher node proves the pattern. The bigger version: a node that
takes a Civitai URL or model ID and outputs the **local path**, downloading
on demand if it is missing. Workflows then reference models by Civitai ID
instead of a filename, and they keep working on a fresh machine.

This is the most ambitious item here and the one that would make the
extension indispensable rather than convenient, but it needs care around
downloads triggered from graph execution.

## 7. Smaller polish, each an hour or two  **S**

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

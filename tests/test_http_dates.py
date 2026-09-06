"""
Finding 11: `datetime.utcfromtimestamp` is deprecated on Python 3.12+.

The same three lines held a worse, silent bug:

    dt = datetime.strptime(ims, "%a, %d %b %Y %H:%M:%S %Z")
    if mtime <= dt.timestamp():

strptime with %Z parses "GMT" but returns a *naive* datetime, so
.timestamp() then read it as local time. On a machine at UTC+5:30 every
If-Modified-Since was treated as 5h30m older than it was, so previews were
re-sent that should have been 304s.

Both now go through email.utils, which knows the HTTP date format and the
GMT zone. Run with:  python3 tests/test_http_dates.py
"""

import calendar
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "..", "server.py"), encoding="utf-8").read()

PASS = FAIL = 0


def eq(actual, expected, label):
    global PASS, FAIL
    if actual == expected:
        PASS += 1
    else:
        FAIL += 1
        print(f"  x {label}\n      expected {expected!r}\n      actual   {actual!r}")


def ok(cond, label):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print(f"  x {label}")


def reject(text, needle, label):
    ok(needle not in text, label)


def check(text, needle, label):
    ok(needle in text, label)


print("the deprecated call is gone")
reject(SRC, "utcfromtimestamp", "no datetime.utcfromtimestamp anywhere")
reject(SRC, 'strptime(ims, "%a, %d %b %Y %H:%M:%S %Z")', "nor the naive strptime")
check(SRC, "from email.utils import formatdate, parsedate_to_datetime",
      "email.utils is imported instead")
check(SRC, "formatdate(mtime, usegmt=True)", "Last-Modified is emitted in GMT")
check(SRC, "since = parsedate_to_datetime(ims)", "If-Modified-Since is parsed properly")
check(SRC, "if since and mtime <= since.timestamp()", "and the parse result is checked")

print("Last-Modified is a valid HTTP date")
from email.utils import formatdate, parsedate_to_datetime

stamp = 1760000000
header = formatdate(stamp, usegmt=True)
ok(header.endswith("GMT"), f"it is marked GMT: {header!r}")
ok(", " in header and header.count(":") == 2, f"it looks like an HTTP date: {header!r}")
eq(int(parsedate_to_datetime(header).timestamp()), stamp, "and round-trips to the same instant")

print("an HTTP date parses to the right instant whatever the machine's zone")
# A fixed instant, expressed the way a browser would send it.
header = "Sun, 06 Sep 2026 08:14:13 GMT"
expected = calendar.timegm((2026, 9, 6, 8, 14, 13, 0, 0, 0))

original_tz = os.environ.get("TZ")
for zone in ("UTC", "Asia/Kolkata", "America/New_York", "Australia/Sydney"):
    os.environ["TZ"] = zone
    if hasattr(time, "tzset"):
        time.tzset()
    got = int(parsedate_to_datetime(header).timestamp())
    eq(got, expected, f"{zone}: the parsed date is the real instant")

    # and show the old approach really was wrong away from UTC
    if zone != "UTC":
        from datetime import datetime
        naive = datetime.strptime(header, "%a, %d %b %Y %H:%M:%S %Z")
        ok(int(naive.timestamp()) != expected,
           f"{zone}: the old strptime + timestamp() would have been off")

if original_tz is None:
    os.environ.pop("TZ", None)
else:
    os.environ["TZ"] = original_tz
if hasattr(time, "tzset"):
    time.tzset()

print("a malformed date is handled without raising")
for bad in ("", "not a date", "Sun, 06 Sep 2026", "Sun, 99 Zzz 2026 99:99:99 GMT"):
    try:
        parsedate_to_datetime(bad)
        ok(True, f"{bad!r} does not raise")
    except Exception as exc:
        # parsing may raise; the route catches TypeError/ValueError/OverflowError
        ok(isinstance(exc, (TypeError, ValueError, OverflowError)),
           f"{bad!r} raises something the route catches, not {type(exc).__name__}")

print("the route catches exactly what the parser can throw")
route = SRC[SRC.index('@routes.get("/civitai/local-preview")'):SRC.index("_preview_cache_dir = os.path.join(")]
check(route, "except (TypeError, ValueError, OverflowError):",
      "it catches the parser's exceptions by name, not bare Exception")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)

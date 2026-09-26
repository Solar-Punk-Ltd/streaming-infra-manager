# SRT ingest health: how the link from the broadcaster is holding up

A stream deployment takes its broadcast in over SRT. SRT sends a missing packet
again, and gives up on it once it could only arrive later than the latency the
link runs with. A packet SRT gave up on is a hole in the video, and it shows as
broken blocks of picture until the next keyframe. The **SRT ingest** card on a
deployment's page says, for the last minute, how many packets arrived, how many
went missing, how many came on a second try and how many were given up on, and
what to change when the link is losing picture.

Status, 2026-09-25. Merged to `main` through PR 45. It was built on
`feat/srt-ingest-health`, branched from `main` at `87673c99` on 2026-09-23 and
written at `2cf0b1eb` on that branch, with the stack pinned at `v3.1`
(`2c4867ae`). Not deployed, and never run against a live SRS.
The parser is tested on the lines of 2026-09-22 and the reads against a
stand-in Docker. The whole read was also run against this laptop's Docker 29.8
daemon, through a throwaway container printing those two lines in colour codes
beside the webhook line with a token, the publisher's address and forty drop
warnings a second: sixteen reports summed, a bad verdict, 252 ms, and no token,
address or connection id in the answer. That run found the window ending up to
a second in the past, which `2cfcfc79` fixed. The first look at a live host is
still the check that SRS 6 writes the line in this shape there. The SRT latency
setting the remedy points at came with PR 44, which reached `main` on
2026-09-24, before this one. PR 45 was revised on 2026-09-23 for three points of
Copilot's review: the card on a stopped deployment, a bad minute with nothing
received, and a latency the remedy named that some deployments do not run with.

## Why it exists

On 2026-09-22 an outside tester broadcast over SRT into a manager-deployed SRS
and the recording came out with broken blocks of picture for five hours. OBS,
the manager and the uploader all looked healthy. The reason was only in SRS's
own log, which said every ten seconds that about six percent of the packets had
been dropped:

```
[2026-09-22 17:33:50.386][INFO][1][4ek6chsn] <- SRT_CPB Transport Stats # pktRecv=6500, pktRcvLoss=394, pktRcvRetrans=381, pktRcvDrop=397
[2026-09-22 17:34:00.410][INFO][1][4ek6chsn] <- SRT_CPB Transport Stats # pktRecv=6457, pktRcvLoss=367, pktRcvRetrans=350, pktRcvDrop=366
```

## Where the numbers come from

SRS prints that line for each SRT publisher at its print interval, ten seconds
unless `pithy_print_ms` says otherwise, which the stack's template does not. It
clears libsrt's counters as it reads them, so each line counts its own interval
only (`do_publishing` in SRS's `srs_app_srt_conn.cpp`). The bracket before the
message is SRS's id for the connection. The line is printed only while packets
arrive, so a publisher that stopped sending prints nothing. The four counts, as
libsrt's statistics define them:

- `pktRecv`, data packets received.
- `pktRcvLoss`, packets detected missing.
- `pktRcvRetrans`, retransmitted packets received.
- `pktRcvDrop`, packets the receiver gave up on and never delivered, which is
  what becomes a hole in the video.

SRS's HTTP API does not expose these counters (SRS issue 4554), so the log is
the only source there is.

## What the manager reads, and what it never hands on

`GET /profiles/:name/srt-ingest`, behind the session, one deployment at a time.
`manager/src/domain/srtIngest/SrtIngestHealthService.ts` does the reading.

- **The window.** The last 60 seconds of the `srs` container's log, and of those
  at most the last 20,000 lines (`SRT_INGEST_LOG_WINDOW`). Under loss libsrt
  writes a line per dropped packet into the same log, `RCV-DROPPED 1 packet(s).
  Packet seqno %861816580 delayed for 4.5 ms`, about forty a second on
  2026-09-22, so a read that asked for the whole log would grow by megabytes a
  minute. The daemon applies the window before it sends anything, and both of
  its ends carry milliseconds, since a whole second put `until` behind the
  present and cut the newest lines. The local read also stops at 16 MiB, half a
  second after the last byte, or five seconds in, whichever comes first. Against
  the local daemon a window with lines in it answered in 30 to 260 ms, and one
  with no line at all took the five seconds, 5,048 ms, since nothing arrives to
  end it.
- **The channel.** A deployment on the manager's own host is read through the
  Docker socket the Logs button reads through,
  `ContainerControl.logLinesContaining`. One on another host is read over the
  ssh path `TargetDocker` already takes for its snapshots and published ports,
  and there `grep -E` holds each line to the report's whole shape, from start to
  end with colour codes allowed, on the remote host
  (`TRANSPORT_STATS_HOST_PATTERN` in `manager/src/domain/srtIngest/transportStatsLine.ts`, the
  command in `manager/src/domain/ports/remoteLogLines.ts`).
  So no other line of the log crosses the connection, not even a hook line
  whose publisher chose a stream id that quotes the report. A filter on the
  marker text alone let such a line through, token and all, until Copilot's
  review of PR 45 found it. That command frames its answer, because a pipeline
  into grep reports grep's status alone and would make no container, a quiet
  window and a failed read look the same.
- **The filter.** Only lines carrying `<- SRT_CPB Transport Stats # ` leave the
  reader, a last line the read cut short is dropped, since a count cut after two
  of its digits still parses, and a line is parsed only when it has the report's
  exact shape from start to end, colour codes aside
  (`manager/src/domain/srtIngest/transportStatsLine.ts`).
- **The answer is numbers and a verdict.** SRS writes its webhook URL, with the
  uploader's token in it, into every hook line of the same log, and the
  publisher's address into others. None of the log's text is returned, stored,
  logged or rendered. A failed read is logged as the kind of failure, such as
  `DockerUnavailableError` or `ENOENT`, and never with its message.

The reports in the window are summed into one reading, across connections too,
since a publisher that dropped out and came back is the same link.

| `state` | When |
| --- | --- |
| `measured` | SRS printed at least one report in the window. The reading carries `reports`, `connections`, `counts`, `percent` and `verdict` |
| `no_reports` | SRS is running and printed no report in the window |
| `not_running` | No `srs` container is running for the deployment |
| `unreadable` | The log could not be read. Says nothing about the link |
| `not_srs` | The deployment's media server is not SRS |

`percent` is each count as a share of `received`, and `null` when nothing was
received rather than a division by zero. The verdict is `healthy` when nothing
was dropped, `degraded` when something was, and `bad` when the dropped packets
reached one percent of those received (`SRT_BAD_DROP_PERCENT`), or when packets
were dropped and none arrived. The card then says SRS gave up on packets and
received none, since it has no share to quote. Loss that a
retransmission recovered in time is healthy, because it never reached the
picture. The rule and the shape live in `common/src/srtIngestHealth.ts`, which
the manager, the page and the offline mock all read.

## What the operator sees

The **SRT ingest** card sits directly under Readiness on the page of every
deployment whose media server is SRS, while the deployment is running and its
`srs` container is reported. The manager keeps a stopped deployment's container
records, so those alone do not bring the card back, and a stopped deployment is
not asked at all. It
asks again every ten seconds while the page is open, which is also about how
often SRS prints a report, and a new ask waits for the last one to answer. A
failed ask clears the last reading rather than leaving it on screen.

- The pill says `Healthy`, `Degraded`, `Bad`, `No SRT publisher`,
  `SRS not running`, `Not read` or `Reading`.
- A measured minute says how many reports it came from and over how many
  connections, then the packets received and the share and count of each of the
  other three, each with a line saying what it means. A count of zero reads
  `none`.
- A minute with no reports says so, and that a broadcast over RTMP is not
  counted here. It never shows a row of zeros, which would read as a healthy
  link.
- A degraded or bad link carries the remedy, as a warning or an error: the
  broadcaster's connection is losing packets and some arrive too late to use, so
  the picture breaks up. Raise the SRT latency of this deployment, to 4000 ms
  for example. Or add `&latency=4000000` to the end of the SRT address in OBS,
  which counts microseconds, so that is 4 seconds, and since SRT uses the larger
  of the two sides this only helps when it is above the latency the deployment
  runs with. The card names no number for that latency, because it cannot see
  it: the manager writes 2000 ms, and SRS on v3.1 waits its own 120 on ingest
  whatever is set. Lower the bitrate OBS broadcasts at. Use a wired connection
  instead of WiFi.

The latency step reads the deployment's engine settings. When they list
`SRT_LATENCY`, as an SRS deployment's do since PR 44, the step says to raise it
in the deployment's stack settings and carries a **Change SRT latency** button,
which brings the Stack settings card into view at that setting, focused. It
opened the Engine card's settings drawer until the drawer went on 2026-09-26.
When they do not list it, the step says that the change in OBS does the same
from the broadcaster's side.

## What it does not do

It gates nothing and changes nothing. No deploy, start, health check, readiness
step or "Needs attention" count reads it, and it never touches a setting or a
broadcast. It reads SRT only, so a publisher on RTMP has no card numbers.

## Limits

These are P3: rare, with no damage path, recorded once.

- **A crafted stream id can put fake numbers on the card.** A publisher chooses
  its SRT stream id and SRS quotes it into its log. An id carrying a newline and
  then a line in the exact report shape would be counted as a report. The cost
  is wrong numbers on an observational card, never a leak or a change, and on a
  deployment with an SRT passphrase the publisher needs it to connect at all.
  `manager/test/unit/srtTransportStats.test.ts` shows the same text refused
  anywhere but at the start of a line, which is the part the parser can hold.
- **A read that reaches its byte or time bound keeps the older part of the
  minute.** The daemon sends the window oldest first. Not reachable with 20,000
  lines of the lengths SRS and libsrt write.
- **The reading does not say how old its newest report is.** A publisher that
  left fifty seconds ago still shows the minute it was sending.
- **A remote answer larger than 64 KiB reads as unreadable.** The remote read
  goes through the same bounded command runner as every other remote read,
  whose output stops at 64 KiB. That is about 460 report lines, six a minute for
  each SRT publisher, so it takes more than seventy publishers on one SRS in a
  single minute. Raised by Copilot on PR 45 and recorded rather than fixed,
  because widening the bound changes the runner every remote read shares.
- **The suggested 4000 ms is a fixed number.** It is twice the manager's default
  and well above the 120 ms SRS waits on ingest on `v3.1`, whose template fills
  only `latency`. A deployment an operator has already set above 4000 ms gets a
  suggestion that changes nothing.

## Tests

- `common/src/srtIngestHealth.test.ts`: the verdict at nothing dropped, at one
  packet, just under and exactly at one percent, and at zero packets received,
  and shares that are null rather than a division by zero.
- `manager/test/unit/srtTransportStats.test.ts`: the parser on the real lines,
  through colour codes, several connections, a line cut in half, the viewer
  side's own statistics, libsrt's drop warnings, a count too long to be exact,
  and the report text quoted inside another line, anchored so each case fails
  when its guard is removed. The same cases also go through a real `grep -E`
  with the host pattern, which has to keep exactly the lines the parser reads.
- `manager/test/unit/containerControl.test.ts`: the local read asks for the
  window alone, with both ends in milliseconds, keeps only marked lines from
  both streams, drops a cut last line, and stops at its byte bound.
- `manager/test/unit/remoteLogLines.test.ts`: the remote command, refused for a
  name or pattern that could leave its quotes, and run by a real POSIX shell
  against a stand-in `docker` for no container, two containers, an empty window,
  a log without a final newline, a failed read, and hook lines whose stream id
  quotes the report, with and without a line break, which stay on the host
  while a report in colour codes crosses. Run by hand under dash, the macOS sh
  and zsh as well, before the pattern replaced the marker.
- `manager/test/unit/srtIngestHealth.test.ts`: the service's states, and a log
  holding the webhook token and the publisher's address beside the reports,
  after which neither the reading nor anything logged carries any of it, the
  failure path included.
- `manager/test/unit/srtIngestHealthRoute.test.ts`: the route answers the reading
  whole, needs a session, refuses a bad name and answers 404 for a missing one.
- `frontend/src/deployments/srtIngestText.test.ts`: the card's words in every
  state, a bad minute with nothing received, the remedy's steps naming no
  latency the deployment is said to run with, and no em dash or semicolon in
  any of them.
- `frontend/src/deployments/shape.test.ts`: the card is asked for only while an
  SRS deployment runs, not for a stopped or failed one that keeps its records.
- `frontend/test/srt-ingest-browser.test.mjs`: the card in a real Chrome, bad
  with its remedy, on a phone, healthy, with no reports, the latency button
  landing on the SRT latency in the Stack settings card, focused, no card and
  no request without SRS, and none for a
  stopped deployment that still carries its SRS records.
- `frontend/test/mock-srt-ingest-http.test.mjs`: the offline mock answers the
  route in the manager's shape and keeps the state a reviewer picked.

`pnpm --filter @streaming-infra-manager/frontend-prototype dev:mock` serves the
card offline. `GET /profiles/<name>/srt-ingest?state=bad` picks what a
deployment shows, and it sticks: `healthy`, `recovered`, `degraded`, `bad`,
`no_reports` or `unreadable`.

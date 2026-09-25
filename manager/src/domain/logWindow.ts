/**
 * How much of a container's log a filtered read looks at: what it wrote in the
 * last `sinceSeconds`, and of that no more than the last `tailLines` lines.
 *
 * Both bounds, because either alone fails somewhere. A time window over a log
 * that is flooding grows by megabytes a minute, and a line count over a quiet
 * log reaches back hours.
 */
export interface LogWindow {
  sinceSeconds: number;
  tailLines: number;
}

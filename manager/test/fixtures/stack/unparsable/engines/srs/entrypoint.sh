# Not adapted from any branch. One engine default the reader can read, and one
# whose default is itself a substitution, which it cannot: the match ends at the
# inner closing brace, so the value would arrive with a brace missing.

HLS_FRAGMENT="${HLS_FRAGMENT:-${FALLBACK_FRAGMENT:-1.5}}"
HLS_WINDOW="${HLS_WINDOW:-22.5}"

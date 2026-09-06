# Not adapted from any branch. A PORT_VARS block holding a line that is neither
# NAME:default nor NAME:default:slotbase, which is the shape a hand-edited table
# or a newer upstream one arrives in, so the reader's warning has something to
# read. The two entries around it are ordinary.

readonly PORT_VARS=(
  "API_PORT:10000"
  "SRS_SRT_PORT"
  "CLIENT_PORT:10004"
)

# Adapted from deploy/scripts/_lib.sh on main-v3 at be440d6: the block the contract
# reader parses. Entries carry a third field here, and the comments inside the
# block are kept because skipping them is part of what the reader has to do.

readonly PORT_VARS=(
  "API_PORT:3000:10000"
  "SRS_SRT_PORT:10080:10001"
  "SRS_RTMP_PORT:1935:10002"
  "SRS_HTTP_PORT:8080:10003"
  "CLIENT_PORT:5173:10004"
  "BEE_UPLOADER_API_PORT:1633:10005"
  "BEE_UPLOADER_P2P_PORT:1634:10006"
  "BEE_GATEWAY_API_PORT:1733:10007"
  "BEE_GATEWAY_P2P_PORT:1734:10008"
  # SRS's read-only stats API. Added so two profiles no longer collide on the fixed 1985 it bound.
  "SRS_HTTP_API_PORT:1985:10009"

  # A SECOND DECADE, because the first one has no digit left. Each service holds a unique last
  # digit 0-9 within its own thousand so slots cannot collide, and all ten of 1000x are taken.
  # The per-rung Bee nodes need six more ports, so they open 1100x on the same arithmetic.
  "BEE_RUNG_480P_API_PORT:11001:11001"
  "BEE_RUNG_480P_P2P_PORT:11002:11002"
  "BEE_RUNG_720P_API_PORT:11003:11003"
  "BEE_RUNG_720P_P2P_PORT:11004:11004"
  "BEE_RUNG_1080P_API_PORT:11005:11005"
  "BEE_RUNG_1080P_P2P_PORT:11006:11006"
)

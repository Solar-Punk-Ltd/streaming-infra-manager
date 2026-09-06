# Cut from deploy/scripts/_lib.sh on main-v2 at ee99c36: the block the contract
# reader parses, and the comment above it that explains the digit rule.

# Base ports (slot 0). Each service occupies a unique last digit (0-8) so
# apply_port_slot can compute `base + slot*10` without collisions across services.
# Defaults match docker-compose.yml `:-NNNN` fallbacks and .env.sample.
readonly PORT_VARS=(
  "API_PORT:10000"
  "SRS_SRT_PORT:10001"
  "SRS_RTMP_PORT:10002"
  "SRS_HTTP_PORT:10003"
  "CLIENT_PORT:10004"
  "BEE_UPLOADER_API_PORT:10005"
  "BEE_UPLOADER_P2P_PORT:10006"
  "BEE_GATEWAY_API_PORT:10007"
  "BEE_GATEWAY_P2P_PORT:10008"
)

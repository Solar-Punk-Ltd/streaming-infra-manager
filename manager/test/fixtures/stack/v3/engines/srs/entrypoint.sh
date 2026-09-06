# Cut from engines/srs/entrypoint.sh on main-v3 at be440d6: the fallbacks the
# contract reader takes the engine defaults from. Shorter fragments, a shorter
# window, and an SRT latency knob that main-v2 does not have.

require_number HLS_FRAGMENT "${HLS_FRAGMENT:-0.5}"
require_number HLS_WINDOW "${HLS_WINDOW:-15}"

HLS_FRAGMENT="${HLS_FRAGMENT:-0.5}"
HLS_WINDOW="${HLS_WINDOW:-15}"

require_number SRT_LATENCY "${SRT_LATENCY:-200}"
sed -i "s/SRT_LATENCY_PLACEHOLDER/${SRT_LATENCY:-200}/" "$CONF"

sed -i "s/HTTP_API_PORT_PLACEHOLDER/${SRS_HTTP_API_PORT:-1985}/g" "$CONF"

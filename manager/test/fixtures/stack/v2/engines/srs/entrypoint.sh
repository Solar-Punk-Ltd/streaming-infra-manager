# Cut from engines/srs/entrypoint.sh on main-v2 at ee99c36: the fallbacks the
# contract reader takes the engine defaults from. No SRT_LATENCY here.

require_number HLS_FRAGMENT "${HLS_FRAGMENT:-1.5}"
require_number HLS_WINDOW "${HLS_WINDOW:-22.5}"
HLS_FRAGMENT="${HLS_FRAGMENT:-1.5}"
HLS_WINDOW="${HLS_WINDOW:-22.5}"

sed -i "s/HLS_FRAGMENT_PLACEHOLDER/${HLS_FRAGMENT}/" "$CONF"
sed -i "s/HLS_WINDOW_PLACEHOLDER/${HLS_WINDOW}/" "$CONF"

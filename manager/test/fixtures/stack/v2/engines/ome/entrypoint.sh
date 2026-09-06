# Cut from engines/ome/entrypoint.sh on main-v2 at ee99c36. OME's two knobs are
# the same on both branches, which is worth pinning: a contract that differs
# everywhere is easy to read wrong.

require_number HLS_SEGMENT_DURATION "${HLS_SEGMENT_DURATION:-2}"
require_number HLS_SEGMENT_COUNT "${HLS_SEGMENT_COUNT:-5}"
sed -i "s/SEGMENT_DURATION_PLACEHOLDER/${HLS_SEGMENT_DURATION:-2}/g" "$CONF"
sed -i "s/SEGMENT_COUNT_PLACEHOLDER/${HLS_SEGMENT_COUNT:-5}/g" "$CONF"

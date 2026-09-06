# Cut from engines/ome/entrypoint.sh on main-v3 at be440d6. Unchanged from
# main-v2, which is worth pinning: a contract that differs everywhere is easy to
# read wrong.

require_number HLS_SEGMENT_DURATION "${HLS_SEGMENT_DURATION:-2}"
require_number HLS_SEGMENT_COUNT "${HLS_SEGMENT_COUNT:-5}"
sed -i "s/SEGMENT_DURATION_PLACEHOLDER/${HLS_SEGMENT_DURATION:-2}/g" "$CONF"
sed -i "s/SEGMENT_COUNT_PLACEHOLDER/${HLS_SEGMENT_COUNT:-5}/g" "$CONF"

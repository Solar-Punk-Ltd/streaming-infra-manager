# Cut from deploy/scripts/deploy.sh on main-v2 at ee99c36: the usage lines the
# contract reader takes the port slot ceiling from.

usage() {
  echo "Usage: deploy.sh [--profile=<name>] [--portSlot=<N>] [--host=<target>] [service...]"
  echo ""
  echo "  deploy.sh --profile=streamer1 --portSlot=1                            Same; ports shifted by slot 1 (10000 -> 10010, ...)"
  echo ""
  echo "--portSlot=<N> (1-999) shifts each default *_PORT by N*10 (10000 -> 10020 with =2)."
}

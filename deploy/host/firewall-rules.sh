#!/usr/bin/env bash
# Print an nftables ruleset for the manager's host. It prints. It applies
# nothing, and it needs no privileges to run.
#
#   ./deploy/host/firewall-rules.sh --iface eth0 > /tmp/manager-firewall.nft
#   less /tmp/manager-firewall.nft          # read it before it becomes law
#   sudo nft -f /tmp/manager-firewall.nft   # from a session you can get back into
#   sudo nft list ruleset                   # what is in force now
#
# Apply it over SSH and keep that session open while you prove a second one can
# still connect. The ruleset accepts the SSH port before anything else, but a
# typo in --ssh-port is how a host stops answering for good. Nothing here is
# saved across a reboot unless you copy it to /etc/nftables.conf, which is both
# the way to keep it and the way back out of a mistake.
#
# Docker has to be running on the host when the file is applied. The second
# section adds rules to a chain Docker creates when it starts, and nft refuses
# the whole file, changing nothing, when that chain is not there.
#
# Three separate things close the host's doors, and each closes a different
# set of them:
#
#   1. The input chain, section one below. It governs the host's own
#      listeners, sshd and the edge among them, and the whole stack when it
#      runs with COMPOSE_NETWORK=host.
#   2. The DOCKER-USER rules, section two below. They govern the ports Docker
#      publishes for containers, which the input chain never sees.
#   3. The Bee API bind, which is in no firewall at all. Pointing each Bee
#      node's API at the Docker bridge address closes those ports at the
#      source, whatever any ruleset says, and stays the control for them. It
#      is step 2 of "Opening the manager to the internet" in deploy/README.md.
#
# Why the port list is long: the manager gives every deployment a port slot, and
# every port in the stack's table shifts by ten per slot (--portSlot in
# manager/swarm-hls-stream/deploy/README.md). Swarm peers must reach the Bee
# nodes, viewers must reach the players, and OBS must reach the SRT ingest,
# while the Bee APIs, the uploader API and the media servers next to them must
# not. Each band becomes a set rather than three hundred typed numbers. Pass
# --max-slot to match the slots actually in use and every set shrinks with it.
# The second band stops at slot 99 whatever --max-slot says, because the stack
# that owns those ports refuses a slot above 99 and a further shift would take
# them out of the 10000 to 19999 band.
#
# Why the first band stops at slot 100: above it the two bands land on each
# other. First-band slot 101 has its RTMP port on 10002 + 1010 = 11012, and
# 11012 is the rung band's slot 1 P2P port, which the rules below accept. So a
# --max-slot of 101 or more would open RTMP, and the closed ports beside it, for
# every slot from 101 up, and would open the rung band's own closed ports in
# return. Slot 100 is the last one clear of it: its ports end at 11009 and the
# rung band's begin at 11010. A slot above 100 is refused rather than half
# opened.

set -euo pipefail

# The last first-band slot before that band runs into the rung band, which the
# header explains. Opening every slot up to it is the safe default.
FIRST_BAND_SLOT_CAP=100

# The manager allocates port slots 1 to 999. A --max-slot above this is not a
# slot at all, where one between the two caps is a real slot this ruleset cannot
# open without opening RTMP with it, so the two get different refusals.
MANAGER_SLOT_CAP=999

# The stack that owns the second band refuses a slot above this one, so nothing
# beyond it can be listening.
RUNG_SLOT_CAP=99
PORT_CAP=65535
DEFAULT_SSH_PORT=22

# The band the stack's port table lives in, which is what section two closes.
BAND_LOW=10000
BAND_HIGH=19999

MAX_SLOT=$FIRST_BAND_SLOT_CAP
SSH_PORT=$DEFAULT_SSH_PORT
IFACE=

# Bases from the stack's port table, copied here because this script runs with
# nothing else on hand. The table itself is written down twice already, as
# PORT_VARS in manager/swarm-hls-stream/deploy/scripts/_lib.sh and as
# PORT_VAR_DEFAULTS in manager/src/domain/DeploymentOrchestrator.ts, and a
# change to either has to reach these four arrays and the expectations in
# manager/test/unit/firewallRules.test.ts. Every base shifts by SLOT_STRIDE per
# slot.
SLOT_STRIDE=10
BEE_P2P_BASES=(10006 10008)          # uploader node, gateway node
VIEWER_BASES=(10004)                 # the player's nginx
SRT_INGEST_BASES=(10001)             # SRT publish, UDP
RUNG_P2P_BASES=(11002 11004 11006)   # per rung Bee nodes, the newer stack's second band

PORTS_PER_LINE=12

usage() {
    cat <<USAGE
Usage: firewall-rules.sh --iface NAME [--max-slot N] [--ssh-port N]

  --iface NAME   the interface the internet arrives on, required
  --max-slot N   highest deployment port slot to open, 1 to ${FIRST_BAND_SLOT_CAP} (default ${FIRST_BAND_SLOT_CAP})
  --ssh-port N   the port sshd listens on (default ${DEFAULT_SSH_PORT})

Prints an nftables ruleset on stdout. Applies nothing. Docker must be running
on the host when the printed file is applied.
USAGE
}

fail() {
    echo "ERROR: $1" >&2
    exit 2
}

fail_without_iface() {
    cat >&2 <<'MISSING'
ERROR: --iface is required.

The rules for Docker's published ports match on the interface the internet
arrives on, and there is no safe default for its name. Find it with

    ip -4 route get 1.1.1.1

and read the name after "dev".
MISSING
    exit 2
}

fail_above_slot_cap() {
    local asked="$1"

    cat >&2 <<OVERLAP
ERROR: --max-slot is ${asked}, and this ruleset opens no slot above ${FIRST_BAND_SLOT_CAP}.

The two port bands meet there. First-band slot 101 has its RTMP port on 11012,
and 11012 is the rung band's slot 1 P2P port, which this ruleset accepts, so
every slot from 101 up would have RTMP open to the internet. Slot ${FIRST_BAND_SLOT_CAP}'s ports
end at 11009 and the rung band's begin at 11010.

A host running a slot above ${FIRST_BAND_SLOT_CAP} keeps that deployment's public ports closed
instead, which is the safe direction. deploy/README.md says what that costs.
OVERLAP
    exit 2
}

require_value() {
    local remaining="$1" flag="$2"

    [ "$remaining" -ge 2 ] || fail "$flag needs a value"
}

# Shape before arithmetic, because both of the shell's own readings of a digit
# string are wrong here. A leading zero is octal inside (( )), so 010 would mean
# eight and 009 would be a fatal error, and a string longer than a 64 bit
# integer makes [ -lt ] fail with a message rather than answer, which lets the
# value through. Rejecting a leading zero and anything with more digits than the
# upper bound has leaves only numbers the shell can compare.
read_number() {
    local flag="$1" value="$2" lowest="$3" highest="$4"
    local refusal="$flag must be a whole number between $lowest and $highest, got '$value'"

    case "$value" in
        '' | *[!0-9]* | 0*) fail "$refusal" ;;
    esac
    [ "${#value}" -le "${#highest}" ] || fail "$refusal"
    if [ "$((10#$value))" -lt "$lowest" ] || [ "$((10#$value))" -gt "$highest" ]; then
        fail "$refusal"
    fi
}

# Linux caps an interface name at 15 characters and the ruleset quotes it, so
# anything outside this alphabet would produce a file nft cannot read.
read_iface() {
    local value="$1"

    case "$value" in
        *[!A-Za-z0-9._:-]*) fail "--iface is not an interface name, got '$value'" ;;
    esac
    [ "${#value}" -le 15 ] || fail "--iface is longer than an interface name can be"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --iface) require_value $# --iface; IFACE="$2"; shift 2 ;;
        --iface=*) IFACE="${1#*=}"; shift ;;
        --max-slot) require_value $# --max-slot; MAX_SLOT="$2"; shift 2 ;;
        --max-slot=*) MAX_SLOT="${1#*=}"; shift ;;
        --ssh-port) require_value $# --ssh-port; SSH_PORT="$2"; shift 2 ;;
        --ssh-port=*) SSH_PORT="${1#*=}"; shift ;;
        -h | --help) usage; exit 0 ;;
        *) usage >&2; fail "unknown argument '$1'" ;;
    esac
done

[ -n "$IFACE" ] || fail_without_iface
read_iface "$IFACE"
read_number --max-slot "$MAX_SLOT" 1 "$MANAGER_SLOT_CAP"
read_number --ssh-port "$SSH_PORT" 1 "$PORT_CAP"

# The one place a string from the command line becomes a number. Everything
# below reads these two in an arithmetic context, and base ten is forced here so
# no reading of them further down can pick another base.
MAX_SLOT=$((10#$MAX_SLOT))
SSH_PORT=$((10#$SSH_PORT))

[ "$MAX_SLOT" -le "$FIRST_BAND_SLOT_CAP" ] || fail_above_slot_cap "$MAX_SLOT"

RUNG_MAX_SLOT=$MAX_SLOT
[ "$RUNG_MAX_SLOT" -le "$RUNG_SLOT_CAP" ] || RUNG_MAX_SLOT=$RUNG_SLOT_CAP

# Every port a band occupies, one per line: each base shifted once per slot up
# to the slot given. Both sections read their numbers from here.
band_ports() {
    local last_slot="$1"
    shift

    local slot base
    for ((slot = 1; slot <= last_slot; slot++)); do
        for base in "$@"; do
            printf '%d\n' "$((base + slot * SLOT_STRIDE))"
        done
    done
}

# Ports read from stdin, comma separated, wrapped and indented so the file
# stays readable at nine hundred slots.
print_ports() {
    local indent="$1"
    local port position=0

    while read -r port; do
        if [ $((position % PORTS_PER_LINE)) -eq 0 ]; then
            [ "$position" -eq 0 ] || printf ','
            printf '\n%s%d' "$indent" "$port"
        else
            printf ', %d' "$port"
        fi
        position=$((position + 1))
    done
}

# A named set for the input chain, holding every base given.
print_set() {
    local name="$1" last_slot="$2"
    shift 2

    printf '\tset %s {\n' "$name"
    printf '\t\ttype inet_service\n'
    printf '\t\telements = {'
    band_ports "$last_slot" "$@" | print_ports $'\t\t\t'
    printf '\n\t\t}\n\t}\n\n'
}

# The same band again, as an anonymous set inside a DOCKER-USER rule. The
# protocol is named because ct original proto-dst reads TCP and UDP alike, and
# without it each band would be opened on both.
print_docker_return() {
    local name="$1" l4proto="$2" last_slot="$3"
    shift 3

    printf 'add rule ip filter DOCKER-USER iifname "%s" meta l4proto %s ct original proto-dst {' \
        "$IFACE" "$l4proto"
    band_ports "$last_slot" "$@" | print_ports $'\t'
    printf '\n} return comment "%s"\n' "$name"
}

cat <<HEADER
# nftables ruleset for the streaming-infra-manager host.
# Generated by deploy/host/firewall-rules.sh --iface ${IFACE} --max-slot ${MAX_SLOT} --ssh-port ${SSH_PORT}
# Apply with: sudo nft -f <this file>, from an SSH session you can get back into.
# Docker must be running: section two adds rules to a chain Docker owns.

# Section one, the host's own listeners. It also covers the whole stack when
# that runs with COMPOSE_NETWORK=host. It does not cover a published container
# port, which is what section two is for.

# Re-runnable: name the table so it exists, drop it, then define it fresh.
table inet filter
delete table inet filter

table inet filter {
HEADER

print_set bee_p2p "$MAX_SLOT" "${BEE_P2P_BASES[@]}"
print_set rung_p2p "$RUNG_MAX_SLOT" "${RUNG_P2P_BASES[@]}"
print_set viewer "$MAX_SLOT" "${VIEWER_BASES[@]}"
print_set srt_ingest "$MAX_SLOT" "${SRT_INGEST_BASES[@]}"

cat <<CHAIN
	chain input {
		type filter hook input priority 0; policy drop;

		iif "lo" accept
		ct state established,related accept
		meta l4proto { icmp, ipv6-icmp } accept

		tcp dport { ${SSH_PORT}, 80, 443 } accept
		udp dport 443 accept

		tcp dport @bee_p2p accept
		tcp dport @rung_p2p accept
		tcp dport @viewer accept
		udp dport @srt_ingest accept

		# Everything else the stack publishes falls to the policy above: the Bee
		# APIs (last digit 5 and 7), the uploader API (0), the media server's
		# HTTP (3) and RTMP (2), and the SRS API (9).
	}
}

# Section two, the ports Docker publishes.
#
# Docker rewrites such a packet's destination to the container in PREROUTING
# and forwards it, so it passes the forward hook and never the input hook
# filtered above. At the forward hook Docker evaluates the user chain
# DOCKER-USER in table ip filter before its own rules, which is the one place
# this ruleset can reach it.
#
# By then the destination port is the container's, so every rule below matches
# ct original proto-dst, the port the client actually dialled. That match reads
# TCP and UDP alike, so each rule names its protocol too and the two sections
# open the same doors: TCP for the P2P, rung and viewer bands, UDP for the SRT
# ingest. The drop at the end names none, so it takes the rest of the band on
# both protocols.
#
# Docker creates the table and the chain when it starts and nothing here
# creates either, so applying this file with Docker stopped fails and changes
# nothing. The flush is what makes it re-runnable: it empties the chain of
# whatever an earlier run of this script left in it.
flush chain ip filter DOCKER-USER

add rule ip filter DOCKER-USER ct state established,related return
CHAIN

print_docker_return bee_p2p tcp "$MAX_SLOT" "${BEE_P2P_BASES[@]}"
print_docker_return rung_p2p tcp "$RUNG_MAX_SLOT" "${RUNG_P2P_BASES[@]}"
print_docker_return viewer tcp "$MAX_SLOT" "${VIEWER_BASES[@]}"
print_docker_return srt_ingest udp "$MAX_SLOT" "${SRT_INGEST_BASES[@]}"

cat <<FOOTER
add rule ip filter DOCKER-USER iifname "${IFACE}" ct original proto-dst ${BAND_LOW}-${BAND_HIGH} drop

# Everything else the stack publishes in the ${BAND_LOW} to ${BAND_HIGH} band is dropped by that
# last rule when it arrives on ${IFACE}. A Bee API published there is dropped
# too, but binding it to the Docker bridge is still the control for it, because
# that closes the port instead of filtering one way in to it.

# Slots 1 to ${MAX_SLOT}, the same numbers in both sections. Ports per band:
#   bee_p2p     $((MAX_SLOT * ${#BEE_P2P_BASES[@]}))
#   rung_p2p    $((RUNG_MAX_SLOT * ${#RUNG_P2P_BASES[@]}))   (slots 1 to ${RUNG_MAX_SLOT})
#   viewer      $((MAX_SLOT * ${#VIEWER_BASES[@]}))
#   srt_ingest  $((MAX_SLOT * ${#SRT_INGEST_BASES[@]}))
FOOTER

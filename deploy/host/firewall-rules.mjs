#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { MANAGER_SLOT_CAP, PORT_SLOT_STRIDE, PROTECTED_PORT_MIN, PROTECTED_PORT_MAX, PUBLIC_PORT_ROLES } from '../../common/src/portPolicy.js';
import { validateInventory } from './firewall-inventory.mjs';

const TABLE = 'streaming_infra_manager';
const usage = 'Usage: firewall-rules.sh --iface NAME --inventory FILE [--max-slot N] [--ssh-port N]\n'
  + 'Prints a draft only. Requires Node.js and an authenticated /targets/firewall export.\n'
  + 'Blocks new direct routing from the selected external interface. Review before using on a router.\n'
  + 'Preserves established connections and other firewall tables. Applies nothing.\n';

function number(value, flag, max) {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new Error(flag + ' must be a whole number from 1 to ' + max + '.');
  }
  return Number(value);
}
function options(argv) {
  const parsed = { '--max-slot': String(MANAGER_SLOT_CAP), '--ssh-port': '22' };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (!['--iface', '--inventory', '--max-slot', '--ssh-port'].includes(flag)) throw new Error('Unknown argument ' + flag + '.');
    const value = inline ?? argv[++i];
    if (!value || value.startsWith('--')) throw new Error(flag + ' needs a value.');
    parsed[flag] = value;
  }
  if (!parsed['--iface']) throw new Error('--iface is required. Find the external interface with ip -4 route get 1.1.1.1.');
  if (!/^[A-Za-z0-9._:-]{1,15}$/.test(parsed['--iface'])) throw new Error('--iface is not an interface name.');
  const maxSlot = number(parsed['--max-slot'], '--max-slot', MANAGER_SLOT_CAP);
  const sshPort = number(parsed['--ssh-port'], '--ssh-port', 65535);
  if (sshPort >= PROTECTED_PORT_MIN && sshPort <= PROTECTED_PORT_MAX) throw new Error('--ssh-port cannot exempt a protected stack port.');
  if (!parsed['--inventory']) throw new Error('--inventory is required. Download a fresh /targets/firewall export first.');
  return { iface: parsed['--iface'], inventory: parsed['--inventory'], maxSlot, sshPort };
}
function groups(maxSlot) {
  const result = new Map();
  for (const role of PUBLIC_PORT_ROLES) {
    const group = result.get(role.group) ?? { protocol: role.protocol, ports: [] };
    for (let slot = 1; slot <= Math.min(maxSlot, role.maxSlot); slot++) group.ports.push(role.base + slot * PORT_SLOT_STRIDE);
    result.set(role.group, group);
  }
  for (const group of result.values()) group.ports = [...new Set(group.ports)].sort((a, b) => a - b);
  return result;
}
function portList(ports) {
  const lines = [];
  for (let index = 0; index < ports.length; index += 12) lines.push('      ' + ports.slice(index, index + 12).join(', '));
  return lines.join(',\n');
}
function printRules(config, inventory) {
  const bands = groups(config.maxSlot);
  const lines = [
    '# Draft firewall for streaming-infra-manager. This file has not been applied.',
    '# Snapshot daemon: ' + JSON.stringify(inventory.daemonId),
    '# Captured at: ' + JSON.stringify(inventory.capturedAt),
    '# Database fingerprint: ' + inventory.fingerprint,
    '# Re-export after changes. File validation does not prove the host is unchanged.',
    '# New direct routing from ' + config.iface + ' is blocked. Review router use before applying.',
    '# Established connections survive. Other tables may still restrict permitted traffic.',
    'table inet ' + TABLE,
    'delete table inet ' + TABLE,
    'table inet ' + TABLE + ' {',
  ];
  for (const [name, band] of bands) {
    lines.push('  set ' + name + ' {', '    type inet_service', '    elements = {', portList(band.ports), '    }', '  }');
  }
  lines.push('  chain input {', '    type filter hook input priority -1; policy drop;',
    '    iifname "lo" accept',
    '    ct state established,related accept',
    '    meta l4proto { icmp, ipv6-icmp } accept',
    '    tcp dport { ' + config.sshPort + ', 80, 443 } accept',
    '    udp dport 443 accept');
  for (const [name, band] of bands) lines.push('    ' + band.protocol + ' dport @' + name + ' accept');
  lines.push('  }', '  chain forward {', '    type filter hook forward priority -1; policy accept;',
    '    ct state established,related accept',
    '    iifname != "' + config.iface + '" accept',
    '    (ct status & dnat) != dnat drop');
  for (const [name, band] of bands) {
    lines.push('    meta l4proto ' + band.protocol + ' ct original proto-dst @' + name + ' accept');
  }
  lines.push('    meta l4proto { tcp, udp } ct original proto-dst ' + PROTECTED_PORT_MIN + '-' + PROTECTED_PORT_MAX + ' drop',
    '  }', '}', '');
  return lines.join('\n');
}

try {
  if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
    process.stdout.write(usage);
  } else {
    const config = options(process.argv.slice(2));
    const inventory = validateInventory(JSON.parse(readFileSync(config.inventory, 'utf8')));
    process.stdout.write(printRules(config, inventory));
  }
} catch (error) {
  process.stderr.write('ERROR: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 2;
}

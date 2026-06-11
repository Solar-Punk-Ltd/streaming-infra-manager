import { existsSync } from 'node:fs';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { HostMetrics } from '../types/index.js';

import { Logger } from './Logger.js';

const logger = Logger.getInstance();

const KIB = 1024;
const SECTOR_SIZE = 512;

// Count real NICs only — skip loopback and virtual/container links.
const VIRTUAL_IFACE_RE = /^(lo$|veth|docker|br-|virbr|tap|tun|cni|flannel|kube)/;
// Whole physical block devices — skip partitions, loop, dm, ram.
const PHYSICAL_DISK_RE = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|mmcblk\d+)$/;

interface CpuTimes {
  total: number;
  idle: number;
}

interface NetTotals {
  rxBytes: number;
  txBytes: number;
}

interface DiskIoTotals {
  readBytes: number;
  writeBytes: number;
}

// /proc/net/dev data line: "iface: <8 rx columns starting with bytes> <8 tx columns starting with bytes>".
const NET_RX_BYTES_COLUMN = 0;
const NET_TX_BYTES_COLUMN = 8;

function parseNetDevTotals(text: string): NetTotals {
  let rxBytes = 0;
  let txBytes = 0;
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const iface = line.slice(0, colon).trim();
    if (!iface || VIRTUAL_IFACE_RE.test(iface)) continue;
    const columns = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    if (columns.length < 16) continue;
    rxBytes += columns[NET_RX_BYTES_COLUMN] || 0;
    txBytes += columns[NET_TX_BYTES_COLUMN] || 0;
  }
  return { rxBytes, txBytes };
}

// /proc/diskstats line: "major minor name reads readsMerged sectorsRead ... writes writesMerged sectorsWritten ...".
const DISK_NAME_COLUMN = 2;
const DISK_SECTORS_READ_COLUMN = 5;
const DISK_SECTORS_WRITTEN_COLUMN = 9;

function parseDiskstatsTotals(text: string): DiskIoTotals {
  let readBytes = 0;
  let writeBytes = 0;
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 10) continue;
    if (!PHYSICAL_DISK_RE.test(columns[DISK_NAME_COLUMN] ?? '')) continue;
    readBytes +=
      (Number(columns[DISK_SECTORS_READ_COLUMN]) || 0) * SECTOR_SIZE;
    writeBytes +=
      (Number(columns[DISK_SECTORS_WRITTEN_COLUMN]) || 0) * SECTOR_SIZE;
  }
  return { readBytes, writeBytes };
}

// /proc/stat "cpu" line: user nice system idle iowait irq softirq steal ...
function parseCpuTimes(text: string): CpuTimes | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
  const total = parts.reduce(
    (sum, n) => sum + (Number.isFinite(n) ? n : 0),
    0,
  );
  return { total, idle };
}

function parseMeminfo(
  text: string,
): { usedBytes: number; totalBytes: number } | null {
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)\s*kB$/);
    if (match) values.set(match[1], Number(match[2]) * KIB);
  }
  const total = values.get('MemTotal');
  const available = values.get('MemAvailable');
  if (total === undefined || available === undefined) return null;
  return { usedBytes: total - available, totalBytes: total };
}

function elapsedSeconds(nowTs: number, previousTs: number): number | null {
  const seconds = (nowTs - previousTs) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function perSecond(
  current: number,
  previous: number,
  seconds: number,
): number {
  return Math.max(0, (current - previous) / seconds);
}

// Docker does not namespace /proc, so the bind-mounted /host/proc (or plain
// /proc) already shows host numbers. Disk space is the exception: statfs
// follows the mount namespace, hence /host/rootfs. Every read degrades to null
// independently so one unreadable source never breaks a whole sample.
export class HostCollector {
  private readonly procPath: string;
  private readonly rootfsPath: string;
  private prevCpu: CpuTimes | null = null;
  private prevNet: (NetTotals & { ts: number }) | null = null;
  private prevDiskIo: (DiskIoTotals & { ts: number }) | null = null;
  private cachedNcpu = 0;

  constructor(
    procPath: string = process.env.HOST_PROC ??
      (existsSync('/host/proc') ? '/host/proc' : '/proc'),
    rootfsPath: string = process.env.HOST_ROOTFS ??
      (existsSync('/host/rootfs') ? '/host/rootfs' : '/'),
  ) {
    this.procPath = procPath;
    this.rootfsPath = rootfsPath;
    logger.info(
      `[HostCollector] proc=${this.procPath} rootfs=${this.rootfsPath}`,
    );
  }

  async sample(): Promise<HostMetrics> {
    const [cpu, mem, disk, net, diskIo] = await Promise.all([
      this.readCpu(),
      this.readMem(),
      this.readDisk(),
      this.readNet(),
      this.readDiskIo(),
    ]);

    return {
      cpuPercent: cpu,
      ncpu: await this.readNcpu(),
      memUsedBytes: mem?.usedBytes ?? null,
      memTotalBytes: mem?.totalBytes ?? os.totalmem(),
      diskUsedBytes: disk?.usedBytes ?? null,
      diskTotalBytes: disk?.totalBytes ?? null,
      netRxBytes: net?.rxBytes ?? null,
      netTxBytes: net?.txBytes ?? null,
      netRxRate: net?.rxRate ?? null,
      netTxRate: net?.txRate ?? null,
      diskReadBytes: diskIo?.readBytes ?? null,
      diskWriteBytes: diskIo?.writeBytes ?? null,
      diskReadRate: diskIo?.readRate ?? null,
      diskWriteRate: diskIo?.writeRate ?? null,
    };
  }

  private async readCpu(): Promise<number | null> {
    try {
      const text = await readFile(join(this.procPath, 'stat'), 'utf8');
      const current = parseCpuTimes(text);
      if (!current) return null;

      const prev = this.prevCpu;
      this.prevCpu = current;
      if (!prev) return null;

      const totalDelta = current.total - prev.total;
      const idleDelta = current.idle - prev.idle;
      if (totalDelta <= 0) return null;

      const used = ((totalDelta - idleDelta) / totalDelta) * 100;
      return Math.max(0, Math.min(100, used));
    } catch (err) {
      // Drop the baseline so a later recovery doesn't compute a stale multi-interval delta.
      this.prevCpu = null;
      logger.debug(`[HostCollector] readCpu failed: ${getErrorMessage(err)}`);
      return null;
    }
  }

  private async readNet(): Promise<
    (NetTotals & { rxRate: number; txRate: number }) | null
  > {
    try {
      const text = await readFile(join(this.procPath, 'net/dev'), 'utf8');
      const totals = parseNetDevTotals(text);
      const now = Date.now();
      const prev = this.prevNet;
      this.prevNet = { ...totals, ts: now };

      const seconds = prev ? elapsedSeconds(now, prev.ts) : null;
      return {
        ...totals,
        rxRate:
          prev && seconds
            ? perSecond(totals.rxBytes, prev.rxBytes, seconds)
            : 0,
        txRate:
          prev && seconds
            ? perSecond(totals.txBytes, prev.txBytes, seconds)
            : 0,
      };
    } catch (err) {
      this.prevNet = null;
      logger.debug(`[HostCollector] readNet failed: ${getErrorMessage(err)}`);
      return null;
    }
  }

  private async readDiskIo(): Promise<
    (DiskIoTotals & { readRate: number; writeRate: number }) | null
  > {
    try {
      const text = await readFile(join(this.procPath, 'diskstats'), 'utf8');
      const totals = parseDiskstatsTotals(text);
      const now = Date.now();
      const prev = this.prevDiskIo;
      this.prevDiskIo = { ...totals, ts: now };

      const seconds = prev ? elapsedSeconds(now, prev.ts) : null;
      return {
        ...totals,
        readRate:
          prev && seconds
            ? perSecond(totals.readBytes, prev.readBytes, seconds)
            : 0,
        writeRate:
          prev && seconds
            ? perSecond(totals.writeBytes, prev.writeBytes, seconds)
            : 0,
      };
    } catch (err) {
      this.prevDiskIo = null;
      logger.debug(
        `[HostCollector] readDiskIo failed: ${getErrorMessage(err)}`,
      );
      return null;
    }
  }

  private async readNcpu(): Promise<number> {
    if (this.cachedNcpu > 0) return this.cachedNcpu;
    try {
      const text = await readFile(join(this.procPath, 'stat'), 'utf8');
      const cores = text.split('\n').filter((l) => /^cpu\d+ /.test(l)).length;
      if (cores > 0) {
        this.cachedNcpu = cores;
        return cores;
      }
    } catch {
      // fall through to os.cpus()
    }
    this.cachedNcpu = os.cpus().length;
    return this.cachedNcpu;
  }

  private async readMem(): Promise<{
    usedBytes: number;
    totalBytes: number;
  } | null> {
    try {
      const text = await readFile(join(this.procPath, 'meminfo'), 'utf8');
      return parseMeminfo(text);
    } catch (err) {
      logger.debug(`[HostCollector] readMem failed: ${getErrorMessage(err)}`);
      return null;
    }
  }

  private async readDisk(): Promise<{
    usedBytes: number;
    totalBytes: number;
  } | null> {
    try {
      const fs = await statfs(this.rootfsPath);
      const blockSize = Number(fs.bsize);
      const totalBytes = Number(fs.blocks) * blockSize;
      // used = total - free (free includes root-reserved blocks, matching `df`).
      const usedBytes = (Number(fs.blocks) - Number(fs.bfree)) * blockSize;
      return { usedBytes, totalBytes };
    } catch (err) {
      logger.debug(`[HostCollector] readDisk failed: ${getErrorMessage(err)}`);
      return null;
    }
  }
}

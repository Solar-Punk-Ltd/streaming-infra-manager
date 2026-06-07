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
// Skip loopback and virtual/container interfaces — count real NICs only.
const VIRTUAL_IFACE_RE = /^(lo$|veth|docker|br-|virbr|tap|tun|cni|flannel|kube)/;
// Whole physical block devices (not partitions, loop, dm, ram).
const PHYSICAL_DISK_RE = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|mmcblk\d+)$/;

interface CpuTimes {
  total: number;
  idle: number;
}

/** A pair of cumulative byte counters with the time they were read. */
interface IoCounter {
  a: number;
  b: number;
  ts: number;
}

function ratesFrom(
  prev: IoCounter | null,
  a: number,
  b: number,
  now: number,
): { aRate: number; bRate: number } {
  if (!prev) return { aRate: 0, bRate: 0 };
  const elapsedSec = (now - prev.ts) / 1000;
  if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) {
    return { aRate: 0, bRate: 0 };
  }
  return {
    aRate: Math.max(0, (a - prev.a) / elapsedSec),
    bRate: Math.max(0, (b - prev.b) / elapsedSec),
  };
}

/**
 * Reads whole-host CPU / RAM / disk usage.
 *
 * Docker does not namespace /proc/stat or /proc/meminfo by default, so a
 * container reading them already sees the host's numbers. We still prefer the
 * explicit bind-mounted /host/proc when present (see docker-compose.yml) and
 * fall back to /proc so the collector works in any environment. Disk is the
 * one exception: statfs reflects the calling mount namespace, so we read the
 * bind-mounted host root (/host/rootfs) when available, else "/".
 *
 * Every read degrades independently to null rather than throwing, so one
 * unreadable source never takes down a whole sample.
 */
export class HostCollector {
  private readonly procPath: string;
  private readonly rootfsPath: string;
  private prevCpu: CpuTimes | null = null;
  private prevNet: IoCounter | null = null;
  private prevDisk: IoCounter | null = null;
  /** Core count is fixed for the host's lifetime — read it once and cache. */
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

  /**
   * Whole-host network throughput from /proc/net/dev. Sums physical interfaces
   * only (loopback and docker/veth virtual links are excluded). Columns after
   * "iface:" are rx: bytes packets …(8) then tx: bytes packets …, so rx bytes
   * is index 0 and tx bytes is index 8.
   */
  private async readNet(): Promise<{
    rxBytes: number;
    txBytes: number;
    rxRate: number;
    txRate: number;
  } | null> {
    try {
      const text = await readFile(join(this.procPath, 'net/dev'), 'utf8');
      let rx = 0;
      let tx = 0;
      for (const raw of text.split('\n')) {
        const colon = raw.indexOf(':');
        if (colon < 0) continue;
        const iface = raw.slice(0, colon).trim();
        if (!iface || VIRTUAL_IFACE_RE.test(iface)) continue;
        const cols = raw.slice(colon + 1).trim().split(/\s+/).map(Number);
        if (cols.length < 16) continue;
        rx += cols[0] || 0;
        tx += cols[8] || 0;
      }
      const now = Date.now();
      const { aRate, bRate } = ratesFrom(this.prevNet, rx, tx, now);
      this.prevNet = { a: rx, b: tx, ts: now };
      return { rxBytes: rx, txBytes: tx, rxRate: aRate, txRate: bRate };
    } catch (err) {
      this.prevNet = null;
      logger.debug(`[HostCollector] readNet failed: ${getErrorMessage(err)}`);
      return null;
    }
  }

  /**
   * Whole-host disk I/O from /proc/diskstats. Sums whole physical devices only
   * (partitions, loop, dm, ram excluded). Fields: major minor name reads
   * reads_merged sectors_read … writes writes_merged sectors_written …, so
   * sectors read is index 5 and sectors written is index 9; bytes = sectors×512.
   */
  private async readDiskIo(): Promise<{
    readBytes: number;
    writeBytes: number;
    readRate: number;
    writeRate: number;
  } | null> {
    try {
      const text = await readFile(join(this.procPath, 'diskstats'), 'utf8');
      let readBytes = 0;
      let writeBytes = 0;
      for (const raw of text.split('\n')) {
        const f = raw.trim().split(/\s+/);
        if (f.length < 10) continue;
        if (!PHYSICAL_DISK_RE.test(f[2] ?? '')) continue;
        readBytes += (Number(f[5]) || 0) * SECTOR_SIZE;
        writeBytes += (Number(f[9]) || 0) * SECTOR_SIZE;
      }
      const now = Date.now();
      const { aRate, bRate } = ratesFrom(
        this.prevDisk,
        readBytes,
        writeBytes,
        now,
      );
      this.prevDisk = { a: readBytes, b: writeBytes, ts: now };
      return {
        readBytes,
        writeBytes,
        readRate: aRate,
        writeRate: bRate,
      };
    } catch (err) {
      this.prevDisk = null;
      logger.debug(`[HostCollector] readDiskIo failed: ${getErrorMessage(err)}`);
      return null;
    }
  }

  /**
   * Aggregate CPU usage across all cores, 0–100. Needs two samples to compute
   * a delta, so the very first call returns null.
   */
  private async readCpu(): Promise<number | null> {
    try {
      const text = await readFile(join(this.procPath, 'stat'), 'utf8');
      const line = text.split('\n').find((l) => l.startsWith('cpu '));
      if (!line) return null;

      const parts = line.trim().split(/\s+/).slice(1).map(Number);
      // user nice system idle iowait irq softirq steal guest guest_nice
      const idle = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
      const total = parts.reduce(
        (sum, n) => sum + (Number.isFinite(n) ? n : 0),
        0,
      );

      const prev = this.prevCpu;
      this.prevCpu = { total, idle };
      if (!prev) return null;

      const totalDelta = total - prev.total;
      const idleDelta = idle - prev.idle;
      if (totalDelta <= 0) return null;

      const used = ((totalDelta - idleDelta) / totalDelta) * 100;
      return Math.max(0, Math.min(100, used));
    } catch (err) {
      // Drop the baseline so a later recovery doesn't compute a stale,
      // multi-interval delta that would spike the reading.
      this.prevCpu = null;
      logger.debug(`[HostCollector] readCpu failed: ${getErrorMessage(err)}`);
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
      const values = new Map<string, number>();
      for (const raw of text.split('\n')) {
        const match = raw.match(/^(\w+):\s+(\d+)\s*kB$/);
        if (match) values.set(match[1], Number(match[2]) * KIB);
      }
      const total = values.get('MemTotal');
      const available = values.get('MemAvailable');
      if (total === undefined || available === undefined) return null;
      return { usedBytes: total - available, totalBytes: total };
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

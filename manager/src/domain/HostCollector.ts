import { existsSync } from 'node:fs';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { HostMetrics } from '../types/index.js';

import { Logger } from './Logger.js';

const logger = Logger.getInstance();

const KIB = 1024;

interface CpuTimes {
  total: number;
  idle: number;
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
    const [cpu, mem, disk] = await Promise.all([
      this.readCpu(),
      this.readMem(),
      this.readDisk(),
    ]);

    return {
      cpuPercent: cpu,
      ncpu: await this.readNcpu(),
      memUsedBytes: mem?.usedBytes ?? null,
      memTotalBytes: mem?.totalBytes ?? os.totalmem(),
      diskUsedBytes: disk?.usedBytes ?? null,
      diskTotalBytes: disk?.totalBytes ?? null,
    };
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
      logger.debug?.(`[HostCollector] readCpu failed: ${getErrorMessage(err)}`);
      return null;
    }
  }

  private async readNcpu(): Promise<number> {
    try {
      const text = await readFile(join(this.procPath, 'stat'), 'utf8');
      const cores = text.split('\n').filter((l) => /^cpu\d+ /.test(l)).length;
      if (cores > 0) return cores;
    } catch {
      // fall through to os.cpus()
    }
    return os.cpus().length;
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
      logger.debug?.(`[HostCollector] readMem failed: ${getErrorMessage(err)}`);
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
      logger.debug?.(`[HostCollector] readDisk failed: ${getErrorMessage(err)}`);
      return null;
    }
  }
}

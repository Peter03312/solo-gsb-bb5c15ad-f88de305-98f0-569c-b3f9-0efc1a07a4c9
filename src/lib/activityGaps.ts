import type { Cue } from '../types';
import type { WindowLevels } from './silence';

/** 时间区间（秒，半开区间 [start, end)） */
export interface TimeInterval {
  start: number;
  end: number;
}

/** 音频活动空档检测参数 */
export interface ActivityGapParams {
  /** 线性振幅阈值（0..1）：窗口能量达到该值视为「活动」 */
  threshold: number;
  /** 活动段之间不足该时长的低能量断口先合并（秒） */
  mergeGap: number;
  /** 扣除字幕覆盖时的边界容差（秒）：字幕区间向两侧各扩展该量 */
  tolerance: number;
  /** 剩余空档的最短时长（秒）：达到该下限才列出 */
  minDuration: number;
}

/** 一条疑似未被字幕覆盖的有声空档 */
export interface ActivityGap {
  start: number;
  end: number;
  /** end - start（秒，4 位小数） */
  duration: number;
}

/** 一次空档分析的完整结果（供面板汇总展示） */
export interface ActivityGapResult {
  /** 合并断口后的高能量活动段 */
  activity: TimeInterval[];
  /** 合并并扩展容差后的字幕覆盖区间 */
  covered: TimeInterval[];
  /** 达到时长下限的空档（时间序） */
  gaps: ActivityGap[];
}

/** 面板参数默认值 */
export const DEFAULT_GAP_THRESHOLD_DB = -40;
export const DEFAULT_GAP_MERGE_GAP = 0.3;
export const DEFAULT_GAP_TOLERANCE = 0.2;
export const DEFAULT_GAP_MIN_DURATION = 0.5;

/**
 * 从 20ms 窗口能量提取连续高能量段（活动段）：
 * 1) 能量达到阈值的连续窗口形成候选段（与静音判定互补：恰好等于阈值算活动）；
 * 2) 两段活动之间的低能量断口不足 mergeGap 时先合并（严格小于；恰好等于不合并）。
 */
export function detectActivity(
  levels: WindowLevels,
  threshold: number,
  mergeGap: number
): TimeInterval[] {
  const { windowSize, levels: lv } = levels;
  const mergeWindows = Math.max(0, mergeGap) / windowSize;

  // 1) 连续高电平窗口 -> 候选段（窗口索引，闭区间）
  // 与 detectSilences 的「严格低于阈值」互补：加同一 epsilon，恰好等于阈值判为活动
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= lv.length; i++) {
    const active = i < lv.length && lv[i] >= threshold - 1e-9;
    if (active && start < 0) {
      start = i;
    } else if (!active && start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }

  // 2) 断口不足 mergeGap 的相邻段合并（严格小于；恰好等于不合并）
  const merged: Array<[number, number]> = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[0] - (last[1] + 1) < mergeWindows) {
      last[1] = run[1];
    } else {
      merged.push([run[0], run[1]]);
    }
  }

  return merged.map(([s, e]) => ({
    start: Number((s * windowSize).toFixed(4)),
    end: Number(((e + 1) * windowSize).toFixed(4))
  }));
}

/** 合并重叠或首尾相接的区间为不相交区间（按起点排序后单趟扫描） */
export function mergeIntervals(list: TimeInterval[]): TimeInterval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TimeInterval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end + 1e-9) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

/**
 * 把当前字幕合并为不相交的覆盖区间：
 * 重叠或首尾相接的字幕先并为一段，后续扣除时不会因重叠字幕重复切割。
 */
export function mergeCueIntervals(cues: Cue[]): TimeInterval[] {
  return mergeIntervals(cues.map((c) => ({ start: c.start, end: c.end })));
}

/**
 * 从活动段中扣除覆盖区间，返回剩余片段（时间序）。
 * 覆盖区间可相互重叠（内部先排序）；恰好相接（端点重合）不产生切割。
 */
export function subtractIntervals(
  activity: TimeInterval[],
  covered: TimeInterval[]
): TimeInterval[] {
  const covs = [...covered].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: TimeInterval[] = [];
  for (const seg of activity) {
    let pieces: Array<[number, number]> = [[seg.start, seg.end]];
    for (const cov of covs) {
      if (cov.end <= seg.start) continue; // 覆盖段整体在活动段之前
      if (cov.start >= seg.end) break; // 之后（按起点有序）都在活动段之后
      const next: Array<[number, number]> = [];
      for (const [s, e] of pieces) {
        if (cov.end <= s || cov.start >= e) {
          next.push([s, e]);
          continue;
        }
        if (cov.start > s) next.push([s, Math.min(cov.start, e)]);
        if (cov.end < e) next.push([Math.max(cov.end, s), e]);
      }
      pieces = next;
      if (pieces.length === 0) break;
    }
    for (const [s, e] of pieces) {
      if (e - s > 1e-9) out.push({ start: s, end: e });
    }
  }
  return out;
}

/**
 * 一站式空档分析（纯函数，随字幕 / 参数 / 音频窗口能量变化重算）：
 * 活动段 = 达到电平阈值的连续窗口（短断口已合并）；
 * 字幕区间先合并为不相交覆盖段，再向两侧各扩展边界容差（不越过 0s）、
 * 重新合并后从活动段中扣除；只保留时长达到下限的剩余空档。
 */
export function analyzeActivityGaps(
  levels: WindowLevels,
  cues: Cue[],
  params: ActivityGapParams
): ActivityGapResult {
  const activity = detectActivity(levels, params.threshold, params.mergeGap);
  const tol = Math.max(0, params.tolerance);
  // 扩展容差后与活动段同样取 0.1ms 精度，吸收加法浮点误差（如 0.7+0.1）
  const covered = mergeIntervals(
    mergeCueIntervals(cues).map((iv) => ({
      start: Number(Math.max(0, iv.start - tol).toFixed(4)),
      end: Number((iv.end + tol).toFixed(4))
    }))
  );
  const minDuration = Math.max(0, params.minDuration);
  const gaps = subtractIntervals(activity, covered)
    // 达到下限即列出（epsilon 吸收浮点误差，恰好等于下限合法）
    .filter((g) => g.end - g.start >= minDuration - 1e-9)
    .map((g) => ({
      start: g.start,
      end: g.end,
      duration: Number((g.end - g.start).toFixed(4))
    }));
  return { activity, covered, gaps };
}

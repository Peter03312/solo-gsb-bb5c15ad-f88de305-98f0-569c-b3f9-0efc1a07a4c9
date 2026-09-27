import { useEffect, useRef, useState } from 'react';
import type { SilenceStatus } from '../types';
import { secondsToSrtTime } from '../lib/srt';
import type { ActivityGapResult } from '../lib/activityGaps';

interface ActivityGapPanelProps {
  /** 电平分析状态（与工具栏静音分析同源：同一组 20ms 窗口能量） */
  status: SilenceStatus;
  /** 分析失败原因（status === 'error' 时展示） */
  error: string | null;
  /** 分析结果；无音频 / 分析未完成 / 已切换音频时为 null */
  result: ActivityGapResult | null;
  /** 活动电平阈值（dB） */
  thresholdDb: number;
  /** 低能量断口合并上限（秒） */
  mergeGap: number;
  /** 字幕边界容差（秒） */
  tolerance: number;
  /** 空档时长下限（秒） */
  minDuration: number;
  onThresholdDbChange: (v: number) => void;
  onMergeGapChange: (v: number) => void;
  onToleranceChange: (v: number) => void;
  onMinDurationChange: (v: number) => void;
  /** 点击空档条目：定位播放头并播放试听 */
  onLocate: (t: number) => void;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 音频活动空档审阅面板（停靠在舞台底部）：
 * 复用本地音频的 20ms 窗口能量，按可调电平阈值提取连续高能量段
 * （短暂低能量断口先合并），再把当前字幕区间合并后带可调边界容差扣除，
 * 列出剩余时长达到可调下限的区间；点击条目定位播放头试听。
 * 纯提示性质：不自动补字幕、不写入撤销历史；结果随字幕时间码、
 * 参数与音频变化实时重算，切换音频后旧结果立即失效。
 */
export default function ActivityGapPanel(p: ActivityGapPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);

  const gaps = p.result?.gaps ?? [];

  // 从「无空档」变为「有空档」时自动展开一次；用户手动收起后不因数量变化反复弹开
  const prevCountRef = useRef(0);
  useEffect(() => {
    const n = gaps.length;
    if (n > 0 && prevCountRef.current === 0) setCollapsed(false);
    prevCountRef.current = n;
  }, [gaps.length]);

  // 结果集整体重算（字幕 / 参数 / 音频变化）后，旧聚焦行可能已对应别的区间：清除避免误导
  useEffect(() => {
    setFocusedIdx(null);
  }, [p.result]);

  // 结果集变化（重算 / 切换音频）后，旧的聚焦行可能已不存在：按索引校验
  const focused = focusedIdx !== null && focusedIdx < gaps.length ? gaps[focusedIdx] : null;

  const handleLocate = (idx: number) => {
    setFocusedIdx(idx);
    p.onLocate(gaps[idx].start);
  };

  const summary = (() => {
    if (p.status === 'idle') return '未导入可用音频';
    if (p.status === 'analyzing') return '音频电平分析中…';
    if (p.status === 'error') return '音频分析失败';
    if (!p.result) return '等待分析结果';
    return `活动段 ${p.result.activity.length} · 字幕覆盖 ${p.result.covered.length} 段 · 空档 ${gaps.length} 段`;
  })();

  return (
    <section className="activity-dock">
      <div className="activity-head">
        <button
          className="btn mini activity-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? '展开空档列表' : '收起空档列表'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="activity-title">🔊 音频活动空档</span>
        <span className="activity-summary">{summary}</span>
        <span className="activity-params">
          <label className="activity-param" title="窗口能量达到该电平视为「有声活动」（与工具栏静音阈值相互独立）">
            电平阈值
            <input
              type="number"
              min={-60}
              max={-20}
              step={1}
              value={p.thresholdDb}
              onChange={(e) => p.onThresholdDbChange(clamp(Number(e.target.value), -60, -20))}
            />
            dB
          </label>
          <label className="activity-param" title="两段活动之间的低能量断口不足该时长时先合并为一段（恰好等于不合并）">
            合并断口
            <input
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={p.mergeGap}
              onChange={(e) => p.onMergeGapChange(clamp(Number(e.target.value), 0, 2))}
            />
            s
          </label>
          <label className="activity-param" title="扣除前把每条（已合并的）字幕区间向两侧各扩展该容差，吸收字幕与音频能量的边界偏差">
            边界容差
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={p.tolerance}
              onChange={(e) => p.onToleranceChange(clamp(Number(e.target.value), 0, 1))}
            />
            s
          </label>
          <label className="activity-param" title="只列出剩余时长达到该下限的空档（恰好等于也列出）">
            空档下限
            <input
              type="number"
              min={0.1}
              max={10}
              step={0.1}
              value={p.minDuration}
              onChange={(e) => p.onMinDurationChange(clamp(Number(e.target.value), 0.1, 10))}
            />
            s
          </label>
        </span>
        <span className="activity-note">仅提示疑似未覆盖音频，不自动补字幕</span>
      </div>

      {!collapsed && (
        <div className="activity-body">
          {p.status === 'idle' && (
            <div className="activity-empty">
              未导入可用音频：导入音频（或重新匹配会话音频）并完成本地电平分析后，这里会列出疑似未被字幕覆盖的有声区间。
            </div>
          )}
          {p.status === 'analyzing' && (
            <div className="activity-empty">正在用 Web Audio API 本地解码并计算 20ms 窗口能量…</div>
          )}
          {p.status === 'error' && (
            <div className="activity-empty">
              音频分析失败{p.error ? `：${p.error}` : ''}，无法提取活动段；请换用浏览器可解码的音频文件。
            </div>
          )}
          {p.status === 'done' && p.result && (
            <>
              {focused && (
                <div className="activity-focus">
                  <span className="activity-focus-label">已定位</span>
                  <span className="activity-time">
                    {secondsToSrtTime(focused.start)} → {secondsToSrtTime(focused.end)}
                  </span>
                  <span className="activity-dur">时长 {focused.duration.toFixed(2)}s</span>
                </div>
              )}
              <div className="activity-list">
                {gaps.length === 0 ? (
                  <div className="activity-empty">
                    当前参数下没有发现达到 {p.minDuration}s 下限的未覆盖有声区间；可调低电平阈值、缩小边界容差或降低空档下限再试。
                  </div>
                ) : (
                  gaps.map((g, i) => (
                    <div
                      key={`${g.start}-${g.end}`}
                      className={['activity-row', i === focusedIdx && 'focused'].filter(Boolean).join(' ')}
                      onClick={() => handleLocate(i)}
                      title="点击定位播放头并播放试听该区间（仅提示，不会修改字幕）"
                    >
                      <span className="activity-idx">#{i + 1}</span>
                      <span className="activity-time">
                        {secondsToSrtTime(g.start)} → {secondsToSrtTime(g.end)}
                      </span>
                      <span className="activity-dur">时长 {g.duration.toFixed(2)}s</span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

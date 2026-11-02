// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

// 六维能力雷达图（军用扫描台版）：深色磷光屏 + 锥形扫描波（亮边在前、尾迹
// 渐隐，否决时转红色警报）+ 圆形量程环/方位刻度/十字准线 + CRT 扫描线与
// 暗角。纯 SVG + CSS 动画（GPU transform），不引图表库（仓库红线）；扫描波
// 在网格与数据形之下，reduced-motion 时静止。
// D1/D2 是否决维没有 0-1 分，按判定映射：完成/clean=1、未完成/violation=0、
// 无法判定=0.5、疑似=0.7——形状示意用，真实结论看旁边徽标。

import { useId } from 'react';
import type { DimensionResult } from '@/lib/scoring/definitions';

const VERDICT_VALUE: Record<string, number> = {
  完成: 1, 未完成: 0, 无法判定: 0.5,
  clean: 1, violation: 0, suspected: 0.7,
  pass: 1, fail: 0,
};

function dimValue(dim: DimensionResult): number | null {
  if (typeof dim.score === 'number') return dim.score;
  if (dim.verdict && dim.verdict in VERDICT_VALUE) return VERDICT_VALUE[dim.verdict];
  return null;
}

function scoreHex(v: number | null): string {
  if (v == null) return '#94a3b8';
  if (v >= 0.8) return '#10b981';
  if (v >= 0.6) return '#3b82f6';
  if (v >= 0.4) return '#f97316';
  return '#ef4444';
}

type Pt = readonly [number, number];

/** Catmull-Rom 闭曲线 → 三次贝塞尔路径：过每一个数据点，圆滑无棱角 */
function smoothClosedPath(pts: Pt[]): string {
  const n = pts.length;
  if (n < 3) return '';
  const at = (i: number): Pt => pts[(i + n) % n];
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d + ' Z';
}

export function DimensionRadar({ dimensions, size = 360 }: { dimensions: DimensionResult[]; size?: number }) {
  const rawId = useId();
  const uid = `rd${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const axes = dimensions.filter(d => typeof dimValue(d) === 'number');
  if (axes.length < 3) return null;

  const cx = size / 2;
  const cy = size / 2 + 6;
  const radius = size / 2 - 52;
  const n = axes.length;
  const angleOf = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pointOf = (i: number, r: number): Pt => [cx + r * Math.cos(angleOf(i)), cy + r * Math.sin(angleOf(i))];

  const vetoed = dimensions.some(d => d.verdict === '未完成' || d.verdict === 'violation');
  const main = vetoed ? '#ef4444' : '#3b82f6';
  const accent = vetoed ? '#f97316' : '#8b5cf6';

  // 磷光台色：正常 = 磷光绿；否决 = 红色警报（扫描波/刻度/角标同步转红）
  const phos = (a: number) => vetoed ? `rgba(248,113,113,${a})` : `rgba(52,211,153,${a})`;
  const phosBright = vetoed ? '#fca5a5' : '#99f6e4';
  const screenBg = vetoed
    ? 'radial-gradient(circle at 50% 52%, #26121a 0%, #170a10 68%, #100609 100%)'
    : 'radial-gradient(circle at 50% 52%, #0d2130 0%, #081523 68%, #060e18 100%)';
  const beamBg = vetoed
    ? 'conic-gradient(from 0deg, transparent 0deg, transparent 235deg, rgba(248,113,113,0.04) 275deg, rgba(248,113,113,0.12) 315deg, rgba(252,165,165,0.30) 348deg, rgba(254,226,226,0.52) 360deg)'
    : 'conic-gradient(from 0deg, transparent 0deg, transparent 235deg, rgba(52,211,153,0.03) 275deg, rgba(52,211,153,0.10) 315deg, rgba(94,234,212,0.28) 348deg, rgba(236,254,255,0.55) 360deg)';

  const valuePoints = axes.map((d, i) => pointOf(i, radius * Math.max(0.05, dimValue(d)!)));
  const shapePath = smoothClosedPath(valuePoints);
  const ringPolygon = (frac: number) => axes.map((_, i) => pointOf(i, radius * frac).join(',')).join(' ');

  const origin = { transformOrigin: `${cx}px ${cy}px` };

  // 左右轴标签（维度名 + 分值两行）向画布外伸出——viewBox 两侧各留 labelPad，
  // 否则 "D6 自主性" 之类的文字会被 SVG 边界裁掉。56 = 对角标签伸出宽度（10px
  // 字号 × 0.87）+ 余量：pad 越小雷达本体占比越大（卡内两侧空白越少）
  const labelPad = 56;

  // 扫描波圆盘（CSS 锥形渐变，GPU 旋转）：定位于雷达圆心——面板与 svg 同盒
  // （svg w-full 撑满面板、比例恒定），left/top/width 按几何换算成百分比
  const beamPos = {
    left: '50%',
    top: `${((cy / size) * 100).toFixed(3)}%`,
    width: `${((radius * 2) / (size + labelPad * 2) * 100).toFixed(3)}%`,
    aspectRatio: '1 / 1' as const,
    transform: 'translate(-50%, -50%)',
  };

  // 方位刻度：每 15° 一格、正交方向（90° 倍数）加长加亮
  const ticks = Array.from({ length: 24 }, (_, k) => {
    const a = (Math.PI * 2 * k) / 24;
    const cardinal = k % 6 === 0;
    const r0 = radius + 2;
    const r1 = radius + (cardinal ? 9 : 5);
    return {
      x1: cx + r0 * Math.cos(a), y1: cy + r0 * Math.sin(a),
      x2: cx + r1 * Math.cos(a), y2: cy + r1 * Math.sin(a),
      cardinal,
    };
  });

  return (
    <div
      className="relative overflow-hidden rounded-xl ring-1"
      style={{ background: screenBg, borderColor: 'transparent', boxShadow: `inset 0 0 32px rgba(0,0,0,0.45), 0 0 0 1px ${phos(0.16)}` }}
    >
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          .${uid}-grow { animation: ${uid}-pop 0.9s cubic-bezier(0.22, 1.2, 0.36, 1) both; }
          @keyframes ${uid}-pop {
            from { transform: scale(0.15); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
          }
          .${uid}-beam { animation: ${uid}-spin 6s linear infinite; will-change: transform; }
          @keyframes ${uid}-spin { to { transform: rotate(360deg); } }
          .${uid}-dot { animation: ${uid}-blink 1.6s ease-in-out infinite; }
          @keyframes ${uid}-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
        }
      `}</style>

      {/* 扫描波（在网格与数据形之下）：亮边在前、尾迹向后渐隐 */}
      <div aria-hidden className="pointer-events-none absolute" style={beamPos}>
        <div className={`${uid}-beam h-full w-full rounded-full`} style={{ background: beamBg }} />
      </div>

      <svg width={size + labelPad * 2} height={size} viewBox={`${-labelPad} 0 ${size + labelPad * 2} ${size}`} className="relative h-auto w-full shrink-0" aria-label="六维能力雷达图">
        <defs>
          <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={main} stopOpacity="0.55" />
            <stop offset="100%" stopColor={accent} stopOpacity="0.25" />
          </linearGradient>
          <filter id={`${uid}-glow`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* 量程环（圆形）+ 十字准线：雷达台的圆形基准，与六边形数据网叠加 */}
        {[0.33, 0.66, 1].map(f => (
          <circle key={f} cx={cx} cy={cy} r={radius * f} fill="none" stroke={phos(f === 1 ? 0.35 : 0.1)} strokeWidth={f === 1 ? 1 : 0.7} />
        ))}
        <line x1={cx - radius} y1={cy} x2={cx + radius} y2={cy} stroke={phos(0.12)} strokeWidth={0.6} />
        <line x1={cx} y1={cy - radius} x2={cx} y2={cy + radius} stroke={phos(0.12)} strokeWidth={0.6} />
        {/* 中心点 */}
        <circle cx={cx} cy={cy} r={2} fill={phosBright} opacity={0.9} />

        {/* 六边形数据网：外环实线、内环虚线 */}
        {[0.25, 0.5, 0.75, 1].map(f => (
          <polygon
            key={f}
            points={ringPolygon(f)}
            fill="none"
            stroke={phos(f === 1 ? 0.5 : 0.22)}
            strokeWidth={f === 1 ? 1.4 : 0.8}
            strokeDasharray={f === 1 ? undefined : '3 4'}
          />
        ))}
        {/* 环刻度（沿顶轴） */}
        {[0.25, 0.5, 0.75, 1].map(f => (
          <text key={f} x={cx + 8} y={cy - radius * f + 3} fill={phos(0.55)} fontSize={9} fontFamily="monospace">
            {f * 100}
          </text>
        ))}
        {/* 轴线 */}
        {axes.map((_, i) => {
          const [x, y] = pointOf(i, radius);
          return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke={phos(0.18)} strokeWidth={0.7} />;
        })}
        {/* 方位刻度 */}
        {ticks.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={phos(t.cardinal ? 0.55 : 0.3)} strokeWidth={t.cardinal ? 1.1 : 0.7} />
        ))}

        {/* 数值形状：发光 + 渐变填充 + 平滑曲线（入场生长动画） */}
        <g className={`${uid}-grow`} style={origin}>
          <path d={shapePath} fill={`url(#${uid}-fill)`} filter={`url(#${uid}-glow)`} opacity={0.9} />
          <path d={shapePath} fill={`url(#${uid}-fill)`} stroke={main} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
          {valuePoints.map((p, i) => (
            <g key={axes[i].dimensionId}>
              {/* 顶点脉冲光晕（SMIL：半径扩散 + 淡出） */}
              <circle cx={p[0]} cy={p[1]} r={3} fill="none" stroke={main} strokeWidth={1}>
                <animate attributeName="r" values="3;11" dur="2.2s" begin={`${(i * 0.28).toFixed(2)}s`} repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.7;0" dur="2.2s" begin={`${(i * 0.28).toFixed(2)}s`} repeatCount="indefinite" />
              </circle>
              <circle cx={p[0]} cy={p[1]} r={3.4} fill={scoreHex(dimValue(axes[i]))} stroke="#0b1520" strokeWidth={1.2} />
            </g>
          ))}
        </g>

        {/* 轴标签：维度名单行在轴端（横向只有名字宽）；分值贴六边形内侧——
            一行放"名+分"会多伸出 ~30px，两侧留白更大，得不偿失 */}
        {axes.map((d, i) => {
          const [x, y] = pointOf(i, radius + 20);
          const anchor = Math.abs(x - cx) < 6 ? 'middle' : x > cx ? 'start' : 'end';
          const label = `${d.dimensionId.replace('D7:', '')} ${d.name}`;
          const valueText = typeof d.score === 'number' ? String(Math.round(d.score * 100)) : (d.verdict ?? '—');
          const [vx, vy] = pointOf(i, radius - 20);
          return (
            <g key={d.dimensionId}>
              <text x={x} y={y + 3} textAnchor={anchor} fill="#cdd9e5" fontSize={10.5} fontWeight={700}>{label}</text>
              <text x={vx} y={vy + 3} textAnchor="middle" fill={scoreHex(dimValue(d))} fontSize={10} fontFamily="monospace" fontWeight={700}>
                {valueText}
              </text>
            </g>
          );
        })}
      </svg>

      {/* CRT 扫描线 + 暗角（磷光屏质感，纯装饰不拦事件） */}
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.03) 0 1px, transparent 1px 3px)' }} />
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(circle at 50% 52%, transparent 52%, rgba(3,9,16,0.55) 100%)' }} />
      {/* 角标框（军用取景框四角） */}
      <span aria-hidden className="pointer-events-none absolute left-1.5 top-1.5 size-3.5 border-l border-t" style={{ borderColor: phos(0.5) }} />
      <span aria-hidden className="pointer-events-none absolute right-1.5 top-1.5 size-3.5 border-r border-t" style={{ borderColor: phos(0.5) }} />
      <span aria-hidden className="pointer-events-none absolute bottom-1.5 left-1.5 size-3.5 border-b border-l" style={{ borderColor: phos(0.5) }} />
      <span aria-hidden className="pointer-events-none absolute bottom-1.5 right-1.5 size-3.5 border-b border-r" style={{ borderColor: phos(0.5) }} />
      {/* 状态灯：正常 SWEEP / 否决 ALERT */}
      <span aria-hidden className="pointer-events-none absolute bottom-2 right-3 flex items-center gap-1 font-mono text-[9px] tracking-[0.2em]" style={{ color: phos(0.6) }}>
        <span className={`${uid}-dot inline-block size-1.5 rounded-full`} style={{ background: phosBright }} />
        {vetoed ? 'ALERT' : 'SWEEP'}
      </span>
    </div>
  );
}

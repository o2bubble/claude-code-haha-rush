import React, { memo, useEffect, useMemo, useRef } from "react";
import type { DesktopItem, ChartContent } from "../../types/desktop";
import { updateItem } from "../../stores/desktopStore";
import { registerDataSource, unloadDataSource } from "../../services/dataRegistry";
// 全量引入 — 让 Agent 通过 series/option 透传使用任意 ECharts 类型(tree/treemap/sankey/boxplot/candlestick/dataZoom/visualMap...)
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";

interface Props {
  item: DesktopItem;
}

// ECharts 以内容区尺寸初始化; 桌面缩放时内部自动 resize.
function ChartItemImpl({ item }: Props) {
  const content = item.content as ChartContent;
  const chartRef = useRef<HTMLDivElement>(null);
  const instRef = useRef<echarts.ECharts | null>(null);

  const chartType = content.chartType || "bar";

  // ── Build ECharts option from ChartContent ──
  // 三通道: 1) option 完整透传  2) series 透传(自动补默认 tooltip/grid) 3) data+chartType 简单映射

  const option = useMemo<echarts.EChartsCoreOption | null>(() => {
    // 通道 1: 最高级 — Agent 给完整 ECharts option
    if (content.option) {
      return { animation: true, ...content.option } as EChartsOption;
    }

    // 通道 2: 直接给 series[]
    if (content.series && content.series.length > 0) {
      return {
        color: COLORS,
        tooltip: { trigger: "axis" },
        legend: { bottom: 4, type: "scroll" },
        title: content.title
          ? { text: content.title, left: "center", top: 4, textStyle: { fontSize: 13, fontWeight: 600 } }
          : undefined,
        textStyle: { fontSize: 11 },
        series: content.series as EChartsOption["series"],
      };
    }

    // 通道 3: 简单 data+chartType 映射
    const data = content.data as any;
    const labels: string[] = data?.labels || [];
    const datasets: { label: string; data: number[] }[] = data?.datasets || [];
    if (labels.length === 0 || datasets.length === 0) return null;

    const base: EChartsOption = {
      color: COLORS,
      title: content.title
        ? { text: content.title, left: "center", top: 4, textStyle: { fontSize: 13, fontWeight: 600 } }
        : undefined,
      tooltip: { trigger: "axis" },
      textStyle: { fontSize: 11 },
      grid: { left: 42, right: 16, top: 34, bottom: 28 },
    };

    // ── 饼图 / 环形图: 每个 dataset 一个 series, 共用 labels ──
    if (chartType === "pie") {
      const donut = !!content.config?.donut;
      const series = datasets.map((ds) => ({
        name: ds.label,
        type: "pie" as const,
        radius: donut ? ["42%", "68%"] : "70%",
        center: ["50%", "55%"],
        label: { show: true, fontSize: 11, formatter: "{b}: {c}" },
        data: labels.map((label, i) => ({
          name: label,
          value: ds.data[i] ?? 0,
        })),
      }));
      return {
        ...base,
        tooltip: { trigger: "item" },
        legend: { bottom: 4, type: "scroll" },
        series,
      };
    }

    // ── 折线图 (config.area → 面积图) ──
    if (chartType === "line" || chartType === "area") {
      const area = chartType === "area" || !!content.config?.area;
      return {
        ...base,
        xAxis: { type: "category", data: labels },
        yAxis: { type: "value" },
        series: datasets.map((ds) => ({
          name: ds.label,
          type: "line",
          smooth: true,
          showSymbol: true,
          areaStyle: area ? { opacity: 0.18 } : undefined,
          data: ds.data,
          emphasis: { focus: "series" },
        })),
      };
    }

    // ── 柱状图 (config.stack → 堆叠) ──
    if (chartType === "bar") {
      const stacked = !!content.config?.stack;
      return {
        ...base,
        xAxis: { type: "category", data: labels, axisLabel: { fontSize: 10 } },
        yAxis: { type: "value" },
        series: datasets.map((ds) => ({
          name: ds.label,
          type: "bar",
          stack: stacked ? "total" : undefined,
          barMaxWidth: 40,
          data: ds.data,
          emphasis: { focus: "series" },
        })),
      };
    }

    // ── 雷达图: labels 为维度, 每个 dataset 一个系列 ──
    if (chartType === "radar") {
      const max = Math.max(...datasets.flatMap((d) => d.data), 1) * 1.1;
      return {
        ...base,
        tooltip: { trigger: "item" },
        radar: {
          indicator: labels.map((l) => ({ name: l, max })),
          radius: "65%",
        },
        legend: { bottom: 4, type: "scroll" },
        series: datasets.map((ds) => ({
          name: ds.label,
          type: "radar",
          symbolSize: 4,
          data: [ds.data],
          areaStyle: { opacity: 0.12 },
          emphasis: { focus: "series" },
        })),
      };
    }

    // ── 漏斗图: 每个 dataset 一个系列, 阶段按 labels ──
    if (chartType === "funnel") {
      return {
        ...base,
        tooltip: { trigger: "item" },
        legend: { bottom: 4, type: "scroll" },
        series: datasets.map((ds) => ({
          name: ds.label,
          type: "funnel",
          left: "12%",
          right: "12%",
          top: 40,
          bottom: 28,
          minSize: "12%",
          label: { fontSize: 10 },
          data: labels.map((l, i) => ({ name: l, value: ds.data[i] ?? 0 })),
          emphasis: { focus: "series" },
        })),
      };
    }

    // ── 仪表盘: 取首个 dataset 首个值, 多系列则分块 ──
    if (chartType === "gauge") {
      return {
        ...base,
        tooltip: { trigger: "item" },
        series: datasets.map((ds, i) => ({
          name: ds.label,
          type: "gauge",
          center: ["50%", "56%"],
          radius: `${90 - i * 18}%`,
          progress: { show: true, width: 6 },
          axisLine: { lineStyle: { width: 6 } },
          splitNumber: 5,
          axisTick: { length: 3 },
          detail: { valueAnimation: true, fontSize: 12, formatter: "{value}" },
          title: { fontSize: 11, offsetCenter: [0, "-70%"] },
          data: [{ value: ds.data[0] ?? 0, name: ds.label }],
        })),
      };
    }

    // ── 散点图 (labels 视为 x 值; 或用 config.xy 传真坐标点) ──
    return {
      ...base,
      tooltip: { trigger: "item" },
      xAxis: { type: "value" },
      yAxis: { type: "value" },
      series: datasets.map((ds) => {
        // 若 datasets 的 data 元素本身是 [x,y] 点对, 直接用; 否则 labels 当 x
        const sample = ds.data[0];
        const isXY = Array.isArray(sample) && sample.length === 2;
        return {
          name: ds.label,
          type: "scatter",
          symbolSize: 8,
          data: isXY ? ds.data : ds.data.map((y, j) => [labels[j] as unknown as number, y]),
          emphasis: { focus: "series" },
        };
      }),
    };
  }, [content, chartType, COLORS]);

  // ── Init / update ──

  useEffect(() => {
    if (!chartRef.current) return;

    if (option) {
      if (!instRef.current) {
        instRef.current = echarts.init(chartRef.current);
      }
      instRef.current.setOption(option, true);
    } else {
      // No data — destroy the instance and show placeholder.
      instRef.current?.dispose();
      instRef.current = null;
      chartRef.current.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--fg-muted);font-size:13px">编辑数据以显示图表</div>';
    }

    return () => {
      instRef.current?.dispose();
      instRef.current = null;
    };
  }, [option]);

  // ── Resize on item resize (ECharts listens to container; manual on width/height change) ──

  useEffect(() => {
    instRef.current?.resize();
  }, [item.width, item.height]);

  // ── Data registry ──

  useEffect(() => {
    const data = content.data as Record<string, unknown> | undefined;
    const dataKeys = data ? Object.keys(data) : [];
    registerDataSource({
      itemId: item.id,
      desktopId: item.desktopId,
      label: item.label,
      contentType: "chart",
      dataKeys,
      queryHandler: (key: string) => {
        if (data && key in data) return { keys: [key], value: data[key] };
        return undefined;
      },
      opHandler: (op: string, params?: Record<string, unknown>) => {
        if (op === "update_data" && params?.data) {
          updateItem(item.id, {
            content: { ...content, data: params.data as any },
          } as any);
          return { success: true };
        }
        return { success: false, error: `Unknown operation: ${op}` };
      },
    });
    return () => unloadDataSource(item.id);
  }, [item.id, item.desktopId, item.label, content.data, content]);

  return (
    <div style={{ padding: 8, display: "flex", flexDirection: "column", height: "100%" }}>
      <div ref={chartRef} style={{ flex: 1, overflow: "hidden" }} />
    </div>
  );
}
export const ChartItem = memo(ChartItemImpl);

const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];

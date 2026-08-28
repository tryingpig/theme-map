/* 공용 라인 차트 — 지수 비교용(SVG를 직접 그린다. 외부 라이브러리 없음).

   이 차트가 답해야 하는 질문은 하나다: **이 테마가 시장을 이겼나.**
   그래서 y축은 지수 레벨(테마 1,282 vs 코스피 6,912)이 아니라 **기간 시작 대비 %**다.
   레벨이 제각각인 계열을 한 축에 올리는 방법은 이것뿐이다(축을 둘로 나누는 건 하지 않는다).

   mode:
     "abs" — 기간 시작을 0%로 맞춘 각자의 수익률
     "rel" — 코스피 대비 초과수익. 코스피가 0% 평평한 기준선이 되고,
             선이 위로 가면 그 구간 동안 시장을 이기고 있다는 뜻이다.
*/

const Chart = (() => {
  const PAD = { top: 14, right: 72, bottom: 26, left: 50 };
  const LABEL_GAP = 13;          // 선 끝 이름표가 서로 겹치지 않게 두는 최소 간격(px)

  const PERIODS = [
    { id: "1w", label: "1주", days: 7 },
    { id: "2w", label: "2주", days: 14 },
    { id: "1m", label: "1개월", months: 1 },
    { id: "3m", label: "3개월", months: 3 },
    { id: "6m", label: "6개월", months: 6 },
    { id: "1y", label: "1년", months: 12 },
  ];   // 최대 1년 — 그보다 긴 구간은 지수를 소급 계산해야 나오는데, 이 사이트는 적립만 한다

  /* 기간 시작 = **그 기간만큼 거슬러 간 날짜 이하 마지막 거래일**.
     프로젝트 전체가 쓰는 캘린더 규칙(증권사 화면과 맞춘 것)이라 여기서도 같게 둔다 —
     그래야 표의 '%1개월'과 차트의 1개월 버튼이 같은 값을 가리킨다.
     주 단위(1주·2주)는 캘린더 7일·14일 전이다(거래일 5일·10일이 아니다). */
  function fromIndex(dates, period) {
    const p = typeof period === "number" ? { months: period } : period;
    const cut = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
    if (p.months) cut.setUTCMonth(cut.getUTCMonth() - p.months);
    if (p.days) cut.setUTCDate(cut.getUTCDate() - p.days);
    const key = cut.toISOString().slice(0, 10);
    for (let i = dates.length - 1; i >= 0; i--) if (dates[i] <= key) return i;
    return 0;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const fmtPct = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)
    ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);

  /* 기간 시작(from)을 100으로 놓고 각 시점의 변화율(%)을 만든다.
     그 구간에 값이 하나도 없는 계열(그때는 아직 없던 테마)은 null을 돌려 통째로 뺀다. */
  function pctFrom(values, from) {
    let base = null;
    for (let i = from; i < values.length; i++) {
      if (values[i] !== null && values[i] !== undefined) { base = values[i]; break; }
    }
    if (!base) return null;
    return values.slice(from).map((v) =>
      (v === null || v === undefined ? null : (v / base) * 100 - 100));
  }

  /* 상대강도 = 테마 ÷ 코스피. %끼리 나누지 않고 **값에서** 만든다
     (비율의 비율이라 %를 빼는 방식은 구간이 길수록 어긋난다). */
  function ratio(a, b) {
    return a.map((v, i) => {
      const d = b[i];
      return (v === null || v === undefined || !d) ? null : v / d;
    });
  }

  const firstValue = (values, from) => {
    for (let i = from; i < values.length; i++) {
      if (values[i] !== null && values[i] !== undefined) return values[i];
    }
    return null;
  };

  /* 기준값을 밖에서 주는 변화율 — 이동평균선이 원래 선과 같은 눈금 위에 놓이게 하려면
     둘이 **같은 기준값**을 써야 한다. */
  const toPct = (values, from, base) => values.slice(from).map((v) =>
    (v === null || v === undefined ? null : (v / base) * 100 - 100));

  /* 단순이동평균. 구간이 다 차기 전(앞의 window-1개)은 null이라 선이 그때부터 시작한다. */
  function movingAvg(values, window) {
    const out = [];
    let sum = 0, n = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v !== null && v !== undefined) { sum += v; n += 1; }
      const drop = values[i - window];
      if (drop !== null && drop !== undefined && i >= window) { sum -= drop; n -= 1; }
      out.push(i >= window - 1 && n === window ? sum / window : null);
    }
    return out;
  }

  function niceTicks(min, max, count = 5) {
    const span = (max - min) || 1;
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw) || 10 * mag;
    const out = [];
    for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) out.push(t);
    return out;
  }

  /* x축 눈금 — 구간 길이에 따라 표기를 바꾼다(3개월이면 월/일, 3년이면 연.월). */
  function xTicks(dates, n = 6) {
    const long = dates.length > 400;
    const idx = [];
    for (let k = 0; k < n; k++) idx.push(Math.round((dates.length - 1) * (k / (n - 1))));
    return [...new Set(idx)].map((i) => {
      const p = dates[i].split("-");
      return { i, text: long ? `${p[0].slice(2)}.${p[1]}` : `${p[1]}/${p[2]}` };
    });
  }

  function pathOf(pct, x, y) {
    let d = "", pen = false;
    pct.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  /* 선 끝 이름표가 겹치지 않게 위에서부터 밀어 내린다. */
  function spread(items, top, bottom) {
    items.sort((a, b) => a.y - b.y);
    let prev = -Infinity;
    items.forEach((it) => { it.y = Math.max(it.y, prev + LABEL_GAP); prev = it.y; });
    const over = items.length ? items[items.length - 1].y - bottom : 0;
    if (over > 0) items.forEach((it) => { it.y = Math.max(top, it.y - over); });
    return items;
  }

  function render(host, cfg) {
    const { dates, from, mode = "abs", baseId = "KOSPI", height = 380 } = cfg;
    const width = Math.max(320, host.clientWidth || 760);
    const view = dates.slice(from);
    const n = view.length;
    if (n < 2) { host.innerHTML = '<p class="chart-empty">표시할 구간이 없습니다.</p>'; return; }

    const base = cfg.series.find((s) => s.id === baseId);
    if (mode === "rel" && !base) {
      host.innerHTML = '<p class="chart-empty">기준 지수를 불러오지 못했습니다.</p>'; return;
    }

    let lines = cfg.series.map((s) => {
      const vals = mode === "rel" ? ratio(s.values, base.values) : s.values;
      const b = firstValue(vals, from);
      return {
        ...s, pct: b ? toPct(vals, from, b) : null,
        // 이동평균은 원래 선과 같은 기준값으로 환산해야 같은 눈금에 얹힌다.
        mapct: (b && s.ma) ? toPct(movingAvg(vals, s.ma), from, b) : null,
      };
    }).filter((s) => s.pct);

    if (mode === "rel") lines = lines.filter((s) => s.id !== baseId);  // 기준선은 0% 가로선으로

    const vals = lines.flatMap((s) => [...s.pct, ...(s.mapct || [])]).filter((v) => v !== null);
    if (!vals.length) { host.innerHTML = '<p class="chart-empty">표시할 계열이 없습니다.</p>'; return; }
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const pad = (hi - lo) * 0.08 || 1;
    lo -= pad; hi += pad;

    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    const x = (i) => PAD.left + (plotW * i) / (n - 1);
    const y = (v) => PAD.top + plotH * (1 - (v - lo) / (hi - lo));

    const grid = niceTicks(lo, hi).map((t) => `
      <line class="grid${Math.abs(t) < 1e-9 ? " zero" : ""}" x1="${PAD.left}" x2="${width - PAD.right}"
            y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>
      <text class="ytick" x="${PAD.left - 8}" y="${(y(t) + 4).toFixed(1)}">${fmtPct(t, 0)}</text>`).join("");

    const xt = xTicks(view, width < 520 ? 4 : 6).map((t) => `
      <text class="xtick" x="${x(t.i).toFixed(1)}" y="${height - 8}">${t.text}</text>`).join("");

    const baseline = mode === "rel" ? `
      <line class="baseline" x1="${PAD.left}" x2="${width - PAD.right}"
            y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>
      <text class="endlabel base" x="${width - PAD.right + 7}"
            y="${(y(0) + 4).toFixed(1)}">${esc(base.name)}</text>` : "";

    const maPaths = lines.filter((s) => s.mapct).map((s) => `
      <path class="line ma" style="stroke:${s.color}" d="${pathOf(s.mapct, x, y)}"/>`).join("");

    const paths = lines.map((s) => `
      <path class="line${s.kind === "market" ? " mkt" : ""}" style="stroke:${s.color}"
            ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} d="${pathOf(s.pct, x, y)}"/>`).join("");

    /* 전환 마커 — "여기서부터 시장을 이기기 시작했다"는 한 점.
       선 위에 겹치므로 배경색 링을 둘러 어느 선의 점인지 구분되게 한다. */
    const marks = (cfg.marks || []).map((mk) => {
      const s = lines.find((l) => l.id === mk.id);
      if (!s) return "";
      const i = view.indexOf(mk.date);
      if (i < 0 || s.pct[i] === null) return "";
      const cx = x(i).toFixed(1), cy = y(s.pct[i]).toFixed(1);
      return `<g class="mark"><circle cx="${cx}" cy="${cy}" r="6" style="stroke:${s.color}"/>
              <circle class="dot" cx="${cx}" cy="${cy}" r="2.5" style="fill:${s.color}"/></g>`;
    }).join("");

    /* 선 끝 이름표 — 라이트 모드에는 대비가 낮은 색(노랑·아쿠아·마젠타)이 섞여 있어
       색만으로 계열을 구분하게 두지 않는다. 이름표와 아래 표가 그 역할을 한다. */
    const ends = spread(lines.map((s) => {
      let li = -1;
      for (let i = s.pct.length - 1; i >= 0; i--) if (s.pct[i] !== null) { li = i; break; }
      return { name: s.name, y: y(s.pct[li]), color: s.color };
    }), PAD.top + 6, height - PAD.bottom);

    const endLabels = ends.map((e) => `
      <text class="endlabel" style="fill:${e.color}" x="${width - PAD.right + 7}"
            y="${e.y.toFixed(1)}">${esc(e.name)}</text>`).join("");

    host.innerHTML = `
      <svg class="chart" width="${width}" height="${height}" role="img"
           aria-label="기간 시작 대비 수익률 비교 차트">
        ${grid}${xt}${baseline}${maPaths}${paths}${marks}${endLabels}
        <g class="cross" hidden>
          <line class="crossline" y1="${PAD.top}" y2="${height - PAD.bottom}"/>
          <g class="dots"></g>
        </g>
        <rect class="hit" x="${PAD.left}" y="${PAD.top}" width="${plotW}" height="${plotH}"/>
      </svg>
      <div class="chart-tip" hidden></div>`;

    attachHover(host, { lines, view, x, y, width, plotW, mode });
  }

  /* 크로스헤어 + 툴팁. 모든 점에 값을 달 수는 없으니 값 읽기는 여기서 한다. */
  function attachHover(host, ctx) {
    const svg = host.querySelector("svg");
    const cross = host.querySelector(".cross");
    const cline = host.querySelector(".crossline");
    const dots = host.querySelector(".dots");
    const tip = host.querySelector(".chart-tip");
    const n = ctx.view.length;

    function move(ev) {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * ctx.width;
      let i = Math.round(((px - PAD.left) / ctx.plotW) * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));

      const cx = ctx.x(i);
      cross.hidden = false;
      cline.setAttribute("x1", cx);
      cline.setAttribute("x2", cx);

      const rows = ctx.lines
        .map((s) => ({ name: s.name, color: s.color, v: s.pct[i] }))
        .filter((r2) => r2.v !== null)
        .sort((a, b) => b.v - a.v);

      dots.innerHTML = rows.map((r2) =>
        `<circle r="4" cx="${cx.toFixed(1)}" cy="${ctx.y(r2.v).toFixed(1)}" style="fill:${r2.color}"/>`
      ).join("");

      tip.hidden = false;
      tip.innerHTML =
        `<div class="tip-date">${ctx.view[i]}${ctx.mode === "rel" ? " · 코스피 대비" : ""}</div>` +
        rows.map((r2) => `<div class="tip-row"><i style="background:${r2.color}"></i>
          <span class="tip-name">${esc(r2.name)}</span>
          <span class="tip-v ${r2.v > 0 ? "up" : r2.v < 0 ? "dn" : ""}">${fmtPct(r2.v, 2)}</span></div>`).join("");

      const w = tip.offsetWidth;
      const left = cx + 14 + w > ctx.width ? cx - w - 14 : cx + 14;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = "10px";
    }

    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", () => { cross.hidden = true; tip.hidden = true; });
  }

  return { render, pctFrom, fmtPct, PERIODS, fromIndex };
})();

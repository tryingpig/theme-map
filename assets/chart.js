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
  const LABEL_GAP = 15;          // 선 끝 이름표가 서로 겹치지 않게 두는 최소 간격(px). 글자 11.5px
  const FOCUS_HIT = 14;          // 이 거리(px) 안에 있는 선을 "가리키고 있는" 선으로 본다

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

  /* 선 끝 이름표가 겹치지 않게 자리를 잡는다. 원래 y(y0)는 유도선을 그리려고 남겨 둔다.
     아래로만 밀면 바닥을 넘치고, 넘친 만큼 전체를 위로 옮기면 이번엔 위가 잘린다.
     그래서 아래로 밀고 → 바닥에서 되밀고 → 위에서 다시 눌러 담는 3단이다. */
  function spread(items, top, bottom) {
    items.sort((a, b) => a.y - b.y);

    let prev = -Infinity;
    items.forEach((it) => { it.y = Math.max(it.y, prev + LABEL_GAP); prev = it.y; });

    let next = bottom;
    for (let i = items.length - 1; i >= 0; i--) {
      items[i].y = Math.min(items[i].y, next);
      next = items[i].y - LABEL_GAP;
    }

    prev = top;
    items.forEach((it) => { it.y = Math.max(it.y, prev); prev = it.y + LABEL_GAP; });
    return items;
  }

  function render(host, cfg) {
    const { dates, from, mode = "abs", baseId = "KOSPI", height = 380 } = cfg;
    const width = Math.max(320, host.clientWidth || 760);
    const view = dates.slice(from);
    const n = view.length;
    if (n < 2) { host.innerHTML = '<p class="chart-empty">표시할 구간이 없습니다.</p>'; return; }

    // 기준(코스피) 값은 화면에 켜져 있든 꺼져 있든 필요하다 — 상대강도를 만드는 분모다.
    const baseValues = cfg.baseValues
      || (cfg.series.find((s) => s.id === baseId) || {}).values;
    if (mode === "rel" && !baseValues) {
      host.innerHTML = '<p class="chart-empty">기준 지수를 불러오지 못했습니다.</p>'; return;
    }

    const lines = cfg.series.map((s) => {
      const vals = mode === "rel" ? ratio(s.values, baseValues) : s.values;
      const b = firstValue(vals, from);
      return {
        ...s, pct: b ? toPct(vals, from, b) : null,
        // 이동평균은 원래 선과 같은 기준값으로 환산해야 같은 눈금에 얹힌다.
        mapct: (b && s.ma) ? toPct(movingAvg(vals, s.ma), from, b) : null,
      };
    }).filter((s) => s.pct);

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

    /* data-id는 강조(한 계열만 남기고 나머지를 물리기)가 잡을 손잡이다. */
    const maPaths = lines.filter((s) => s.mapct).map((s) => `
      <path class="line ma" data-id="${esc(s.id)}" style="stroke:${s.color}"
            d="${pathOf(s.mapct, x, y)}"/>`).join("");

    const paths = lines.map((s) => `
      <path class="line${s.kind === "market" ? " mkt" : ""}" data-id="${esc(s.id)}" style="stroke:${s.color}"
            ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} d="${pathOf(s.pct, x, y)}"/>`).join("");

    /* 전환 마커 — "여기서부터 시장을 이기기 시작했다"는 한 점.
       선 위에 겹치므로 배경색 링을 둘러 어느 선의 점인지 구분되게 한다. */
    const marks = (cfg.marks || []).map((mk) => {
      const s = lines.find((l) => l.id === mk.id);
      if (!s) return "";
      const i = view.indexOf(mk.date);
      if (i < 0 || s.pct[i] === null) return "";
      const cx = x(i).toFixed(1), cy = y(s.pct[i]).toFixed(1);
      return `<g class="mark" data-id="${esc(s.id)}"><circle cx="${cx}" cy="${cy}" r="6" style="stroke:${s.color}"/>
              <circle class="dot" cx="${cx}" cy="${cy}" r="2.5" style="fill:${s.color}"/></g>`;
    }).join("");

    /* 선 끝 이름표 — 라이트 모드에는 대비가 낮은 색(노랑·아쿠아·마젠타)이 섞여 있어
       색만으로 계열을 구분하게 두지 않는다. 이름표와 아래 표가 그 역할을 한다. */
    const labelX = width - PAD.right + 9;
    const ends = spread(lines.map((s) => {
      let li = -1;
      for (let i = s.pct.length - 1; i >= 0; i--) if (s.pct[i] !== null) { li = i; break; }
      const y0 = y(s.pct[li]);
      return { id: s.id, name: s.name, y: y0, y0, x0: x(li), color: s.color };
    }), PAD.top + 6, height - PAD.bottom);

    /* 겹침을 피해 밀려난 이름표는 제 선에서 떨어진다. 어느 선의 이름인지 잃지 않게
       원래 끝점까지 가는 유도선을 깐다(2px 넘게 밀린 것만). */
    const leads = ends.filter((e) => Math.abs(e.y - e.y0) > 2).map((e) => `
      <path class="lead" data-id="${esc(e.id)}" style="stroke:${e.color}"
            d="M${e.x0.toFixed(1)} ${e.y0.toFixed(1)}H${(e.x0 + 5).toFixed(1)}L${(labelX - 3).toFixed(1)} ${e.y.toFixed(1)}"/>`).join("");

    const endLabels = ends.map((e) => `
      <text class="endlabel" data-id="${esc(e.id)}" style="fill:${e.color}" x="${labelX}"
            y="${e.y.toFixed(1)}">${esc(e.name)}</text>`).join("");

    host.innerHTML = `
      <svg class="chart" width="${width}" height="${height}" role="img"
           aria-label="기간 시작 대비 수익률 비교 차트">
        ${grid}${xt}${leads}${maPaths}${paths}${marks}${endLabels}
        <g class="cross" hidden>
          <line class="crossline" y1="${PAD.top}" y2="${height - PAD.bottom}"/>
          <g class="dots"></g>
        </g>
        <rect class="hit" x="${PAD.left}" y="${PAD.top}" width="${plotW}" height="${plotH}"/>
      </svg>
      <div class="chart-tip" hidden></div>`;
    host.classList.remove("on-focus");   // 다시 그리면 강조는 풀린다(고정도 함께)

    attachHover(host, { lines, view, x, y, width, plotW, mode });
  }

  /* 크로스헤어 + 툴팁 + 강조.

     선이 열 개쯤 되면 색만으로는 어느 게 어느 건지 못 읽는다. 그래서 가리키는 선 하나를
     남기고 나머지를 뒤로 물린다(지우지는 않는다 — 비교 대상이 사라지면 의미가 없다).
     선은 2px라 정확히 짚기 어려우니, 마우스가 있는 x에서 **세로로 가장 가까운 선**을
     가리키는 것으로 본다. 누르면 그 선에 고정되고, 다시 누르거나 빈 곳을 누르면 풀린다. */
  function attachHover(host, ctx) {
    const svg = host.querySelector("svg");
    const cross = host.querySelector(".cross");
    const cline = host.querySelector(".crossline");
    const dots = host.querySelector(".dots");
    const tip = host.querySelector(".chart-tip");
    const n = ctx.view.length;
    let pinned = null, hovered = null, painted = null;

    function paint() {
      const id = pinned || hovered;
      if (id === painted) return;
      painted = id;
      host.classList.toggle("on-focus", !!id);
      host.querySelectorAll("[data-id]").forEach((el) => {
        el.classList.toggle("on", el.dataset.id === id);
      });
    }

    /* 그 x 위치에서 포인터와 세로로 가장 가까운 선. 너무 멀면 아무것도 가리키지 않은 것. */
    function nearest(ev, i) {
      const r = svg.getBoundingClientRect();
      const k = ctx.width / (r.width || ctx.width);
      const py = (ev.clientY - r.top) * k;
      let best = null, bestD = FOCUS_HIT;
      ctx.lines.forEach((s) => {
        const v = s.pct[i];
        if (v === null || v === undefined) return;
        const d = Math.abs(ctx.y(v) - py);
        if (d < bestD) { bestD = d; best = s.id; }
      });
      return best;
    }

    function indexAt(ev) {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * ctx.width;
      const i = Math.round(((px - PAD.left) / ctx.plotW) * (n - 1));
      return Math.max(0, Math.min(n - 1, i));
    }

    function move(ev) {
      const i = indexAt(ev);
      hovered = nearest(ev, i);
      paint();

      const cx = ctx.x(i);
      cross.hidden = false;
      cline.setAttribute("x1", cx);
      cline.setAttribute("x2", cx);

      const rows = ctx.lines
        .map((s) => ({ id: s.id, name: s.name, color: s.color, v: s.pct[i] }))
        .filter((r2) => r2.v !== null)
        .sort((a, b) => b.v - a.v);

      dots.innerHTML = rows.map((r2) =>
        `<circle r="4" cx="${cx.toFixed(1)}" cy="${ctx.y(r2.v).toFixed(1)}" style="fill:${r2.color}"/>`
      ).join("");

      tip.hidden = false;
      tip.innerHTML =
        `<div class="tip-date">${ctx.view[i]}${ctx.mode === "rel" ? " · 코스피 대비" : ""}</div>` +
        rows.map((r2) => `<div class="tip-row" data-id="${esc(r2.id)}"><i style="background:${r2.color}"></i>
          <span class="tip-name">${esc(r2.name)}</span>
          <span class="tip-v ${r2.v > 0 ? "up" : r2.v < 0 ? "dn" : ""}">${fmtPct(r2.v, 2)}</span></div>`).join("");
      painted = undefined;    // 툴팁 줄이 새로 그려졌으니 강조를 다시 입힌다
      paint();

      const w = tip.offsetWidth;
      const left = cx + 14 + w > ctx.width ? cx - w - 14 : cx + 14;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = "10px";
    }

    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerdown", (ev) => {
      const id = nearest(ev, indexAt(ev));
      pinned = (id && pinned === id) ? null : id;   // 같은 선을 또 누르면 풀고, 빈 곳이면 해제
      move(ev);
    });
    svg.addEventListener("pointerleave", () => {
      cross.hidden = true; tip.hidden = true;
      hovered = null; paint();
    });

    // 범례·순위표에서도 같은 강조를 걸 수 있게 손잡이를 남긴다.
    FOCUS.set(host, (id) => { hovered = id; paint(); });
  }

  /* 차트 밖(범례 칩, 순위표 행)에서 계열 하나를 강조한다. id가 없으면 해제.
     고정(pin)된 게 있으면 그쪽이 우선이라 밖에서 건드려도 흔들리지 않는다. */
  const FOCUS = new WeakMap();
  function focus(host, id) {
    const fn = host && FOCUS.get(host);
    if (fn) fn(id || null);
  }

  /* ── 조망 격자(스몰 멀티플) ──────────────────────────────

     겹쳐 그리기의 반대편이다. 테마마다 제 칸을 주면 한 칸에 선이 둘뿐이라
     (기준선 + 그 테마) 겹칠 게 없고, 여덟 칸을 훑는 것만으로
     "누가 기준선 위에 있나"를 읽는다.

     **눈금은 모든 칸이 같이 쓴다.** 칸마다 축을 따로 주면 칸이 다 시원해 보이지만
     칸끼리 크기 비교가 거짓말이 된다(작은 하락이 큰 상승처럼 보인다).
     이상치가 있는 기간에는 나머지가 납작해지는데, 이 화면이 답하는 질문은
     "이겼나(위/아래)"라 진폭은 부차적이고 정확한 값은 칸마다 숫자로 적어 둔다. */
  const MINI = { h: 78, top: 7, bottom: 7, left: 4, right: 4 };

  function renderGrid(host, cfg) {
    const { dates, from, mode = "abs", height = MINI.h } = cfg;
    const view = dates.slice(from);
    if (view.length < 2) { host.innerHTML = '<p class="chart-empty">표시할 구간이 없습니다.</p>'; return null; }

    const base = cfg.baseValues;
    const cells = cfg.series.map((s) => {
      const vals = mode === "rel" ? ratio(s.values, base) : s.values;
      const b = firstValue(vals, from);
      if (!b) return null;
      const pct = toPct(vals, from, b);
      // 절대 수익률에서는 코스피를 회색 선으로 같이 깐다(그때는 0%선이 코스피가 아니다).
      const refB = mode === "abs" && base ? firstValue(base, from) : null;
      return { ...s, pct, ref: refB ? toPct(base, from, refB) : null };
    }).filter(Boolean);
    if (!cells.length) { host.innerHTML = '<p class="chart-empty">표시할 테마가 없습니다.</p>'; return null; }

    cells.forEach((c) => {
      for (let i = c.pct.length - 1; i >= 0; i--) if (c.pct[i] !== null) { c.last = c.pct[i]; break; }
    });
    cells.sort((a, b) => (b.last ?? -Infinity) - (a.last ?? -Infinity));   // 잘 나가는 게 왼쪽 위

    const all = cells.flatMap((c) => [...c.pct, ...(c.ref || [])]).filter((v) => v !== null);
    let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
    const pad = (hi - lo) * 0.12 || 1;
    lo -= pad; hi += pad;

    /* 칸 하나를 그린다. 폭은 칸이 실제로 차지한 픽셀을 쓴다 —
       viewBox로 늘이면 선 굵기가 가로로만 눌려 굵기가 제각각으로 보인다. */
    const cellSvg = (c, w) => {
      const n = c.pct.length;
      const x = (i) => MINI.left + ((w - MINI.left - MINI.right) * i) / (n - 1);
      const y = (v) => MINI.top + (height - MINI.top - MINI.bottom) * (1 - (v - lo) / (hi - lo));
      const zero = y(0).toFixed(1);

      const pts = c.pct.map((v, i) => (v === null ? null : [x(i), y(v)])).filter(Boolean);
      const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("");
      const area = pts.length
        ? `M${pts[0][0].toFixed(1)} ${zero}${line.slice(1)}L${pts[pts.length - 1][0].toFixed(1)} ${zero}Z`
        : "";
      const refLine = c.ref ? pathOf(c.ref, x, y) : "";

      return `<svg width="${w}" height="${height}" role="img"
                   aria-label="${esc(c.name)} ${fmtPct(c.last)}${mode === "rel" ? "p" : ""}">
        <line class="mini-zero" x1="${MINI.left}" x2="${(w - MINI.right).toFixed(1)}" y1="${zero}" y2="${zero}"/>
        ${refLine ? `<path class="mini-ref" d="${refLine}"/>` : ""}
        <path class="mini-area" style="fill:${c.color}" d="${area}"/>
        <path class="mini-line" style="stroke:${c.color}" d="${line}"/>
      </svg>`;
    };

    // 코스피 대비 값은 %가 아니라 %p다(수익률의 차이지 수익률이 아니다).
    const unit = mode === "rel" ? "p" : "";
    host.innerHTML = cells.map((c) => {
      const rs = c.rs;
      const badge = rs
        ? `<span class="${rs.state === "above" ? "win" : "lose"}">${rs.state === "above" ? "우위" : "열위"} D+${rs.days}</span>`
        : "";
      const sub = [badge, c.count ? `${c.count}종목` : ""].filter(Boolean).join(" · ");
      return `<a class="mini-cell" data-id="${esc(c.id)}" href="${cfg.href ? cfg.href(c) : "#"}">
        <span class="mini-head"><i style="background:${c.color}"></i>
          <span class="mini-name">${esc(c.name)}</span>
          <span class="mini-v ${c.last > 0 ? "up" : c.last < 0 ? "dn" : ""}">${fmtPct(c.last)}${unit}</span></span>
        <span class="mini-sub">${sub || "&nbsp;"}</span>
        <span class="mini-plot"></span>
      </a>`;
    }).join("");

    // 칸이 자리를 잡은 뒤에야 실제 폭을 알 수 있다 — 그 폭으로 그려야 선 굵기가 고르다.
    host.querySelectorAll(".mini-cell").forEach((el, k) => {
      const slot = el.querySelector(".mini-plot");
      const w = Math.max(80, Math.round(slot.clientWidth || 200));
      slot.innerHTML = cellSvg(cells[k], w);
    });

    return { lo: lo + pad, hi: hi - pad, count: cells.length };
  }

  return { render, renderGrid, pctFrom, fmtPct, PERIODS, fromIndex, focus };
})();

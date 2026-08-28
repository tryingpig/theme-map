/* 테마 맵 프론트.
   data/index.json(테마 목록) → data/themes/{테마}.json(그 테마의 계층·지표)만 읽는다.
   테마가 늘어도 이 파일은 그대로다 — 탭은 index.json에서 그려진다. */

const COLS = [
  { key: "r1d", label: "%1일", kind: "heat" },
  { key: "r5d", label: "%5일", kind: "heat" },
  { key: "r1m", label: "%1개월", kind: "heat" },
  { key: "r1y", label: "%1년", kind: "heat" },
  { key: "from_52w_high", label: "52주 고점대비", kind: "drop" },
  { key: "from_all_high", label: "사상 고점대비", kind: "drop" },
];

const $ = (id) => document.getElementById(id);
const state = { index: null, theme: null, data: null, sort: null, dir: -1, capOnly: false };

/* ── 값 표기 ───────────────────────────────────────────── */
const fmtPct = (v, d = 2) => (v === null || v === undefined ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(d)}`);
const fmtWon = (v) => (v === null || v === undefined ? "-" : Math.round(v).toLocaleString("ko-KR"));

/* 고점대비가 0에 붙어 있으면 그 기간의 신고가다. '0.0'은 결측처럼 읽히므로 말로 쓴다. */
const fmtDrop = (v) => {
  if (v === null || v === undefined) return "-";
  return v > -0.05 ? "신고가" : v.toFixed(1);
};

const fmtCap = (v) => (v ? `${Math.round(v / 1e8).toLocaleString("ko-KR")}억` : "-");

/* 시총 필터 — 켜면 기준 미만 종목이 표에서 빠지고, 역할 평균과 테마 수익률도 그 기준으로 다시 계산된다.
   시총을 모르는 종목(조회 실패)은 임의로 지우지 않고 남긴다. */
function passesCap(st) {
  if (!state.capOnly) return true;
  const cut = (state.data && state.data.cap_threshold) || 5000e8;
  return st.market_cap == null || st.market_cap >= cut;
}

/* 값이 있는 것만 평균 — 역할 그룹 소계를 필터 결과로 다시 낼 때 쓴다. */
function avgMetrics(rows) {
  const keys = ["r1d", "r5d", "r1m", "r1y", "from_52w_high", "from_all_high"];
  const out = { count: rows.length };
  keys.forEach((k) => {
    const vals = rows.map((r) => r[k]).filter((v) => v !== null && v !== undefined);
    out[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });
  return out;
}

/* ── 히트맵 색 단계 ─────────────────────────────────────
   컬럼마다 스케일이 따로다. 1일(±15%)과 1년(±400%)을 한 스케일로 칠하면
   1일 컬럼이 통째로 무채색이 된다. 이상치 한 종목(대우건설 +396%)이 나머지를
   납작하게 만들지 않도록 saturation point는 최댓값이 아니라 |값| 80퍼센타일을 쓴다. */
function columnScale(values) {
  const abs = values.filter((v) => v !== null && v !== undefined).map(Math.abs).sort((a, b) => a - b);
  if (!abs.length) return 1;
  const p80 = abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.8))];
  return Math.max(p80, 0.5);
}

function heatClass(v, scale) {
  if (v === null || v === undefined) return "";
  const r = Math.abs(v) / scale;
  if (r < 0.08) return "zero";
  const step = r < 0.3 ? 1 : r < 0.6 ? 2 : r < 1 ? 3 : 4;
  return `${v > 0 ? "up" : "dn"}${step}${step === 4 ? " s4" : ""}`;
}

/* ── 렌더 ──────────────────────────────────────────────── */
function renderTabs() {
  const nav = $("themeTabs");
  nav.innerHTML = "";
  state.index.themes.forEach((t) => {
    const b = document.createElement("button");
    b.className = "tab";
    b.type = "button";
    b.textContent = t.name;
    b.setAttribute("aria-current", String(t.id === state.theme));
    b.onclick = () => selectTheme(t.id);
    nav.appendChild(b);
  });
}

function renderHero() {
  const d = state.data;
  // 지수는 시계열이 있어야 만들 수 있어 프론트에서 못 만든다 — 빌드가 두 벌을 실어 보낸다.
  const ix = (state.capOnly && d.index_large) ? d.index_large : d.index;
  const stats = [
    ["%1일", ix.r1d], ["%5일", ix.r5d], ["%1개월", ix.r1m], ["%1년", ix.r1y],
    ["52주 고점대비", ix.from_52w_high],
  ];
  $("hero").innerHTML = `
    <div class="hero-head">
      <span class="hero-name">${d.theme.name}</span>
      <span class="hero-sub">구성종목 ${ix.count}개 · ${ix.basis}</span>
    </div>
    <div class="hero-stats">
      ${stats.map(([k, v]) => `
        <div class="stat">
          <div class="stat-k">${k}</div>
          <div class="stat-v ${v > 0 ? "up" : v < 0 ? "dn" : ""}">${k.includes("고점") ? fmtDrop(v) : fmtPct(v, 2)}</div>
        </div>`).join("")}
    </div>`;
}

function renderHead() {
  const tr = $("headRow");
  tr.innerHTML = "";
  const cells = [{ key: "name", label: "종목" }, { key: "close", label: "현재가" }, ...COLS];
  cells.forEach((c) => {
    const th = document.createElement("th");
    const arrow = state.sort === c.key ? `<span class="arrow">${state.dir < 0 ? "▼" : "▲"}</span>` : "";
    th.innerHTML = c.label + arrow;
    th.onclick = () => {
      if (state.sort === c.key) state.dir = -state.dir;
      else { state.sort = c.key; state.dir = c.key === "name" ? 1 : -1; }
      renderHead();
      renderBody();
    };
    tr.appendChild(th);
  });
}

function allStocks() {
  return state.data.groups.flatMap((g) => g.stocks).filter(passesCap);
}

function scales() {
  const rows = allStocks();
  const s = {};
  COLS.forEach((c) => { s[c.key] = columnScale(rows.map((r) => r[c.key])); });
  return s;
}

function stockRow(st, sc, showRole) {
  const tr = document.createElement("tr");
  tr.className = "stock";
  const flag = st.note ? ` <span class="flag" title="${st.note}">⚑</span>` : "";
  const chip = showRole ? ` <span class="role-chip">${st.role}</span>` : "";
  let html = `<td class="name"><span class="nm">${st.name}</span><span class="cd">${st.code}</span>${chip}${flag}</td>`;
  html += `<td class="num price">${fmtWon(st.close)}</td>`;
  COLS.forEach((c) => {
    const v = st[c.key];
    if (c.kind === "drop") {
      // 막대는 낙폭이 아니라 **고점 대비 현재 위치**를 채운다(길수록 고점 근처).
      // 컬럼 이름이 묻는 게 "지금 어디쯤인가"이므로 그 방향으로 읽혀야 한다.
      const pos = v === null || v === undefined ? 0 : Math.max(0, Math.min(100, 100 + v));
      html += `<td class="num drop"><span class="v">${fmtDrop(v)}</span>
               <span class="bar"><i style="width:${pos}%"></i></span></td>`;
    } else {
      html += `<td class="num heat ${heatClass(v, sc[c.key])}">${fmtPct(v)}</td>`;
    }
  });
  tr.innerHTML = html;
  attachTip(tr, st);
  return tr;
}

function groupRow(g, members) {
  const tr = document.createElement("tr");
  tr.className = "group";
  const summary = state.capOnly ? avgMetrics(members) : g.summary;
  const solo = summary.count === 1;   // 1종목 그룹의 '평균'은 바로 아랫줄과 같은 값이라 지운다
  let html = `<td>${g.role}<span class="gcount">${summary.count}종목${solo ? "" : " · 평균"}</span></td><td></td>`;
  COLS.forEach((c) => {
    const v = summary[c.key];
    html += `<td>${solo ? "" : (c.kind === "drop" ? fmtDrop(v) : fmtPct(v, 2))}</td>`;
  });
  tr.innerHTML = html;
  return tr;
}

function renderBody() {
  const tb = $("body");
  tb.innerHTML = "";
  const sc = scales();

  if (!state.sort) {
    state.data.groups.forEach((g) => {
      const members = g.stocks.filter(passesCap);
      if (!members.length) return;          // 필터에 다 걸린 그룹은 통째로 감춘다
      tb.appendChild(groupRow(g, members));
      members.forEach((st) => tb.appendChild(stockRow(st, sc, false)));
    });
    return;
  }

  const rows = allStocks().slice().sort((a, b) => {
    const k = state.sort;
    if (k === "name") return a.name.localeCompare(b.name, "ko") * state.dir;
    const av = a[k], bv = b[k];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return (av - bv) * state.dir;
  });
  rows.forEach((st) => tb.appendChild(stockRow(st, sc, true)));
}

function renderLegend() {
  // ⚑ 안내는 실제로 비고가 달린 종목이 있을 때만 — 비고는 노션에서 사람이 넣는 값이다.
  const hasNote = allStocks().some((s) => s.note);
  $("legend").innerHTML = `
    <span>등락률</span>
    <span class="ramp">
      <i style="background:var(--dn-4)"></i><i style="background:var(--dn-3)"></i>
      <i style="background:var(--dn-2)"></i><i style="background:var(--dn-1)"></i>
      <i style="background:var(--up-1)"></i><i style="background:var(--up-2)"></i>
      <i style="background:var(--up-3)"></i><i style="background:var(--up-4)"></i>
    </span>
    <span>하락 ← 0 → 상승 · 진하기는 컬럼별 상대 크기</span>
    <span>· 고점대비 막대는 <b>고점 대비 현재 위치</b>(길수록 고점 근처)</span>
    ${hasNote ? "<span>· ⚑ 는 비고가 달린 종목(마우스를 올리면 내용)</span>" : ""}`;
}

function renderErrors() {
  const box = $("errors");
  const errs = state.data.errors || [];
  if (!errs.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `수집 실패 ${errs.length}종목: ` +
    errs.map((e) => `${e.name}(${e.symbol})`).join(", ");
}

/* ── 툴팁 ──────────────────────────────────────────────── */
function attachTip(tr, st) {
  const tip = $("tip");
  tr.addEventListener("mouseenter", () => {
    tip.innerHTML = `<b>${st.name}</b> <span class="t-sub">${st.symbol}</span><br>
      <span class="t-sub">${st.desc || "-"}</span><br>
      <span class="t-sub">시총 ${fmtCap(st.market_cap)}</span><br>
      <span class="t-sub">52주 고점 ${fmtWon(st.high_52w)} (${st.high_52w_date || "-"})</span><br>
      <span class="t-sub">사상 고점 ${fmtWon(st.high_all)} (${st.high_all_date || "-"})</span>
      ${st.note ? `<br><span class="t-sub">⚑ ${st.note}</span>` : ""}`;
    tip.hidden = false;
  });
  tr.addEventListener("mousemove", (e) => {
    const pad = 14;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > innerHeight - 8) y = e.clientY - h - pad;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  });
  tr.addEventListener("mouseleave", () => { tip.hidden = true; });
}

/* ── 시장 대비 차트 ─────────────────────────────────────
   상세 화면에서도 "이 테마가 코스피를 이겼나"를 바로 볼 수 있어야 한다.
   테마 지수 시계열은 그 테마 JSON에, 코스피·코스닥은 data/series.json에 있다. */
const chartState = { period: "1y", mode: "abs", market: null };
const MARKET_STYLE = {
  KOSPI: { color: "var(--mkt-1)", dash: "", kind: "market" },
  KOSDAQ: { color: "var(--mkt-2)", dash: "5 4", kind: "market" },
};

async function marketSeries() {
  if (!chartState.market) {
    chartState.market = await fetch("data/series.json").then((r) => r.json());
  }
  return chartState.market;
}

/* 테마 시계열을 시장 날짜축에 맞춘다.
   퇴행방지로 갱신을 건너뛴 테마는 축이 하루 어긋나 있을 수 있어 **날짜로** 맞춘다. */
function onMarketAxis(themeSeries, values, dates) {
  const lut = new Map(themeSeries.dates.map((d, i) => [d, values[i]]));
  return dates.map((d) => (lut.has(d) ? lut.get(d) : null));
}

function themeColor() {
  const i = (state.index.themes || []).findIndex((t) => t.id === state.theme);
  return `var(--s${(Math.max(0, i) % 8) + 1})`;
}

function renderChartControls() {
  const seg = (on, data, label) =>
    `<button type="button" class="seg${on ? " on" : ""}" ${data}>${label}</button>`;
  $("periods").innerHTML = Chart.PERIODS
    .map((p) => seg(p.id === chartState.period, `data-p="${p.id}"`, p.label)).join("");
  $("periods").querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      chartState.period = b.dataset.p;
      try { localStorage.setItem("theme-map:main:period", chartState.period); } catch (e) { /* noop */ }
      renderChart();
    };
  });
  $("modes").innerHTML = [["abs", "절대 수익률"], ["rel", "코스피 대비"]]
    .map(([id, label]) => seg(id === chartState.mode, `data-m="${id}"`, label)).join("");
  $("modes").querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      chartState.mode = b.dataset.m;
      try { localStorage.setItem("theme-map:main:mode", chartState.mode); } catch (e) { /* noop */ }
      renderChart();
    };
  });
}

function renderChart() {
  const card = document.querySelector(".chart-card");
  const ser = state.data.series;
  const mkt = chartState.market;
  if (!ser || !mkt) { if (card) card.hidden = true; return; }
  card.hidden = false;

  // 시총 필터를 켜면 차트도 그 기준의 지수로 바꾼다 — 표와 다른 얘기를 하면 안 된다.
  const values = (state.capOnly && ser.index_large) ? ser.index_large : ser.index;
  const dates = mkt.dates;
  const line = {
    id: state.theme, name: state.data.theme.name, kind: "theme",
    color: themeColor(), values: onMarketAxis(ser, values, dates),
  };
  const markets = mkt.markets.map((m) => ({
    id: m.id, name: m.name, values: m.values, ...MARKET_STYLE[m.id],
  }));

  const from = Chart.fromIndex(dates, Chart.PERIODS.find((p) => p.id === chartState.period));

  renderChartControls();
  Chart.render($("chart"), {
    dates, from, mode: chartState.mode, baseId: "KOSPI",
    height: innerWidth < 640 ? 260 : 320,
    series: [...markets, line],
  });

  $("legend2").innerHTML = [line, ...markets].map((s) =>
    `<span class="chip on fixed"><i style="background:${s.color}${s.dash ? ";opacity:.75" : ""}"></i>${s.name}</span>`
  ).join("");
  $("chartNote").textContent = chartState.mode === "rel"
    ? `${dates[from]} 이후 코스피 대비 초과수익 · 0%선이 코스피`
    : `${dates[from]} 종가 = 0% 기준`;
}

/* ── 로딩 ──────────────────────────────────────────────── */
async function selectTheme(id) {
  state.theme = id;
  state.sort = null;
  try { localStorage.setItem("theme-map:last", id); } catch (e) { /* 사생활 보호 모드 */ }
  const url = new URL(location.href);
  url.searchParams.set("theme", id);
  history.replaceState(null, "", url);

  state.data = await fetch(`data/themes/${encodeURIComponent(id)}.json`).then((r) => r.json());
  $("asOf").textContent = state.data.as_of;
  $("updatedAt").textContent = state.data.updated_at;
  renderTabs();
  renderHero();
  renderHead();
  renderBody();
  renderLegend();
  renderCapNote();
  renderErrors();
  await marketSeries().catch(() => null);
  renderChart();
}

function renderCapNote() {
  const all = state.data.groups.flatMap((g) => g.stocks);
  const cut = state.data.cap_threshold || 5000e8;
  const under = all.filter((s) => s.market_cap != null && s.market_cap < cut);
  $("capNote").textContent = under.length
    ? (state.capOnly ? `${under.length}종목 제외됨` : `기준 미만 ${under.length}종목`)
    : "";
}

function initCapFilter() {
  const box = $("capOnly");
  try { state.capOnly = localStorage.getItem("theme-map:capOnly") === "1"; } catch (e) { /* noop */ }
  box.checked = state.capOnly;
  box.onchange = () => {
    state.capOnly = box.checked;
    try { localStorage.setItem("theme-map:capOnly", box.checked ? "1" : "0"); } catch (e) { /* noop */ }
    renderHero();
    renderBody();
    renderLegend();
    renderCapNote();
    renderChart();
  };
}

function initThemeToggle() {
  const root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem("theme-map:mode"); } catch (e) { /* noop */ }
  if (saved) root.setAttribute("data-theme", saved);
  $("themeToggle").onclick = () => {
    const now = root.getAttribute("data-theme");
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const next = now === "dark" ? "light" : now === "light" ? "dark" : dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("theme-map:mode", next); } catch (e) { /* noop */ }
  };
}

async function init() {
  initThemeToggle();
  initCapFilter();
  try {
    chartState.period = localStorage.getItem("theme-map:main:period") || chartState.period;
    chartState.mode = localStorage.getItem("theme-map:main:mode") || chartState.mode;
  } catch (e) { /* noop */ }
  if (!Chart.PERIODS.some((p) => p.id === chartState.period)) chartState.period = "1y";
  let rt = null;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(renderChart, 160); });
  state.index = await fetch("data/index.json").then((r) => r.json());
  if (state.index.universe_source !== "notion") {
    const b = $("sourceBadge");
    b.textContent = "유니버스 폴백";
    b.hidden = false;
  }
  let want = new URL(location.href).searchParams.get("theme");
  if (!want) { try { want = localStorage.getItem("theme-map:last"); } catch (e) { /* noop */ } }
  const ids = state.index.themes.map((t) => t.id);
  await selectTheme(ids.includes(want) ? want : ids[0]);
}

init().catch((e) => {
  document.getElementById("hero").innerHTML =
    `<div class="hero-head"><span class="hero-name">데이터를 불러오지 못했습니다</span></div>
     <p class="hero-sub">${e}</p>`;
});

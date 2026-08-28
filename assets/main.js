/* 메인 화면 — 코스피·코스닥 대비 테마 수익률.
   data/index.json(요약) + data/series.json(일별 시계열)만 읽는다.
   테마가 늘어도 이 파일은 그대로다. */

/* 계열 색은 **테마 순서로 고정**한다(index.json의 순서 = 노션 정렬순서).
   순위나 화면에 몇 개가 켜져 있느냐로 색이 바뀌면 어제 본 선과 오늘 본 선이 달라진다.
   8색은 dataviz 검증 팔레트(라이트/다크 모두 통과). 실제 색값은 style.css의 --s1~--s8. */
const SLOTS = 8;
const MARKET_STYLE = {
  KOSPI: { color: "var(--mkt-1)", dash: "", kind: "market" },
  KOSDAQ: { color: "var(--mkt-2)", dash: "5 4", kind: "market" },
};

const PERIODS = Chart.PERIODS;

const $ = (id) => document.getElementById(id);
const state = { index: null, series: null, period: "1y", mode: "abs", visible: null };

const fmtPct = (v, d = 2) => (v === null || v === undefined ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(d)}`);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 사생활 보호 모드 */ } },
};

/* 히트맵 색 단계 — 상세 화면(app.js)과 같은 규칙이다.
   컬럼마다 스케일이 따로다(1일 ±3%와 5년 ±700%을 한 스케일로 칠하면 1일이 무채색이 된다). */
function columnScale(values) {
  const abs = values.filter((v) => v !== null && v !== undefined).map(Math.abs).sort((a, b) => a - b);
  if (!abs.length) return 1;
  return Math.max(abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.8))], 0.5);
}

function heatClass(v, scale) {
  if (v === null || v === undefined) return "";
  const r = Math.abs(v) / scale;
  if (r < 0.08) return "zero";
  const step = r < 0.3 ? 1 : r < 0.6 ? 2 : r < 1 ? 3 : 4;
  return `${v > 0 ? "up" : "dn"}${step}${step === 4 ? " s4" : ""}`;
}

/* 화면에 올릴 계열 목록. 색은 테마 순서로 고정. */
function allSeries() {
  const s = state.series;
  const markets = s.markets.map((m) => ({
    id: m.id, name: m.name, values: m.values, ...MARKET_STYLE[m.id],
  }));
  const themes = s.themes.map((t, i) => ({
    id: t.id, name: t.name, values: t.values,
    color: `var(--s${(i % SLOTS) + 1})`, slot: i % SLOTS, kind: "theme",
  }));
  return { markets, themes };
}

function visibleSeries() {
  const { markets, themes } = allSeries();
  return [...markets, ...themes.filter((t) => state.visible.includes(t.id))];
}

/* ── 렌더 ──────────────────────────────────────────────── */
function renderControls() {
  $("periods").innerHTML = PERIODS.map((p) =>
    `<button type="button" class="seg${p.id === state.period ? " on" : ""}" data-p="${p.id}">${p.label}</button>`
  ).join("");
  $("periods").querySelectorAll("button").forEach((b) => {
    b.onclick = () => { state.period = b.dataset.p; store.set("theme-map:main:period", state.period); draw(); };
  });

  $("modes").innerHTML = [["abs", "절대 수익률"], ["rel", "코스피 대비"]].map(([id, label]) =>
    `<button type="button" class="seg${id === state.mode ? " on" : ""}" data-m="${id}">${label}</button>`
  ).join("");
  $("modes").querySelectorAll("button").forEach((b) => {
    b.onclick = () => { state.mode = b.dataset.m; store.set("theme-map:main:mode", state.mode); draw(); };
  });
}

function renderLegend() {
  const { markets, themes } = allSeries();
  const chip = (s, on, clickable) =>
    `<button type="button" class="chip${on ? " on" : ""}${clickable ? "" : " fixed"}"
             ${clickable ? `data-t="${s.id}"` : "disabled"}>
       <i style="background:${s.color}${s.dash ? ";opacity:.75" : ""}"></i>${s.name}</button>`;

  $("legend").innerHTML =
    markets.map((m) => chip(m, true, false)).join("") +
    themes.map((t) => chip(t, state.visible.includes(t.id), true)).join("");

  $("legend").querySelectorAll("button[data-t]").forEach((b) => {
    b.onclick = () => toggleTheme(b.dataset.t);
  });
}

/* 같은 색 슬롯을 쓰는 테마가 동시에 켜지지 않게 한다.
   테마가 9개를 넘어가면 색이 한 바퀴 돌기 때문에, 그때 같은 색 두 줄이 한 화면에
   올라오면 어느 선이 뭔지 알 수 없다. 새로 켜는 쪽을 살리고 같은 슬롯은 끈다. */
function toggleTheme(id) {
  const { themes } = allSeries();
  const t = themes.find((x) => x.id === id);
  if (state.visible.includes(id)) {
    state.visible = state.visible.filter((v) => v !== id);
  } else {
    const clash = themes.filter((x) => x.slot === t.slot && state.visible.includes(x.id)).map((x) => x.id);
    state.visible = [...state.visible.filter((v) => !clash.includes(v)), id];
  }
  store.set("theme-map:main:visible", JSON.stringify(state.visible));
  draw();
}

/* 시장을 이기기 시작한 시점. 판정은 빌드(scripts/build.py rs_signal)에서 한 번만 하고
   화면은 그 값을 보여 주기만 한다 — 알림과 화면이 다른 말을 하면 안 된다. */
function rsCell(r) {
  const rs = r.rs;
  if (!rs) return '<td class="num sub">-</td>';
  const up = rs.state === "above";
  const when = rs.cross_date ? rs.cross_date.slice(5).replace("-", "/") : "구간 내내";
  return `<td class="num rs ${up ? "up" : "dn"}">
    <span class="rs-d">${up ? "우위" : "열위"} D+${rs.days}</span>
    <span class="rs-sub">${when}부터 ${fmtPct(rs.excess_since)}%p</span></td>`;
}

function renderTable(rows) {
  const period = PERIODS.find((p) => p.id === state.period);
  const cols = [
    { key: "ret", label: `${period.label} 수익률` },
    { key: "excess", label: "코스피 대비" },
    { key: "r1d", label: "%1일" },
    { key: "r5d", label: "%5일" },
    { key: "r1m", label: "%1개월" },
    { key: "r1y", label: "%1년" },
  ];
  const sc = {};
  cols.forEach((c) => { sc[c.key] = columnScale(rows.map((r) => r[c.key])); });

  $("rankHead").innerHTML = `<th>이름</th>${cols.map((c) => `<th>${c.label}</th>`).join("")}`
    + `<th title="상대강도(테마÷코스피)가 20일 이동평균을 넘은 날부터">우위 전환</th><th>구성</th>`;
  $("rankBody").innerHTML = rows.map((r) => `
    <tr class="${r.kind === "market" ? "mkt" : "theme"}"${r.kind === "theme" ? ` data-t="${r.id}"` : ""}>
      <td class="name"><i class="dot" style="background:${r.color}"></i>${r.name}
        ${r.kind === "market" ? '<span class="tag">시장</span>' : '<span class="go">→</span>'}</td>
      ${cols.map((c) => (c.key === "excess" && r.kind === "market" && r.id === "KOSPI"
        ? '<td class="num muted">기준</td>'
        : `<td class="num heat ${heatClass(r[c.key], sc[c.key])}">${fmtPct(r[c.key])}</td>`)).join("")}
      ${r.kind === "market" ? '<td class="num sub">-</td>' : rsCell(r)}
      <td class="num sub">${r.count ? `${r.count}종목` : "-"}</td>
    </tr>`).join("");

  $("rankBody").querySelectorAll("tr[data-t]").forEach((tr) => {
    tr.onclick = () => { location.href = `theme.html?theme=${encodeURIComponent(tr.dataset.t)}`; };
  });
}

/* 표의 '기간 수익률'은 차트와 같은 시계열·같은 시작점에서 뽑는다.
   지표를 따로 계산하면 차트와 표가 서로 다른 말을 하게 된다. */
function buildRows(from) {
  const meta = {};
  (state.index.markets || []).forEach((m) => { meta[m.id] = m; });
  (state.index.themes || []).forEach((t) => { meta[t.id] = t; });

  const { markets, themes } = allSeries();
  const kospi = markets.find((m) => m.id === "KOSPI");
  const kospiPct = kospi ? Chart.pctFrom(kospi.values, from) : null;
  const kospiRet = kospiPct ? kospiPct[kospiPct.length - 1] : null;

  const rows = [...markets, ...themes.filter((t) => state.visible.includes(t.id))].map((s) => {
    const pct = Chart.pctFrom(s.values, from);
    const ret = pct ? pct[pct.length - 1] : null;
    const m = meta[s.id] || {};
    return {
      id: s.id, name: s.name, kind: s.kind, color: s.color,
      ret,
      excess: (ret === null || kospiRet === null) ? null
        : ((100 + ret) / (100 + kospiRet) - 1) * 100,
      r1d: m.r1d, r5d: m.r5d, r1m: m.r1m, r1y: m.r1y, count: m.count, rs: m.rs,
    };
  });
  rows.sort((a, b) => (b.ret ?? -Infinity) - (a.ret ?? -Infinity));
  return rows;
}

function draw() {
  const dates = state.series.dates;
  const from = Chart.fromIndex(dates, PERIODS.find((p) => p.id === state.period));

  renderControls();
  renderLegend();
  // 전환 마커 — 지금 코스피를 이기고 있는 테마가 "언제부터" 이겼는지를 선 위의 점으로 찍는다.
  const marks = (state.index.themes || [])
    .filter((t) => state.visible.includes(t.id) && t.rs
                   && t.rs.state === "above" && t.rs.cross_date)
    .map((t) => ({ id: t.id, date: t.rs.cross_date }));

  Chart.render($("chart"), {
    dates, from, mode: state.mode, baseId: "KOSPI",
    height: innerWidth < 640 ? 300 : 380,
    series: visibleSeries(), marks,
  });

  const rows = buildRows(from);
  renderTable(rows);
  $("chartNote").textContent = (state.mode === "rel"
    ? `${dates[from]} 이후 코스피 대비 초과수익 · 0%선이 코스피`
    : `${dates[from]} 종가 = 0% 기준`)
    + (marks.length ? " · ◉ 는 코스피를 이기기 시작한 날" : "");
}

function initThemeToggle() {
  const root = document.documentElement;
  const saved = store.get("theme-map:mode", null);
  if (saved) root.setAttribute("data-theme", saved);
  $("themeToggle").onclick = () => {
    const now = root.getAttribute("data-theme");
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const next = now === "dark" ? "light" : now === "light" ? "dark" : dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    store.set("theme-map:mode", next);
  };
}

async function init() {
  initThemeToggle();
  const [index, series] = await Promise.all([
    fetch("data/index.json").then((r) => r.json()),
    fetch("data/series.json").then((r) => r.json()),
  ]);
  state.index = index;
  state.series = series;

  state.period = store.get("theme-map:main:period", "1y");
  state.mode = store.get("theme-map:main:mode", "abs");
  if (!PERIODS.some((p) => p.id === state.period)) state.period = "1y";

  const ids = series.themes.map((t) => t.id);
  let saved = null;
  try { saved = JSON.parse(store.get("theme-map:main:visible", "null")); } catch (e) { /* noop */ }
  state.visible = Array.isArray(saved) ? saved.filter((v) => ids.includes(v)) : ids.slice(0, 6);
  if (!state.visible.length) state.visible = ids.slice(0, 6);

  $("asOf").textContent = series.as_of;
  $("updatedAt").textContent = index.updated_at;
  draw();

  let t = null;
  addEventListener("resize", () => { clearTimeout(t); t = setTimeout(draw, 160); });
}

init().catch((e) => {
  $("chart").innerHTML = `<p class="chart-empty">데이터를 불러오지 못했습니다 — ${e}</p>`;
});
